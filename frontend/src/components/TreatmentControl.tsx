import type { BinningResult, Treatment } from '../lib/api'

const OPTIONS: { key: Treatment; label: string; blurb: string }[] = [
  { key: 'woe', label: 'WoE',
    blurb: 'Discretised, then one column. Each bin is replaced by its weight of '
         + 'evidence, so the direction of the relationship is carried in the '
         + 'encoding and a single coefficient reproduces the bin log-odds. The '
         + 'scorecard convention.' },
  { key: 'bins', label: 'Bins',
    blurb: 'Discretised, then one indicator column per bin less a reference bin. '
         + 'Imposes no shape, so a relationship that changes direction is '
         + 'represented. Two bins emit a single column named <variable>_flag.' },
  { key: 'continuous', label: 'Continuous',
    blurb: 'Kept on its own scale as one standardised column. Retains the '
         + 'variation within bins that a discretisation discards, and assumes the '
         + 'effect is linear in the log-odds.' },
  { key: 'spline', label: 'Spline',
    blurb: 'Kept on its own scale, through a piecewise-linear basis at the chosen '
         + 'knots, orthogonalised. Represents a relationship that changes slope '
         + 'smoothly without discretising the variable.' },
]

/**
 * How a variable enters the model.
 *
 * Four named treatments. Underneath they are two decisions — is the variable
 * discretised, and how is it encoded — but a grid of legal pairs is a control
 * panel, and labelling the two groups in the control put more chrome on screen
 * than the distinction was worth. The structure shows where it matters instead:
 * the PANEL BELOW follows the decision, so a discretised treatment gets the
 * binning editor, the bin table and the information value, and a continuous one
 * gets none of those three because none of them applies to it.
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
    <div className="border-t border-hairline">
      {/* One row: how it enters, what that costs, and the suggestion. The blurb
          for each option lives in its tooltip — printed inline it filled two
          lines with text nobody reads twice. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
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
                          : 'cursor-not-allowed text-ink-muted/40'}`}>
                {o.label}
              </button>
            )
          })}
        </div>

        {cost != null && (
          <span className="text-tiny text-ink-muted">
            <span className="tnum text-ink-secondary">{cost}</span>
            {cost === 1 ? ' column' : ' columns'}
          </span>
        )}

        {/* The count is chosen here; the positions are placed on the relationship
            panel below, at quantiles or by search. */}
        {value === 'spline' && (
          <span className="flex items-center gap-1.5 text-tiny text-ink-muted">
            <span className="h-4 w-px bg-hairline" />
            <span>knots</span>
            <button onClick={() => onKnots(Math.max(1, nKnots - 1))}
              className="rounded border border-hairline px-1.5 text-micro hover:text-ink">−</button>
            <span className="tnum text-ink-secondary">{nKnots}</span>
            <button onClick={() => onKnots(Math.min(8, nKnots + 1))}
              className="rounded border border-hairline px-1.5 text-micro hover:text-ink">+</button>
            {result.knots?.length > 0 && (
              <span className="text-micro text-ink-muted/80"
                    title="Current positions. Drag them on the relationship panel below, or place them by search.">
                {result.knots.map((k) => fmtKnot(k)).join(' · ')}
              </span>
            )}
          </span>
        )}

        {rec && rec !== value && (
          <button onClick={() => onChange(rec)} title={result.shape.reason}
            className="ml-auto rounded border px-1.5 py-0.5 text-micro"
            style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
            shape indicates {rec}
          </button>
        )}
      </div>
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
