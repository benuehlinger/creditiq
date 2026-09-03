import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type FitRequest, type FitResponse } from '../lib/api'
import type { PortfolioKey } from '../lib/api'
import { Card, EmptyState, ViewTabs, Notice } from '../components/ui'
import { Check, Close } from '../components/icons'
import Verdict, { LeakageNotice } from '../components/Verdict'
import FitProgress, { PD_PHASES } from '../components/FitProgress'
import SpecificationCard from '../components/SpecificationCard'
import FitDiagnostics from '../components/FitDiagnostics'
import BacktestPanel from '../components/BacktestPanel'
import { useUi } from '../lib/store'
import { canonical, columns, fromRequest, toRequest } from '../lib/spec'

/**
 * The fitted model: its verdict, its controls, and the specification,
 * diagnostics and backtest behind it.
 *
 * This was a separate Fit stage. It is now the right pane of the workbench when
 * no variable is open. The candidate list beside it belongs to the workbench,
 * so this pane no longer computes one.
 */
/** Which version each book last hydrated, for the whole session.
 *
 *  ONCE PER OPENED VERSION, not once per mount: the hydration effect's
 *  dependency is loaded.hash, but an effect always runs on its first render —
 *  so every visit to the PD stage with a version open re-ran it, and its
 *  setResult(null) DELETED the cached fit. The query then refetched; when the
 *  fit was in no cache, the auto-refit fired a full estimation. Felt as: "it
 *  refits every time I switch tabs". Module scope, not a ref, because a ref
 *  dies with the unmount that a tab switch IS. */
const HYDRATED: Partial<Record<PortfolioKey, string>> = {}

