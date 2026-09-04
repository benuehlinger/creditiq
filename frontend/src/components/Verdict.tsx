import type { FitResponse, ScreenRow } from '../lib/api'
import { StatusPill, Notice } from './ui'
import { ratio } from '../lib/format'

/**
 * The verdict: what a validator reads first, in the order they read it.
 *
 * A fit used to open on six equal tiles: version, AUC test, AUC out of time,
 * KS, Gini, McFadden. Four of those are discrimination, one is redundant (Gini
 * is 2·AUC − 1), and none of them is the number an expected-credit-loss model
 * is judged on. ECL is PD × LGD × EAD; a mis-ranked model costs some accuracy,
 * a mis-LEVELLED one produces the wrong dollar figure. So calibration leads.
 *
 * Each row is one question with one answer and one status:
 *
 *   Calibration     does the level hold out of time?
 *   Discrimination  does it rank, and does that survive out of time?
 *   Stability       has the population it scores drifted?
 *   Economic sense  do the macro terms move risk the way the prior says?
 *   Parsimony       is every term earning its place?
 *
 * and a leakage banner above them all, because a model carrying a variable
 * recorded after the outcome is not a model at all, whatever the numbers say.
 *
 * Thresholds are stated on the tooltips, not hidden in the colour.
 */
type Sev = 'good' | 'warning' | 'serious' | 'critical'

/** The leakage notice on its own, for the top of the model pane. */
export function LeakageNotice({ r, screen }: { r: FitResponse; screen?: ScreenRow[] }) {
  const inSpec = new Set((r.spec as { variables?: { column: string }[] }).variables?.map((v) => v.column))
  const leaks = (screen ?? []).filter((s) => s.leakage_risk === 'likely' && inSpec.has(s.column))
  if (!leaks.length) return null
  return (
    <Notice severity="critical" label="Leakage">
      {leaks.map((l) => l.column).join(', ')} {leaks.length === 1 ? 'is' : 'are'} recorded
      after the outcome. Every figure on this model is inflated by it. Remove and refit.
    </Notice>
  )
}

