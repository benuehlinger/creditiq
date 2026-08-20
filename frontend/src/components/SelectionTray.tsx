import { useQuery } from '@tanstack/react-query'
import { api, type ScreenRow } from '../lib/api'
import { Card, CardHead, StatusPill } from '../components/ui'
import { useUi } from '../lib/store'
import type { PortfolioKey } from '../lib/api'

/**
 * The selection tray — persistent, always visible.
 *
 * Every candidate shows what it costs the CURRENT set, not what it looks like in
 * isolation: variance inflation against the variables already picked, its
 * information value, missingness, and whether its direction matches the
 * portfolio's economic prior. The point is that the analyst feels the
 * consequence of a pick BEFORE committing to it.
 */
export default function SelectionTray({ portfolio, rows }: {
  portfolio: string; rows: ScreenRow[]
}) {
  const { selectedVariables, toggleVariable, clearVariables } = useUi()
  const treatments = useUi((s) => s.treatments[portfolio as PortfolioKey] ?? {})
  const picked = selectedVariables[portfolio as PortfolioKey] ?? []
  const byName = new Map(rows.map((r) => [r.column, r]))

  const vif = useQuery({
    queryKey: ['vif', portfolio, picked.join(',')],
    queryFn: () => api.vif(portfolio, picked),
    enabled: picked.length >= 2,
  })
  const vifBy = new Map<string, number>((vif.data?.vif ?? []).map((v) => [v.column, v.vif] as const))

  const worstVif = Math.max(0, ...(vif.data?.vif ?? []).map((v) => v.vif))
  const anyLeak = picked.some((p) => byName.get(p)?.leakage_risk === 'likely')
  const anyFlip = picked.some((p) => byName.get(p)?.sign_ok === false)
  // A crude, honest preview: not a fitted model, just the sum of information
  // values discounted for redundancy. Labelled as an indicator, never as a score.
  const totalIv = picked.reduce((a, p) => a + Math.min(byName.get(p)?.iv ?? 0, 1.5), 0)
  const redundancy = worstVif > 1 ? 1 / Math.sqrt(worstVif) : 1
  const indicator = totalIv * redundancy

  return (
    <Card className="flex h-fit max-h-[calc(100vh-190px)] flex-col">
      <CardHead
        title="Selected variables"
        subtitle={`${picked.length} in the current specification`}
        caption="Variance inflation is against the current set, so adding a variable shows its cost immediately."
        right={picked.length > 0 && (
          <button onClick={() => clearVariables(portfolio as PortfolioKey)}
            className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">
            Clear
          </button>
        )}
      />

      <div className="border-b border-hairline px-4 py-3">
        <div className="text-micro text-ink-muted">Specification strength indicator</div>
        <div className="mt-0.5 text-2xl font-semibold tabular-nums text-accent">
          {indicator.toFixed(2)}
        </div>
        <p className="mt-1 text-micro leading-snug text-ink-muted">
          Summed information value, discounted for redundancy. An indicator of where the
          specification is heading — <span className="text-ink-secondary">not a fitted
          model score</span>. Fit on the Model surface for the real number.
        </p>
        {(anyLeak || anyFlip || worstVif > 5) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {anyLeak && <StatusPill severity="critical">leakage in set</StatusPill>}
            {anyFlip && <StatusPill severity="critical">sign flip in set</StatusPill>}
            {worstVif > 5 && (
              <StatusPill severity={worstVif > 10 ? 'critical' : 'warning'}>
                VIF {worstVif.toFixed(1)}
              </StatusPill>
            )}
          </div>
        )}
      </div>

      <ul className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {picked.length === 0 && (
          <li className="px-4 py-8 text-center text-xs leading-relaxed text-ink-muted">
            No variables selected yet.
            <br />
            Add from the ranking on the left.
          </li>
        )}
        {picked.map((p) => {
          const r = byName.get(p)
          const v = vifBy.get(p)
          return (
            <li key={p} className="border-b border-hairline/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-tiny text-ink">{p}</span>
                <button onClick={() => toggleVariable(portfolio as PortfolioKey, p)}
                  className="shrink-0 text-micro text-ink-muted hover:text-ink" title="Remove">×</button>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-muted">
                {(treatments[p] ?? 'woe') !== 'woe' && (
                  <span className="rounded border border-hairline px-1 text-accent">
                    {treatments[p]}
                  </span>
                )}
                <span>IV <span className="tnum text-ink-secondary">{r?.iv.toFixed(3) ?? '—'}</span></span>
                {v != null && (
                  <span>VIF <span className="tnum"
                    style={{ color: v > 10 ? 'var(--status-critical)' : v > 5 ? 'var(--status-warning)' : 'var(--ink-secondary)' }}>
                    {v.toFixed(2)}</span></span>
                )}
                {r && r.missing_pct > 0 && <span>{r.missing_pct.toFixed(0)}% miss</span>}
                {r?.sign_ok === false && <StatusPill severity="critical">sign</StatusPill>}
              </div>
            </li>
          )
        })}
      </ul>

      <AddPanel portfolio={portfolio} rows={rows} picked={picked} />
    </Card>
  )
}

function AddPanel({ portfolio, rows, picked }: {
  portfolio: string; rows: ScreenRow[]; picked: string[]
}) {
  const toggleVariable = useUi((s) => s.toggleVariable)
  const candidates = rows
    .filter((r) => !picked.includes(r.column) && r.leakage_risk !== 'likely'
      && r.above_null && !r.error)
    .slice(0, 8)
  return (
    <div className="border-t border-hairline px-3 py-2">
      <div className="text-micro uppercase tracking-wider text-ink-muted">Suggested next</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {candidates.map((r) => (
          <button key={r.column}
            onClick={() => toggleVariable(portfolio as PortfolioKey, r.column)}
            title={`IV ${r.iv.toFixed(3)} · ${r.iv_band}`}
            className="rounded border border-hairline px-1.5 py-0.5 font-mono text-micro text-ink-secondary hover:border-accent hover:text-ink">
            + {r.column}
          </button>
        ))}
        {candidates.length === 0 && (
          <span className="text-micro text-ink-muted">
            Nothing left above the null floor.
          </span>
        )}
      </div>
    </div>
  )
}
