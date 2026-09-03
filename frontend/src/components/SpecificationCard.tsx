import type { FitResponse } from '../lib/api'
import { Card, CardHead, StatusPill, Notice } from './ui'
import { num } from '../lib/format'

/** The variance inflation to REPORT for a column.
 *
 *  A term that emits several columns inflates itself, so the ordinary
 *  per-column figure is not the quantity to act on. Prefer the term's
 *  generalised VIF where the fit supplied one; fall back to the column figure
 *  for a version fitted before the term was recorded. */
const vifOf = (c: { vif: number; term_vif?: number | null }) =>
  c.term_vif ?? c.vif


/** The model documentation starter.
 *
 *  This is the artifact that usually takes two weeks to write: the full
 *  specification, readable — target definition, sample design, every variable
 *  with its transform, coefficient, standard error, p-value, variance inflation
 *  and directional sanity, plus the EAD assumption stated in plain English.
 */
export default function SpecificationCard({ r, onOpenVariable }: {
  r: FitResponse
  /** Open the variable behind a coefficient in the detail pane. A term that
   *  comes back weak is one click from its binning, which is where it gets
   *  fixed. */
  onOpenVariable?: (column: string) => void
}) {
  // The variable a coefficient row belongs to. Multi-column terms carry it
  // explicitly; a weight-of-evidence column is the variable name with a suffix.
  const variableOf = (c: { name: string; term?: string | null }) =>
    c.name === 'intercept' || c.name.startsWith('seasoning_') || c.name.startsWith('mev:')
      ? null : (c.term ?? c.name.replace(/_woe$/, ''))
  const sig = (p: number) => (p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : '')
  const isSeasoning = (n: string) => n.startsWith('seasoning_')
  const seasoning = r.coefficients.filter((c) => isSeasoning(c.name))
  const shown = r.coefficients.filter((c) => !isSeasoning(c.name))

  const flips = r.sign_checks?.filter((c) => !c.ok) ?? []

  return (
    <div className="space-y-3">
      {flips.map((f) => (
        <Notice key={f.term} severity="critical" label="Economic sign flipped">
          {f.message}
        </Notice>
      ))}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card>
          <CardHead title="Target definition" />
          <dl className="space-y-2 px-4 py-3 text-xs">
            <Row k="Column" v={<code className="font-mono">{r.target.column}</code>} />
            <Row k="Definition" v={r.target.description} />
            <Row k="Frame" v="Discrete-time hazard on account-months" />
            <Row k="Events (fit)" v={num(r.n_events_train)} />
          </dl>
        </Card>

        <Card>
          <CardHead title="Sample design" />
          <dl className="space-y-2 px-4 py-3 text-xs">
            <Row k="Train" v={`${num(r.slices.train)} account-months`} />
            <Row k="Test" v={`${num(r.slices.test)}, split by account rather than by row`} />
            <Row k="Out of time" v={`${num(r.slices.oot)}, from ${r.backtest.oot_from}`} />
            <Row k="Fit sample" v={r.downsampled
              ? 'Thinned, events preserved, intercept prior-corrected'
              : 'Full panel, no thinning'} />
          </dl>
        </Card>

        <Card>
          <CardHead title="Exposure at default" />
          <div className="px-4 py-3">
            <StatusPill severity="good">
              {r.ead.method === 'ccf' ? 'CCF / LEQ' : 'Amortizing schedule'}
            </StatusPill>
            <p className="max-w-[88ch] mt-2 text-xs leading-relaxed text-ink-secondary">{r.ead.note}</p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHead
          title="Fitted specification"
          subtitle={`${r.spec.estimator as string} · ${r.iterations} Newton iterations · converged: ${r.converged}`}
          caption="Every term with its coefficient, standard error, z-statistic, p-value, variance inflation and share of the fitted linear predictor's variance."
          right={<span className="text-micro text-ink-muted">*** p&lt;0.001 · ** p&lt;0.01 · * p&lt;0.05</span>}
        />
        <div className="thin-scroll overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-hairline text-tiny text-ink-muted">
                <th className="px-3 py-2 font-medium">Term</th>
                <th className="px-3 py-2 text-right font-medium">Coefficient</th>
                <th className="px-3 py-2 text-right font-medium">Std. error</th>
                <th className="px-3 py-2 text-right font-medium">z</th>
                <th className="px-3 py-2 text-right font-medium">p-value</th>
                <th className="px-3 py-2 text-right font-medium">VIF</th>
                <th className="px-3 py-2 text-right font-medium">Contribution</th>
                <th className="px-3 py-2 font-medium">Direction</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const base = c.name.replace(/_woe$/, '').replace(/^mev:/, '')
                const expected = r.expected_signs[base]
                // A WoE-transformed variable always enters with a POSITIVE
                // coefficient when the relationship matches the data, because the
                // weight of evidence already carries the direction. The economic
                // prior is checked at the bin level on the Explore surface, which
                // is where it is meaningful.
                const flagged = c.name !== 'intercept' && c.p_value > 0.05
                return (
                  <tr key={c.name} className="border-b border-hairline">
                    <td className="px-3 py-1.5 font-mono text-tiny text-ink">
                      {onOpenVariable && variableOf(c) ? (
                        <button onClick={() => onOpenVariable(variableOf(c)!)}
                          title={`Open ${variableOf(c)}: binning, shape and stability`}
                          className="text-left hover:text-accent hover:underline">
                          {c.name}
                        </button>
                      ) : c.name}
                      {/* An indicator coefficient is the shift relative to the
                          bin with no column. Say which bin that is, or the
                          estimates read as absolute effects. */}
                      {variableOf(c) && r.references?.[variableOf(c)!]
                        && (c.name.includes('=') || c.name.endsWith('_flag')) && (
                        <span className="ml-1.5 font-sans text-micro text-ink-muted"
                          title={`Reference level: ${r.references[variableOf(c)!]}. This coefficient is the shift in log-odds relative to that level.`}>
                          vs {r.references[variableOf(c)!]}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink">{c.estimate.toFixed(4)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{c.std_error.toFixed(4)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{c.z_stat.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">
                      {c.p_value < 1e-4 ? '<0.0001' : c.p_value.toFixed(4)}
                      <span className="ml-1 text-ink-muted">{sig(c.p_value)}</span>
                    </td>
                    {/* The TERM's inflation, not the column's.
                        A term that emits several columns inflates itself: bin
                        indicators from one variable are mutually exclusive, so
                        each is well predicted by the others whatever else is in
                        the model. A four-bin fico term read 4.45, 9.16, 11.52
                        and 10.56 per column against a term figure of 1.77, and
                        the per-column ranking put it above a term that really
                        was the more inflated one. */}
                    <td className="px-3 py-1.5 text-right tnum"
                        title={vifOf(c) == null ? undefined
                          : (c.term_df ?? 1) > 1
                            ? `${c.term} enters as ${c.term_df} columns, so the ordinary `
                              + `variance inflation factor does not apply to any one of `
                              + `them. Shown is the Fox-Monette generalised VIF on the `
                              + `one-column scale, for the term as a whole. This column `
                              + `alone reads ${c.vif.toFixed(2)}, most of which is the `
                              + `term inflating itself: its indicators are mutually `
                              + `exclusive.`
                            : 'Variance inflation against the other columns in the design.'}
                        style={{ color: (vifOf(c) ?? 0) > 10 ? 'var(--status-critical)'
                          : (vifOf(c) ?? 0) > 5 ? 'var(--status-warning)' : 'var(--ink-secondary)' }}>
                      {vifOf(c)?.toFixed(2) ?? '—'}
                      {(c.term_df ?? 1) > 1 && (
                        <span className="ml-0.5 text-micro text-ink-muted">·{c.term_df}col</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-16 rounded-sm bg-sunken">
                          <div className="h-1.5 rounded-sm bg-accent"
                               style={{ width: `${Math.min(c.contribution * 100, 100)}%` }} />
                        </div>
                        <span className="tnum text-tiny text-ink-muted">
                          {(c.contribution * 100).toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      {r.sign_checks?.find((s) => s.term === c.name && !s.ok)
                        ? <StatusPill severity="critical">sign flip</StatusPill>
                        : flagged
                        ? <StatusPill severity="warning">not significant</StatusPill>
                        : expected != null
                          ? <span className="text-tiny text-ink-muted">
                              prior: {expected > 0 ? 'raises risk' : 'reduces risk'}
                            </span>
                          : null}
                    </td>
                  </tr>
                )
              })}
              {seasoning.length > 0 && (
                <tr className="border-b border-hairline bg-sunken/40">
                  <td className="px-3 py-1.5 font-mono text-tiny text-ink-secondary">
                    seasoning spline
                  </td>
                  <td colSpan={7} className="px-3 py-1.5 text-tiny text-ink-muted">
                    {seasoning.length} orthogonalized basis functions on months on book.
                    The basis is QR-orthogonalized, so variance inflation is 1.00 and the
                    individual weights carry no separate meaning. The fitted curve is the
                    quantity of interest, and it is plotted under Fit diagnostics.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHead title="Scorecard"
          subtitle={`Base ${r.scorecard.base_score} at ${r.scorecard.base_odds}:1 odds · PDO ${r.scorecard.pdo}`}
          caption="A linear rescaling of the log-odds: the odds of being good double every 20 points. It is a monotone transformation of the fitted probability and carries the same information." />
        <div className="thin-scroll max-h-[320px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-hairline text-tiny text-ink-muted">
                <th className="px-3 py-1.5 font-medium">Variable</th>
                <th className="px-3 py-1.5 font-medium">Bin</th>
                <th className="px-3 py-1.5 text-right font-medium">WoE</th>
                <th className="px-3 py-1.5 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody>
              {r.scorecard.points.map((p, i) => (
                <tr key={i} className="border-b border-hairline">
                  <td className="px-3 py-1 font-mono text-tiny text-ink-secondary">{p.variable}</td>
                  <td className="px-3 py-1 font-mono text-tiny text-ink">{p.bin}</td>
                  <td className="px-3 py-1 text-right tnum text-ink-secondary">{p.woe.toFixed(4)}</td>
                  <td className="px-3 py-1 text-right tnum font-medium text-ink">{p.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-muted">{k}</dt>
      <dd className="text-right text-ink-secondary">{v}</dd>
    </div>
  )
}