export default function Verdict({ r, screen }: { r: FitResponse; screen?: ScreenRow[] }) {
  const t = r.diagnostics.test
  const o = r.diagnostics.oot
  const oot = r.backtest.errors?.out_of_time

  // ── calibration ─────────────────────────────────────────────────────────
  const bias = oot?.bias_pp
  const rat = oot?.ratio
  const cov = oot?.coverage
  const calSev: Sev = rat == null ? 'warning'
    : Math.abs(rat - 1) <= 0.10 && (cov ?? 1) >= 0.8 ? 'good'
    : Math.abs(rat - 1) <= 0.25 ? 'warning'
    : 'critical'
  const calText = rat == null ? 'No out-of-time cohorts to test the level on'
    : `${rat >= 1 ? 'over' : 'under'}-predicts by ${Math.abs((rat - 1) * 100).toFixed(0)}% out of time`
      + (bias != null ? ` (${bias >= 0 ? '+' : ''}${bias.toFixed(2)}pp a year)` : '')

  // ── discrimination ──────────────────────────────────────────────────────
  const aucT = t?.auc, aucO = o?.auc
  const drop = aucT != null && aucO != null ? aucT - aucO : null
  const discSev: Sev = aucO == null ? 'warning'
    : aucO < 0.65 ? 'critical'
    : (drop ?? 0) > 0.10 ? 'critical'
    : (drop ?? 0) > 0.05 || aucO < 0.70 ? 'warning'
    : 'good'
  const discText = aucO == null ? `AUC ${ratio(aucT)} on test data; no out-of-time data`
    : `AUC ${ratio(aucT)} on test, ${ratio(aucO)} out of time`
      + (drop != null ? ` (${drop >= 0 ? '−' : '+'}${Math.abs(drop).toFixed(3)})` : '')

  // ── stability ───────────────────────────────────────────────────────────
  const psiPts = r.backtest.score_psi ?? []
  const psi = psiPts.length ? psiPts[psiPts.length - 1].psi : null
  const psiMax = psiPts.length ? Math.max(...psiPts.map((x) => x.psi)) : null
  const stabSev: Sev = psi == null ? 'warning'
    : psi < 0.10 ? 'good' : psi < 0.25 ? 'warning' : 'critical'
  const stabText = psi == null ? 'No stability series'
    : `score PSI ${psi.toFixed(2)} latest, ${psiMax!.toFixed(2)} peak`

  // ── economic sense ──────────────────────────────────────────────────────
  const checks = r.sign_checks ?? []
  const flipped = checks.filter((c) => !c.ok)
  const flippedSig = flipped.filter((c) => c.significant)
  const signSev: Sev = !checks.length ? 'good'
    : flippedSig.length ? 'critical' : flipped.length ? 'warning' : 'good'
  const signText = !checks.length ? 'no macro term to check'
    : flipped.length === 0 ? `${checks.length} macro term${checks.length === 1 ? '' : 's'} agree with the prior`
    : `${flipped.map((c) => c.mev).join(', ')} against the prior`
      + (flippedSig.length ? ', significantly' : ', not significantly')

  // ── parsimony ───────────────────────────────────────────────────────────
  const terms = r.coefficients.filter((c) => c.name !== 'intercept' && !c.name.startsWith('seasoning_'))
  const insig = terms.filter((c) => c.p_value > 0.05)
  const parSev: Sev = insig.length === 0 ? 'good'
    : insig.length / Math.max(terms.length, 1) > 0.3 ? 'serious' : 'warning'
  const parText = insig.length === 0 ? `all ${terms.length} terms significant at 5%`
    : `${insig.length} of ${terms.length} terms not significant at 5%`

  // ── leakage ─────────────────────────────────────────────────────────────
  const inSpec = new Set(r.spec ? (r.spec as { variables?: { column: string }[] }).variables?.map((v) => v.column) : [])
  const leaks = (screen ?? []).filter((s) => s.leakage_risk === 'likely' && inSpec.has(s.column))

  // One figure per check on screen. The sentence and the threshold are on the
  // hover: five full sentences in five columns wrapped unevenly and read as a
  // wall, and the figure is what the eye wants first.
  const calFig = rat == null ? '—' : `${rat.toFixed(2)}× out of time`
  const discFig = aucO == null ? ratio(aucT)
    : `${ratio(aucT)} test · ${ratio(aucO)} out of time`
  const stabFig = psi == null ? '—' : `PSI ${psi.toFixed(2)}`
  const signFig = !checks.length ? 'no macro terms' : `${checks.length - flipped.length} of ${checks.length} with prior`
  const parFig = `${terms.length - insig.length} of ${terms.length} significant`

  const rows: { label: string; sev: Sev; fig: string; text: string; why: string }[] = [
    { label: 'Calibration', sev: calSev, fig: calFig, text: calText,
      why: 'The level, out of time. Mean predicted over mean realised annual default rate across out-of-time cohorts: within 10% and at least 80% of cohorts inside their 95% band is calibrated; within 25% is watch; beyond that the loss figure is wrong. This is the number an ECL model is judged on.' },
    { label: 'Discrimination', sev: discSev, fig: discFig, text: discText,
      why: 'Rank ordering, and whether it survives out of time. AUC below 0.65 out of time is weak. A drop of more than 0.05 from test to out of time indicates the model learned the estimation window rather than the risk; more than 0.10 is overfitting.' },
    { label: 'Stability', sev: stabSev, fig: stabFig, text: stabText,
      why: 'Population stability index of the model\'s own score against its first twelve months. Under 0.10 is stable; 0.10 to 0.25 is some shift; above 0.25 the population being scored is not the one the model was fitted on.' },
    { label: 'Economic sense', sev: signSev, fig: signFig, text: signText,
      why: 'Whether each macro coefficient moves default the way the declared prior says. A significant term against the prior will produce a stress scenario that REDUCES loss. Usually collinearity between macro terms rather than a finding.' },
    { label: 'Parsimony', sev: parSev, fig: parFig, text: parText,
      why: 'Terms not significant at the 5% level, excluding the seasoning basis. Each costs a parameter and adds variance to the projection without adding information.' },
  ]

  const worst: Sev = leaks.length ? 'critical'
    : (['critical', 'serious', 'warning', 'good'] as Sev[]).find((s) => rows.some((x) => x.sev === s))!
  const headline = leaks.length ? 'Not a usable model'
    : worst === 'good' ? 'Fit for purpose on every check'
    : worst === 'warning' ? 'Usable, with items to review'
    : worst === 'serious' ? 'Review before use'
    : 'Not fit for purpose as specified'


  return (
    <div className="rounded-card border border-hairline bg-raised">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-3 pb-2">
        <div className="text-tiny uppercase tracking-wider text-ink-muted">Verdict</div>
        <StatusPill severity={worst}>{headline}</StatusPill>
      </div>
      {leaks.length > 0 && (
        <div className="mx-5 mb-3">
          <Notice severity="critical" label="Leakage">
            {leaks.map((l) => l.column).join(', ')} {leaks.length === 1 ? 'is' : 'are'} recorded
            after the outcome. Every figure below is inflated by it. Remove and refit.
          </Notice>
        </div>
      )}
      {/* Five checks, one figure each. Colour on the icon only; the figure
          stays in ink so the row reads as data rather than as a row of alarms. */}
      <dl className="grid divide-x divide-hairline border-t border-hairline sm:grid-cols-5">
        {rows.map((row) => (
          <div key={row.label} className="px-5 py-3"
               title={`${row.text}.\n\n${row.why}`}>
            <dt className="text-tiny text-ink-muted">{row.label}</dt>
            <dd className="mt-1 flex items-baseline gap-1.5 text-sm text-ink">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 self-center rounded-full"
                    style={{ background: `var(--status-${row.sev})` }} />
              <span className="tnum">{row.fig}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
