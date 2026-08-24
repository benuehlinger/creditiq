import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type ScreenRow } from '../lib/api'
import { Card, CardHead, StatusPill } from '../components/ui'
import { useUi, NO_MAP } from '../lib/store'
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
  const treatments = useUi((s) => s.treatments[portfolio as PortfolioKey] ?? NO_MAP)
  const picked = selectedVariables[portfolio as PortfolioKey] ?? []
  const byName = new Map(rows.map((r) => [r.column, r]))

  // Keyed on the treatments as well as the columns: the same variables entering
  // as splines, as bin indicators or as continuous terms are three different
  // designs with three different collinearity structures.
  const treatKey = picked.map((c) => `${c}:${treatments[c] ?? 'woe'}`).join(',')
  const vif = useQuery({
    queryKey: ['vif', portfolio, treatKey],
    queryFn: () => api.vif(portfolio, picked, treatments),
    enabled: picked.length >= 2,
  })
  const vifBy = new Map((vif.data?.vif ?? []).map((v) => [v.column, v] as const))

  const worstVif = Math.max(0, ...(vif.data?.vif ?? []).map((v) => v.vif))
  const anyLeak = picked.some((p) => byName.get(p)?.leakage_risk === 'likely')
  const anyFlip = picked.some((p) => byName.get(p)?.sign_ok === false)

  // A screening preview, not a fitted model:
  //
  //     indicator = SUM over selected  min(IV, 1.5) / sqrt(VIF)
  //
  // Each variable contributes its own information value, capped so a
  // leakage-shaped column scoring 22 cannot swamp the rest, and divided by its
  // OWN standard-error inflation factor. Dividing every variable by the worst
  // VIF in the set — which is what this did — penalised uncorrelated variables
  // for a collinear pair they had nothing to do with.
  //
  // The per-variable form is also the one that behaves correctly when a
  // redundant variable is added: it contributes little because its own VIF is
  // high, AND it deflates the variable it duplicates. The old form moved only
  // when the worst pair changed.
  const covered = picked.length < 2
    || picked.every((c) => vifBy.has(c) || (vif.data?.skipped ?? []).includes(c))
  const settled = !vif.isFetching && covered
  const indicator = picked.reduce((a, p) => {
    const iv = Math.min(byName.get(p)?.iv ?? 0, 1.5)
    const v = vifBy.get(p)?.vif ?? 1
    return a + iv / Math.sqrt(Math.max(v, 1))
  }, 0)
  // The variance inflation arrives a moment after the selection changes. Showing
  // the sum undiscounted in the meantime made the number jump to a high value
  // and fall back, which reads as instability in the specification rather than
  // in the fetch. The last settled figure is held until the new one is complete.
  const shown = useRef(indicator)
  if (settled) shown.current = indicator

  return (
    <Card className="flex h-fit max-h-[calc(100vh-190px)] flex-col">
      <CardHead
        title="Selected variables"
        subtitle={`${picked.length} in the current specification`}
        caption="Variance inflation is computed on the design the model will actually contain, so it depends on how each variable is treated as well as on which variables are selected. A term that emits several columns — a spline basis, a set of bin indicators — is reported as a generalised VIF on the one-column scale."
        right={picked.length > 0 && (
          <button onClick={() => clearVariables(portfolio as PortfolioKey)}
            className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">
            Clear
          </button>
        )}
      />

      <div className="border-b border-hairline px-4 py-3">
        <div className="text-micro text-ink-muted">Specification strength indicator</div>
        <div className={`mt-0.5 text-2xl font-semibold tabular-nums text-accent transition-opacity ${
          settled ? '' : 'opacity-40'}`}>
          {shown.current.toFixed(2)}
        </div>
        <p className="mt-1 text-micro leading-snug text-ink-muted"
           title="indicator = sum over the selected variables of min(IV, 1.5) / sqrt(VIF). Each variable contributes its own information value, capped so a leakage-shaped column cannot swamp the rest, divided by its own standard-error inflation factor.">
          Each variable's information value, capped at 1.5, divided by the square
          root of its variance inflation, summed.{' '}
          <span className="text-ink-secondary">Not a fitted model score</span>:
          information value is read off the optimal binning whatever treatment is
          selected, so this is a screening quantity. Fit the model for
          discrimination and calibration.
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
                  <span title={v.df > 1
                    ? `This term contributes ${v.df} design columns, so the ordinary variance inflation factor does not apply to it. Shown is the Fox-Monette generalised VIF raised to 1/(2·df) and squared, which is on the same scale as a one-column VIF. Raw GVIF ${v.gvif.toFixed(1)}.`
                    : 'Variance inflation against the other columns in the design, including the seasoning basis.'}>
                    VIF <span className="tnum"
                    style={{ color: v.vif > 10 ? 'var(--status-critical)' : v.vif > 5 ? 'var(--status-warning)' : 'var(--ink-secondary)' }}>
                    {v.vif.toFixed(2)}</span>
                    {v.df > 1 && <span className="ml-0.5 text-ink-muted">·{v.df}col</span>}
                  </span>
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
