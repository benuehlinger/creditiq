import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type FitResponse } from '../lib/api'
import type { PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, StatTile, StatusPill } from '../components/ui'
import SpecificationCard from '../components/SpecificationCard'
import FitDiagnostics from '../components/FitDiagnostics'
import BacktestPanel from '../components/BacktestPanel'
import { useUi } from '../lib/store'
import { ratio } from '../lib/format'

const DEFAULT_MEVS: Record<string, string[]> = {
  consumer: ['unemployment_rate', 'real_disp_income_growth'],
  mortgage: ['unemployment_rate'],
  cre: ['cre_price_index_yoy', 'bbb_yield'],
}

export default function ModelSurface() {
  const { portfolio = 'consumer' } = useParams()
  const picked = useUi((s) => s.selectedVariables[portfolio as PortfolioKey] ?? [])
  const [estimator, setEstimator] = useState('logistic')
  const [mevs, setMevs] = useState<string[]>(DEFAULT_MEVS[portfolio] ?? [])
  const [downsample, setDownsample] = useState<number | null>(null)
  const [ootFrom, setOotFrom] = useState('2023-01-01')
  const [result, setResult] = useState<FitResponse | null>(null)
  const [tab, setTab] = useState<'spec' | 'diagnostics' | 'backtest'>('spec')

  useEffect(() => { setMevs(DEFAULT_MEVS[portfolio] ?? []); setResult(null) }, [portfolio])

  const catalog = useQuery({ queryKey: ['mevcat'], queryFn: api.mevCatalog })
  const allowed = catalog.data?.by_portfolio?.[portfolio] ?? []

  const fit = useMutation({
    mutationFn: () => api.fit({
      portfolio,
      variables: picked.map((c) => ({ column: c })),
      mevs: mevs.map((k) => ({ key: k })),
      estimator, seasoning_spline: true, oot_from: ootFrom,
      downsample_rows: downsample,
    }),
    onSuccess: (r) => { setResult(r); setTab('spec') },
  })

  if (picked.length === 0) {
    return (
      <div className="p-4">
        <Card>
          <CardHead title="Model" subtitle={portfolio} />
          <EmptyState title="No variables selected">
            A model needs a specification. Go to Explore, screen the candidates and
            add variables to the tray — then come back and fit.
          </EmptyState>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-3 p-4">
      <Card>
        <div className="flex flex-wrap items-end gap-4 px-4 py-3">
          <div>
            <div className="text-micro uppercase tracking-wider text-ink-muted">Specification</div>
            <div className="mt-1 text-sm text-ink">
              {picked.length} variable{picked.length === 1 ? '' : 's'} · {mevs.length} macro term{mevs.length === 1 ? '' : 's'}
            </div>
          </div>

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

          <label className="flex items-center gap-1.5 text-tiny text-ink-muted"
            title="Thins the FIT sample only. Every default is kept, non-events are thinned and the intercept is prior-corrected. Scoring, diagnostics and backtesting always use every row.">
            <input type="checkbox" checked={downsample != null}
              onChange={(e) => setDownsample(e.target.checked ? 500_000 : null)} />
            Fast fit (thin the fit sample) ⓘ
          </label>

          <button
            onClick={() => fit.mutate()}
            disabled={fit.isPending}
            className="ml-auto rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60">
            {fit.isPending ? 'Fitting…' : result ? 'Refit' : 'Fit model'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-2">
          <span className="text-micro uppercase tracking-wider text-ink-muted">Macro terms</span>
          {allowed.map((k) => {
            const on = mevs.includes(k)
            return (
              <button key={k}
                onClick={() => setMevs((v) => on ? v.filter((x) => x !== k) : [...v, k])}
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
          {tab === 'backtest' && <BacktestPanel r={result} portfolio={portfolio} />}
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