export default function ModelPane({ portfolio, onOpenVariable }: {
  portfolio: string
  /** Open a variable in the detail pane, from a coefficient row. */
  onOpenVariable?: (column: string) => void
}) {
  const pk = portfolio as PortfolioKey
  // One specification object. Every control on this surface reads and writes
  // the same thing, so a change made here and a change made on Explore are the
  // same kind of event rather than two mechanisms that have to agree.
  const spec = useUi((s) => s.pdSpec[pk])
  const editPd = useUi((s) => s.editPd)
  const picked = columns(spec)
  const setFitted = useUi((s) => s.setFitted)
  const setPdSpec = useUi((s) => s.setPdSpec)
  const fitted = useUi((s) => s.fitted[pk])
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const loaded = useUi((s) => s.loaded[pk])

  const estimator = spec.estimator
  const setEstimator = (v: string) =>
    editPd(pk, (x) => ({ ...x, estimator: v }), `estimator to ${v}`)
  // Macro terms now live in the store, so the Explore stage can offer them in
  // the same list as every other candidate. They are held in the canonical
  // `key@transform@lag` form, which covers a plain level term and a transformed
  // one without two code paths.
  const pdMevs = spec.mevs
  // `spec.downsample` still exists and still enters the request and the hash:
  // a saved version fitted on a thinned sample replays as itself. Only the
  // control is gone — every fit from the UI runs on the full panel.
  const ootFrom = spec.ootFrom
  const setOotFrom = (v: string) =>
    editPd(pk, (x) => ({ ...x, ootFrom: v }), 'the out-of-time boundary')
  // Keyed on the fitted hash, so it survives leaving the stage and coming back.
  // A change to the specification does not silently keep it on screen: the hash
  // only moves on a refit, and the stale banner above is driven by the
  // specification comparison rather than by this.
  const qc = useQueryClient()
  const cached = useQuery({
    queryKey: ['model', fitted?.hash],
    queryFn: () => api.model(fitted!.hash),
    enabled: !!fitted?.hash,
    staleTime: Infinity,
    retry: false,
  })
  const result = cached.data ?? null
  const setResult = (r: FitResponse | null) => {
    if (r) qc.setQueryData(['model', r.hash], r)
    else if (fitted?.hash) qc.removeQueries({ queryKey: ['model', fitted.hash] })
  }
  const [tab, setTab] = useState<'spec' | 'diagnostics' | 'backtest'>('spec')

  // Hydrate this surface's own controls from the specification being restored.
  // The estimator, out-of-time date and sampling are local state here, so
  // restoring only the store left them at their defaults: the replay then
  // fitted a different specification, produced a different hash and a different
  // name, and the surface reported a model that was not the one opened.
  useEffect(() => {
    const r = fitted?.request
    if (!loaded || !r) return
    if (HYDRATED[pk] === loaded.hash) return
    HYDRATED[pk] = loaded.hash
    // The whole specification, restored in one move — see `fromRequest`.
    setPdSpec(pk, fromRequest(r as unknown as Record<string, unknown>, portfolio))
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.hash])

  // A saved model has been opened: re-estimate from its specification so the
  // specification card, diagnostics and backtest are populated on arrival rather
  // than showing a page that asks to be fitted.
  useEffect(() => {
    // `cached.isFetching`: the lookup for an already-computed fit may still be
    // in flight — replaying then races it and POSTs a fit the cache was about
    // to answer. Wait; fit only once the lookup has come back empty.
    if (!loaded || result || fit.isPending || !picked.length || cached.isFetching) return
    // Wait until the macro terms match the specification being restored,
    // otherwise the first fit runs on the portfolio defaults.
    const want = (fitted?.request.mevs ?? [])
      .map((m: { key: string; transform?: string; lag_months?: number }) =>
        `${m.key}@${m.transform ?? 'level'}@${m.lag_months ?? 0}`).sort().join(',')
    const have = [...pdMevs].sort().join(',')
    if (want !== have) return
    fit.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.hash, picked.length, pdMevs.join(','), cached.isFetching])

  // The screening statistics, so the verdict can name a leakage-flagged
  // variable that made it into the specification.
  const screen = useQuery({ queryKey: ['screen', portfolio],
                            queryFn: () => api.screen(portfolio) })

  const request = toRequest(spec, portfolio, fittedLgd?.spec ?? null) as FitRequest

  // What the last refit actually did. A refit of an UNCHANGED specification
  // returns an identical fit — correctly — so the screen does not move and the
  // button reads as broken. Saying "identical" is the difference between a
  // no-op and a fault.
  const [outcome, setOutcome] = useState<string | null>(null)

  const fit = useMutation({
    mutationFn: () => api.fit(request),
    onSuccess: (r) => {
      const prev = result
      setOutcome(!prev ? `Fitted ${r.hash}.`
        : prev.hash === r.hash
          ? `Refitted ${r.hash}. The specification did not change, so the result is identical.`
          : `Refitted: ${prev.hash} → ${r.hash}. `
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

  // The model bar's call to action, clicked while the PD stage is on screen.
  // Read from the store rather than a window event: this pane is unmounted
  // whenever a variable detail or the collinearity view is open, and an event
  // fired then had no listener — the button did nothing. The flag waits until
  // the pane mounts, is consumed exactly once, and the fit runs.
  const cta = useUi((s) => s.cta)
  const setCta = useUi((s) => s.setCta)
  useEffect(() => {
    if (cta !== 'pd') return
    setCta(null)
    if (!fit.isPending) fit.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cta])

  // Keep the progress card for a moment after the response, so the bar is
  // seen to complete rather than vanishing at 92%.
  const [justFitted, setJustFitted] = useState(false)
  useEffect(() => {
    if (fit.isPending) { setJustFitted(true); return }
    if (!justFitted) return
    const t = setTimeout(() => setJustFitted(false), 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit.isPending])

  // A changed specification invalidates the last outcome — it describes a fit
  // that no longer matches what is on screen. Keyed on the request's CONTENT:
  // `request` is rebuilt every render, so depending on the object itself would
  // clear the message before it could be read.
  const requestKey = JSON.stringify(request)
  // What the progress machine compares against the fit, so a rebin or a
  // treatment change registers as a change rather than passing unnoticed.
  const specNow = canonical(spec)
  // Whether the fit on screen still describes the specification on screen.
  // Compared on the CANONICAL specification, not the column names: a rebin
  // or a treatment change leaves the names untouched and used to pass
  // unnoticed, so the stage reported itself current while showing a fit of
  // something else.
  // Read from the STORE, not from local state: `result` is lost on a page
  // reload, and the warning has to survive one — a stale fit is exactly the
  // thing someone comes back to the next morning and does not remember.
  const stale = !!fitted && canonical(fromRequest(fitted.request as unknown as Record<string, unknown>, portfolio)) !== specNow
  useEffect(() => { setOutcome(null) }, [requestKey])

  if (picked.length === 0) {
    return (
      <Card>
        <EmptyState title="No variables in the specification">
          Tick candidates in the list to add them. Click a candidate to see its
          binning and shape first.
        </EmptyState>
      </Card>
    )
  }

  return (
      <div className="min-w-0 space-y-3">
      <Card>
        <div className="flex flex-wrap items-end gap-4 px-4 py-3">

          <label className="text-tiny">
            <span className="text-ink-muted">Estimator</span>
            <select value={estimator} onChange={(e) => setEstimator(e.target.value)}
              className="ml-2 rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink">
              <option value="logistic">Logistic (champion)</option>
              <option value="logistic_l2">Logistic + L2</option>
              <option value="logistic_l1">Logistic + L1</option>
            </select>
          </label>

          <label className="text-tiny">
            <span className="text-ink-muted">Out of time from</span>
            <input type="month" value={ootFrom.slice(0, 7)}
              onChange={(e) => setOotFrom(`${e.target.value}-01`)}
              className="ml-2 rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink" />
          </label>

          {stale && (
            <span className="ml-auto flex items-center gap-1.5 text-tiny"
                  style={{ color: 'var(--status-warning)' }}
                  title="The specification on screen is not the one this model was estimated on. A variable, a treatment, a binning, the estimator or a macro term has changed. Everything below describes the previous specification.">
              <span>!</span>
              <span>the specification changed. This fit is out of date</span>
            </span>
          )}
          <button
            onClick={() => fit.mutate()}
            disabled={fit.isPending}
            className={`rounded-ctl px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${
              stale ? '' : 'ml-auto'}`}
            style={{ background: stale ? 'var(--status-warning)' : 'var(--accent)' }}
            title={result && !stale
              ? 'Re-estimate on the same specification. The result will be identical, because nothing has changed since it was fitted.'
              : 'Estimate the PD model on the specification above.'}>
            {fit.isPending ? 'Fitting…' : result ? 'Refit' : 'Fit model'}
          </button>
        </div>

        {outcome && !fit.isPending && !stale && (
          <div className="flex items-center gap-2 border-t border-hairline px-4 py-1.5 text-micro text-ink-secondary">
            <span style={{ color: 'var(--status-good)' }}><Check /></span>
            <span>{outcome}</span>
            <button onClick={() => setOutcome(null)}
              className="ml-auto text-ink-muted hover:text-ink" title="Dismiss"><Close /></button>
          </div>
        )}

      </Card>

      {(fit.isPending || justFitted) && (
        <FitProgress done={!fit.isPending}
          phases={PD_PHASES(result?.n_full, result?.timings)} />
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
          <LeakageNotice r={result} screen={screen.data?.rows} />
          {result.separation_warning && (
            <Notice severity="critical" label="Check the specification">
              {result.separation_warning}
            </Notice>
          )}

          <ViewTabs value={tab} onChange={setTab} tabs={[
            { key: 'spec', label: 'Specification' },
            { key: 'diagnostics', label: 'Fit diagnostics' },
            { key: 'backtest', label: 'Backtesting' },
          ]} />

          {tab === 'spec' && <SpecificationCard r={result} onOpenVariable={onOpenVariable} />}
          {tab === 'diagnostics' && <FitDiagnostics r={result} />}
          {tab === 'backtest' && (
            <>
              <Verdict r={result} screen={screen.data?.rows} />
              <BacktestPanel r={result} portfolio={portfolio} request={fitted?.request} />
            </>
          )}
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
