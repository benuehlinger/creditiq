import type { BinningResult, Treatment } from '../lib/api'

const OPTIONS: { key: Treatment; label: string; blurb: string }[] = [
  { key: 'woe', label: 'WoE',
    blurb: 'One column. Weight of evidence bakes the direction of the relationship '
         + 'into the encoding, which is why a single coefficient reproduces the bin '
         + 'log-odds — the scorecard convention.' },
  { key: 'bins', label: 'Bins',
    blurb: 'One column per bin, less a reference. Assumes nothing about shape, so a '
         + 'non-monotone relationship survives instead of being flattened. Costs '
         + 'parameters for freedom you may not need.' },
  { key: 'continuous', label: 'Continuous',
    blurb: 'One column, standardized. Keeps within-bin information that binning '
         + 'discards, and assumes the effect is linear in the log-odds.' },
  { key: 'spline', label: 'Spline',
    blurb: 'A piecewise basis, orthogonalized. For an effect that genuinely bends — '
         + 'seasoning above all — where binning would throw the shape away.' },
]

/**
 * How a variable enters the model.
 *
 * Four named treatments rather than two dropdowns. Discretizing and encoding are
 * separate decisions internally, but a 5x5 grid of legal pairs is a control panel
 * and this product is meant to be usable in an afternoon — so the UI offers the
 * four pairs that mean something.
 *
 * The column cost is shown because it is the actual trade-off. On the consumer
 * book, FICO as seven dummies fits no better than FICO as one WoE column: the
 * likelihood ratio is 0.07 on six degrees of freedom. Making that visible is
 * more useful than hiding it behind a default.
 */
export default function TreatmentControl({ value, result, onChange, nKnots, onKnots }: {
  value: Treatment
  result: BinningResult
  onChange: (t: Treatment) => void
  nKnots: number
  onKnots: (n: number) => void
}) {
  const costs = result.column_costs ?? {}
  // A recommendation read off the SHAPE of the bin log-odds, because each
  // treatment is an assumption about that shape and the bins already contain the
  // answer. Shown as a suggestion, never applied.
  const rec = result.shape?.recommendation
  const cost = costs[value]
  const available = (k: Treatment) =>
    result.supports_continuous || (k !== 'continuous' && k !== 'spline')

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-hairline px-4 py-2">
      <span className="text-tiny text-ink-muted">Enters the model as</span>
      <div className="flex items-center gap-0.5 rounded-ctl bg-sunken p-0.5">
        {OPTIONS.map((o) => {
          const on = o.key === value
          const ok = available(o.key)
          return (
            <button key={o.key} disabled={!ok} onClick={() => onChange(o.key)}
              title={ok ? o.blurb
                : 'Not available for a categorical variable — there is no continuum to fit.'}
              className={`rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors ${
                on ? 'bg-raised text-ink shadow-sm'
                   : ok ? 'text-ink-muted hover:text-ink-secondary'
                        : 'text-ink-muted/40 cursor-not-allowed'}`}>
              {o.label}
            </button>
          )
        })}
      </div>
      {cost != null && (
        <span className="text-tiny text-ink-muted">
          costs <span className="tnum text-ink-secondary">{cost}</span>
          {cost === 1 ? ' column' : ' columns'}
        </span>
      )}

      {/* Knots are placed at QUANTILES of this variable, so the analyst chooses
          how many, never where. Nobody knows where to put a knot by hand, and
          asking produced the original bug: a fixed set designed for months on
          book was reused for every variable. */}
      {value === 'spline' && (
        <span className="flex items-center gap-1.5 text-tiny text-ink-muted">
          <span>knots</span>
          <button onClick={() => onKnots(Math.max(1, nKnots - 1))}
            className="rounded border border-hairline px-1.5 text-micro hover:text-ink">−</button>
          <span className="tnum text-ink-secondary">{nKnots}</span>
          <button onClick={() => onKnots(Math.min(8, nKnots + 1))}
            className="rounded border border-hairline px-1.5 text-micro hover:text-ink">+</button>
          {result.knots?.length > 0 && (
            <span className="text-micro" title="Placed at quantiles of this variable">
              at {result.knots.map((k) => fmtKnot(k)).join(', ')}
            </span>
          )}
        </span>
      )}

      {rec && rec !== value && (
        <button onClick={() => onChange(rec)} title={result.shape.reason}
          className="rounded border px-1.5 py-0.5 text-micro"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
          shape suggests {rec}
        </button>
      )}
      <span className="ml-auto max-w-lg text-right text-micro leading-snug text-ink-muted">
        {rec === value && result.shape?.reason
          ? result.shape.reason
          : OPTIONS.find((o) => o.key === value)?.blurb}
      </span>
    </div>
  )
}


function fmtKnot(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}K`
  if (a >= 100) return v.toFixed(0)
  if (a >= 1) return v.toFixed(1)
  return v.toFixed(3)
}
