import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type FitResponse } from '../lib/api'
import type { PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, StatTile, StatusPill } from '../components/ui'
import SpecificationCard from '../components/SpecificationCard'
import FitDiagnostics from '../components/FitDiagnostics'
import BacktestPanel from '../components/BacktestPanel'
import { useUi, NONE, NO_MAP } from '../lib/store'
import { ratio } from '../lib/format'

const DEFAULT_MEVS: Record<string, string[]> = {
  consumer: ['unemployment_rate', 'real_disp_income_growth'],
  mortgage: ['unemployment_rate'],
  cre: ['cre_price_index_yoy', 'bbb_yield'],
}

export default function ModelSurface() {
  const { portfolio = 'consumer' } = useParams()
  const pk = portfolio as PortfolioKey
  const picked = useUi((s) => s.selectedVariables[pk] ?? NONE) as string[]
  const setFitted = useUi((s) => s.setFitted)
  const fitted = useUi((s) => s.fitted[pk])
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const loaded = useUi((s) => s.loaded[pk])
  const forkFromLoaded = useUi((s) => s.forkFromLoaded)
  const treatments = useUi((s) => s.treatments[pk] ?? NO_MAP)
  const knots = useUi((s) => s.knots[pk] ?? NO_MAP)
  const macroShortlist = useUi((s) => s.macroShortlist[pk]?.pd ?? NONE) as string[]
  const [fork, setFork] = useState<null | (() => void)>(null)

  /** Any edit while a saved model is on screen forks it. A saved version is
   *  immutable — that is what makes it worth referring to — so the change lands
   *  on a new Model ID with the loaded one as its parent. */
  const guard = (change: () => void) => { loaded ? setFork(() => change) : change() }
  const [estimator, setEstimator] = useState('logistic')
  const [mevs, setMevs] = useState<string[]>(DEFAULT_MEVS[portfolio] ?? [])
  const [pickedShortlist, setPickedShortlist] = useState<string[]>([])
  const [downsample, setDownsample] = useState<number | null>(null)
  const [ootFrom, setOotFrom] = useState('2023-01-01')
  const [result, setResult] = useState<FitResponse | null>(null)
  const [tab, setTab] = useState<'spec' | 'diagnostics' | 'backtest'>('spec')

  useEffect(() => { setMevs(DEFAULT_MEVS[portfolio] ?? []); setResult(null) }, [portfolio])

  // Hydrate this surface's own controls from the specification being restored.
  // The macro terms, estimator, out-of-time date and sampling are local state
  // here, so restoring only the store left them at their portfolio defaults: the
  // replay then fitted a different specification, produced a different hash and
  // a different name, and the surface reported a model that was not the one
  // opened. The macro terms in particular default to two on this book.
  useEffect(() => {
    const r = fitted?.request
    if (!loaded || !r) return
    const all = (r.mevs ?? []) as { key: string; transform?: string; lag_months?: number }[]
    setMevs(all.filter((m) => !m.transform || m.transform === 'level')
               .filter((m) => !m.lag_months).map((m) => m.key))
    setPickedShortlist(all.filter((m) => (m.transform && m.transform !== 'level') || m.lag_months)
                          .map((m) => `${m.key}@${m.transform ?? 'level'}@${m.lag_months ?? 0}`))
    if (r.estimator) setEstimator(r.estimator)
    if (r.oot_from) setOotFrom(r.oot_from)
    setDownsample(r.downsample_rows ?? null)
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.hash])

  // A saved model has been opened: re-estimate from its specification so the
  // specification card, diagnostics and backtest are populated on arrival rather
  // than showing a page that asks to be fitted.
  useEffect(() => {
    if (!loaded || result || fit.isPending || !picked.length) return
    // Wait until the macro terms match the specification being restored,
    // otherwise the first fit runs on the portfolio defaults.
    const want = (fitted?.request.mevs ?? [])
      .map((m: { key: string; transform?: string; lag_months?: number }) =>
        `${m.key}@${m.transform ?? 'level'}@${m.lag_months ?? 0}`).sort().join(',')
    const have = [...mevs.map((k) => `${k}@level@0`), ...pickedShortlist].sort().join(',')
    if (want !== have) return
    fit.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.hash, picked.length, mevs.join(','), pickedShortlist.join(',')])

  const catalog = useQuery({ queryKey: ['mevcat'], queryFn: api.mevCatalog })
  const macroLib = useQuery({ queryKey: ['macrolib', portfolio],
                              queryFn: () => api.macroLibrary(portfolio) })
  /** Level terms offered by the catalogue, plus anything shortlisted on Macro.
   *  A shortlisted term carries its transform and lag, so it is a different
   *  quantity from the same variable in levels and is listed separately. */
  const shortlistTerms = useMemo(() => macroShortlist.map((col) => {
    const c = macroLib.data?.rows.find((r) => r.column === col)
    const [key, transform, lag] = col.split('@')
    return { col, key, transform, lag: Number(lag),
             label: c ? `${c.key} ${c.transform_label}${c.lag_months ? ` ·${c.lag_months}m` : ''}`
                      : col }
  }), [macroShortlist, macroLib.data])
  const allowed = catalog.data?.by_portfolio?.[portfolio] ?? []

  // ONE request object, used to fit and then stored verbatim. Save and project
  // replay it, so a saved version is provably the model that was fitted.
  const request = {
    portfolio,
    // Each variable carries how it enters the model. Sending only the column
    // name would silently fall back to WoE for everything, which is what the
    // engine defaults to — and would quietly discard the analyst's choice.
    variables: picked.map((c) => ({ column: c, treatment: treatments[c] ?? 'woe',
                                    knots: knots[c] ?? null })),
    // A level term is `{key}`. A shortlisted term carries its transform and lag,
    // which the fit, the scenario projection and the LGD model all build through
    // the same function.
    mevs: [
      ...mevs.map((k) => ({ key: k })),
      ...pickedShortlist.map((col) => {
        const [key, transform, lag] = col.split('@')
        return { key, transform, lag_months: Number(lag) }
      }),
    ],
    estimator, seasoning_spline: true, oot_from: ootFrom,
    downsample_rows: downsample,
    // The severity half rides along so the Model ID covers both. Without it the
    // hash describes the hazard model only, and two models with the same name
    // could carry LGD specifications twenty points apart in a downturn.
    lgd: fittedLgd?.spec ?? null,
  }

  // What the last refit actually did. A refit of an UNCHANGED specification
  // returns an identical fit — correctly — so the screen does not move and the
  // button reads as broken. Saying "identical" is the difference between a
  // no-op and a fault.
  const [outcome, setOutcome] = useState<string | null>(null)

  const fit = useMutation({
    mutationFn: () => api.fit(request),
    onSuccess: (r) => {
      const prev = result
      setOutcome(!prev ? `Fitted ${r.name}.`
        : prev.hash === r.hash
          ? `Refitted ${r.name}. The specification did not change, so the result is identical.`
          : `Refitted: ${prev.name} → ${r.name}. `
            + `AUC (test) ${prev.diagnostics.test?.auc?.toFixed(3) ?? '—'}`
            + ` → ${r.diagnostics.test?.auc?.toFixed(3) ?? '—'}.`)
      setResult(r)
      setTab('spec')
      setFitted(pk, {
        request, hash: r.hash, name: r.name,
        fittedAt: new Date().toISOString(), variablesAtFit: picked,
      })
    },
  })

  // A changed specification invalidates the last outcome — it describes a fit
  // that no longer matches what is on screen. Keyed on the request's CONTENT:
  // `request` is rebuilt every render, so depending on the object itself would
  // clear the message before it could be read.
  const requestKey = JSON.stringify(request)
  useEffect(() => { setOutcome(null) }, [requestKey])

  if (picked.length === 0) {
    return (
      <div className="p-4">
        <Card>
          <CardHead title="PD model — Fit" subtitle={portfolio} />
          <EmptyState title="No variables selected">
No variables are in the specification. Select candidates on the PD model
            Explore stage, then return here to fit.
          </EmptyState>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-3 p-4">
      {fork && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
             onClick={() => setFork(null)}>
          <div className="max-w-md rounded-card border border-hairline bg-raised p-5"
               onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-ink">This creates a new Model ID</h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
              <span className="font-medium text-ink">{loaded?.name}</span> is saved, and
              a saved model does not change. Editing it forks: a new specification, a
              new hash, a new name, and {loaded?.name} recorded as its parent. The
              original stays exactly as it was.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setFork(null)}
                className="rounded-ctl border border-hairline px-3 py-1.5 text-xs text-ink-secondary">
                Keep viewing {loaded?.name}
              </button>
              <button onClick={() => { forkFromLoaded(pk); fork(); setFork(null) }}
                className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
                Fork to a new model
              </button>
            </div>
          </div>
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-end gap-4 px-4 py-3">
          <div>
            <div className="text-micro uppercase tracking-wider text-ink-muted">
              PD model — Fit
            </div>
            <div className="mt-1 text-sm text-ink">
              {picked.length} variable{picked.length === 1 ? '' : 's'} · {mevs.length} macro term{mevs.length === 1 ? '' : 's'}
            </div>
            {Object.keys(treatments).some((c) => picked.includes(c)
              && treatments[c] !== 'woe') && (
              <div className="mt-0.5 text-micro text-ink-muted">
                {picked.filter((c) => (treatments[c] ?? 'woe') !== 'woe')
                  .map((c) => `${c} as ${treatments[c]}`).join(' · ')}
              </div>
            )}
          </div>

          <label className="text-tiny">
            <span className="text-ink-muted">Estimator</span>
            <select value={estimator} onChange={(e) => guard(() => setEstimator(e.target.value))}
              className="ml-2 rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink">
              <option value="logistic">Logistic (champion)</option>
              <option value="logistic_l2">Logistic + L2</option>
              <option value="logistic_l1">Logistic + L1</option>
            </select>
          </label>

          <label className="text-tiny">
            <span className="text-ink-muted">Out of time from</span>
            <input type="month" value={ootFrom.slice(0, 7)}
              onChange={(e) => guard(() => setOotFrom(`${e.target.value}-01`))}
              className="ml-2 rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink" />
          </label>

          <label className="flex items-center gap-1.5 text-tiny text-ink-muted"
            title="Thins the estimation sample only. Every default is retained, non-events are thinned, and the intercept is corrected for the resulting prior. Scoring, diagnostics and backtesting use the full panel.">
            <input type="checkbox" checked={downsample != null}
              onChange={(e) => guard(() => setDownsample(e.target.checked ? 500_000 : null))} />
            Fast fit (thin the fit sample) ⓘ
          </label>

          <button
            onClick={() => fit.mutate()}
            disabled={fit.isPending}
            className="ml-auto rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60">
            {fit.isPending ? 'Fitting…' : result ? 'Refit' : 'Fit model'}
          </button>
        </div>

        {outcome && !fit.isPending && (
          <div className="flex items-center gap-2 border-t border-hairline px-4 py-1.5 text-micro text-ink-secondary">
            <span style={{ color: 'var(--status-good)' }}>✓</span>
            <span>{outcome}</span>
            <button onClick={() => setOutcome(null)}
              className="ml-auto text-ink-muted hover:text-ink" title="Dismiss">×</button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-2">
          <span className="text-micro uppercase tracking-wider text-ink-muted">Macro terms</span>
          {allowed.map((k) => {
            const on = mevs.includes(k)
            return (
              <button key={k}
                onClick={() => guard(() => setMevs((v) => on ? v.filter((x) => x !== k) : [...v, k]))}
                className={`rounded border px-1.5 py-0.5 font-mono text-micro ${
                  on ? 'border-accent text-accent' : 'border-hairline text-ink-muted hover:text-ink'}`}>
                {on ? '−' : '+'} {k}
              </button>
            )
          })}
          <span className="ml-auto max-w-md text-micro leading-snug text-ink-muted">
            Only CCAR supervisory variables are offered — they are the only ones with
            published forward paths, so they are the only ones a scenario can project.
          </span>
        </div>

        {/* Terms promoted from the transformation search. A transformed term is a
            different quantity from the same variable in levels, so it is listed
            separately rather than folded into the row above. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-2">
          <span className="text-micro uppercase tracking-wider text-ink-muted">
            From the macro search
          </span>
          {shortlistTerms.length === 0 ? (
            <span className="text-micro text-ink-muted">
              Nothing shortlisted. Build transformed and lagged candidates on the Macro
              surface, then select them here.
            </span>
          ) : shortlistTerms.map((t) => {
            const on = pickedShortlist.includes(t.col)
            return (
              <button key={t.col}
                onClick={() => guard(() => setPickedShortlist(
                  (v) => on ? v.filter((x) => x !== t.col) : [...v, t.col]))}
                className={`rounded border px-1.5 py-0.5 font-mono text-micro ${
                  on ? 'border-accent text-accent' : 'border-hairline text-ink-muted hover:text-ink'}`}
                title={`${t.key}, ${t.transform}${t.lag ? `, lagged ${t.lag} months` : ''}`}>
                {on ? '−' : '+'} {t.label}
              </button>
            )
          })}
        </div>
      </Card>

      {fit.isPending && (
        <Card>
          <div className="px-4 py-3">
            <div className="flex items-center justify-between text-xs text-ink-secondary">
              <span>Fitting on the full panel and backtesting every performance date…</span>
              <span className="text-ink-muted">about 3 seconds</span>
            </div>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-sunken">
              <div className="h-1 w-1/3 animate-[shimmer_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
            </div>
          </div>
        </Card>
      )}

      {fit.isError && (
        <Card>
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--status-critical)' }}>
            {String(fit.error)}
          </div>
        </Card>
      )}

      {result && (
        <>
          <Card>
            <div className="grid grid-cols-2 divide-x divide-hairline md:grid-cols-6">
              <StatTile label="Version" value={result.name}
                explain={`Immutable identity ${result.hash}. The name is derived from the configuration hash, so an identical specification always produces an identical name.`} />
              <StatTile label="AUC (test)" value={ratio(result.diagnostics.test?.auc)} accent
                explain="Area under the ROC curve on the held-out account split, in time." />
              <StatTile label="AUC (out of time)" value={ratio(result.diagnostics.oot?.auc)}
                explain={`Months from ${result.backtest.oot_from} onward — a period the model never saw.`} />
              <StatTile label="KS (test)" value={ratio(result.diagnostics.test?.ks)}
                explain="Maximum separation between the cumulative good and bad distributions." />
              <StatTile label="Gini (test)" value={ratio(result.diagnostics.test?.gini)}
                explain="2 x AUC − 1." />
              <StatTile label="McFadden R²" value={ratio(result.diagnostics.mcfadden_r2)}
                explain="1 − (model log-likelihood / null log-likelihood). Values of 0.1 to 0.3 indicate a good fit for this family of model — it is not comparable to an OLS R²." />
            </div>
            <div className="border-t border-hairline px-4 py-2 text-micro text-ink-muted">
              {result.performance_note}
            </div>
          </Card>

          {result.separation_warning && (
            <div className="rounded-card border px-4 py-3 text-xs text-ink"
                 style={{ borderColor: 'var(--status-critical)',
                          background: 'color-mix(in srgb, var(--status-critical) 10%, transparent)' }}>
              <StatusPill severity="critical">Check the specification</StatusPill>
              <span className="ml-2">{result.separation_warning}</span>
            </div>
          )}

          <div className="flex items-center gap-1">
            {(['spec', 'diagnostics', 'backtest'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`rounded-ctl px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  tab === t ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:text-ink-secondary'}`}>
                {t === 'spec' ? 'Specification' : t === 'diagnostics' ? 'Fit diagnostics' : 'Backtesting'}
              </button>
            ))}
          </div>

          {tab === 'spec' && <SpecificationCard r={result} />}
          {tab === 'diagnostics' && <FitDiagnostics r={result} />}
          {tab === 'backtest' && <BacktestPanel r={result} portfolio={portfolio}
                                       request={fitted?.request} />}
        </>
      )}

      {!result && !fit.isPending && (
        <Card>
          <EmptyState title="Not fitted yet"
            action={<button onClick={() => fit.mutate()}
              className="mt-2 rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white">
              Fit model
            </button>}>
            {picked.length} variables are selected. Fitting runs a discrete-time hazard
            on every account-month and backtests every performance date.
          </EmptyState>
        </Card>
      )}
    </div>
  )
}
