import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey } from '../lib/api'
import ModelBand from '../components/ModelBand'
import FitProgress, { ECL_PHASES } from '../components/FitProgress'
import { Card, CardHead, EmptyState, HeroFigure, StatTile, StatusPill, ViewTabs, Notice } from '../components/ui'
import Eq from '../components/Eq'
import { Info } from '../components/icons'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import Waterfall from '../charts/Waterfall'
import StressedMevs from '../components/StressedMevs'
import { baseOption, crosshairTooltip, lineSeries, xName, yName, gridFor } from '../charts/base'
import { ink, mode, ordinal } from '../design/tokens'
import { useUi } from '../lib/store'
import { month, num, pct, usd } from '../lib/format'

// The two the Federal Reserve publishes. There is deliberately no middle path:
// an interpolated "adverse" line is indistinguishable from a supervisory one on
// a chart, and the label was the only thing separating them.
const ORDER = ['baseline', 'severely_adverse']

export default function ScenarioSurface() {
  const { portfolio = 'consumer' } = useParams()
  const theme = useUi((s) => s.theme)
  const nav = useNavigate()
  const pk = portfolio as PortfolioKey
  const fitted = useUi((s) => s.fitted[pk])
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  // Keep the progress card for a moment after the response, so the bar is
  // seen to complete rather than vanishing at 92%.
  const [justRan, setJustRan] = useState(false)
  const [capped, setCapped] = useState(false)
  const [ifrs9, setIfrs9] = useState(false)
  // A CECL weighting is a management assumption, not a supervisory number.
  const [weights] = useState({ baseline: 0.75, severely_adverse: 0.25 })
  // Two shapes of the same series. The cumulative curve answers "how much in
  // total"; the monthly flow answers "when" — under stress it separates from
  // the baseline as losses emerge, then contracts back as the stressed
  // cohorts resolve. The contraction is invisible on the cumulative view.
  const [elView, setElView] = useState<'cumulative' | 'monthly'>('cumulative')

  const setProjected = useUi((s) => s.setProjected)

  // The projection is a QUERY, keyed on the model's identity, not a mutation.
  //
  // It used to be a mutation driven by effects: an auto-project effect with a
  // dedup ref, a setRes(null) on every trigger, a hold timer, and a reset
  // escape for when the pending flag wedged. Every one of those existed to
  // reimplement, by hand, what a cache-keyed query does by construction: the
  // key changes when the model changes, the result arrives declaratively, and
  // switching BACK to a model already projected this session shows its numbers
  // instantly from the cache with no request at all. Comparing challengers is
  // exactly that switch, so it must not cost a re-projection each way.
  // Both halves, or nothing. This used to project with the documented default
  // severity model when none was fitted, behind a banner — and the fallback
  // chain could even resurrect an LGD spec embedded in an old PD fit request.
  // A number produced by a severity model the analyst never fitted is not
  // their model's number, and quietly showing one is exactly the "old fit out
  // of nowhere" experience. The roll-up still uses documented defaults, and
  // says so per book; this page is the analyst's own model only.
  const lgdReady = !!fittedLgd?.hash
  const run = useQuery({
    queryKey: ['ecl', portfolio, fitted?.hash, fittedLgd?.hash, capped],
    queryFn: () => api.ecl({
      ...fitted!.request,
      lgd: fittedLgd!.spec,
      cap_to_fitted_range: capped,
      weights,
    }),
    enabled: !!fitted && lgdReady,
    staleTime: Infinity,
    // Aligned with the app-wide hour: this query's shorter 30-minute
    // override was the one remaining way a projection could be evicted and
    // silently recomputed on a later tab visit.
    gcTime: 60 * 60_000,
    retry: 1,
  })
  const res = run.data ?? null
  const busy = run.isFetching

  useEffect(() => {
    if (busy) { setJustRan(true); return }
    if (!justRan) return
    const t = setTimeout(() => setJustRan(false), 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  // Record WHICH model was projected, so the stage marker can tell a
  // projection that is current from one the model has moved on from.
  useEffect(() => {
    if (run.data && fitted && fittedLgd?.hash) {
      setProjected(pk, `${fitted.hash}:${fittedLgd.hash}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.data, fitted?.hash, fittedLgd?.hash])

  const byKey = useMemo(
    () => Object.fromEntries((res?.scenarios ?? []).map((s) => [s.key, s])), [res])
  // The macro terms of the specification that produced these numbers, in the
  // canonical form the paths endpoint parses.
  const mevTerms = useMemo(() => (fitted?.request.mevs ?? []).map(
    (m: { key: string; transform?: string; lag_months?: number }) =>
      `${m.key}@${m.transform ?? 'level'}@${m.lag_months ?? 0}`), [fitted?.hash])
  const ordered = ORDER.filter((k) => byKey[k]).map((k) => byKey[k])

  const projection = useMemo(() => {
    if (!ordered.length) return null
    const k = ink(mode())
    const cum = elView === 'cumulative'
    return {
      ...baseOption(),
      grid: gridFor({ left: 74, right: 18, top: 14, bottom: 46 }),
      tooltip: crosshairTooltip((v) => usd(v), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               ...xName('Projection month', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName(cum ? 'Cumulative expected loss (USD)' : 'Expected loss per month (USD)', 56),
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) } },
      // Severity is ORDERED, so a one-hue ramp — not three categorical colours.
      series: ordered.map((s, i) => lineSeries({
        name: s.label, color: ordinal(i, ordered.length), area: i === ordered.length - 1,
        data: s.monthly.map((m) => [m.month, cum ? m.cumulative_loss : m.loss] as [string, number]),
      })),
    }
  }, [ordered, theme, elView])

  if (!fitted) {
    return (
      <div className="p-4">
        <ModelBand portfolio={portfolio} />
        <Card>
          <CardHead title="Scenarios" subtitle={portfolio} />
          <EmptyState title="No fitted model to project">
            This stage projects a fitted PD model forward. It does not estimate
            one. Fit a PD model first; the Macro stage has the supervisory
            variables and the transformation search in the meantime.
          </EmptyState>
        </Card>
      </div>
    )
  }

  const sa = byKey.severely_adverse
  const base = byKey.baseline
  const flags = res?.extrapolation.filter((e) => e.outside) ?? []

  return (
    <div className="p-4">
      <ModelBand portfolio={portfolio} />
      <div className="space-y-3">
      {/* One view. A "Macro variables" tab lived here and duplicated the Macro
          stage; the paths panel below now states what this projection actually
          uses, which is the question this page answers. */}
      <>
      {!lgdReady && (
        <Card>
          <CardHead title="Scenarios" subtitle={portfolio} />
          <EmptyState title="The severity model is not fitted"
            action={<button onClick={() => nav(`/${portfolio}/lgd`)}
              className="mt-2 rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white">
              Fit the LGD model
            </button>}>
            A projection is PD times LGD times exposure, so it needs both
            halves of the model. Fit the LGD model on this book to project it.
          </EmptyState>
        </Card>
      )}
      {lgdReady && (
      <Card>
        <div className="flex flex-wrap items-center gap-4 px-4 py-3">
          <span className="text-xs text-ink-secondary">Supervisory scenarios</span>
          <label className="flex items-center gap-1.5 text-tiny text-ink-muted"
            title="Off by default: the projection uses the Federal Reserve's published path unmodified. When on, the forward path is winsorised to the range the model was estimated on. That keeps the projection within the observed range and also reduces the size of the shock. Both figures are reported either way.">
            <input type="checkbox" checked={capped}
              onChange={(e) => setCapped(e.target.checked)} />
            Constrain macro path to the fitted range <Info className="text-ink-muted" />
          </label>
          <label className="flex items-center gap-1.5 text-tiny text-ink-muted">
            <input type="checkbox" checked={ifrs9} onChange={(e) => setIfrs9(e.target.checked)} />
            IFRS 9 staging view
          </label>
          {/* Re-project forces a fresh computation past every cache. Always
              clickable, so a stalled request is one click from recovery. */}
          <button onClick={() => run.refetch()}
            className="ml-auto inline-flex items-center gap-2 rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white">
            {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/80" />}
            {busy ? 'Projecting… (click to restart)' : res ? 'Re-project' : 'Run scenarios'}
          </button>
        </div>
        {run.isError && (
          <div className="border-t border-hairline px-4 py-2 text-xs"
               style={{ color: 'var(--status-critical)' }}>
            {String(run.error).replace(/^Error:\s*/, '')}
          </div>
        )}
      </Card>
      )}

      {(busy || justRan) && (
        <FitProgress done={!busy} doneLabel="Projected"
          phases={ECL_PHASES(res?.scenarios?.[0]?.n_accounts, res?.timings)} />
      )}

      {/* How much of the stressed number rests on extrapolation — the model
          answering beyond the range it was fitted on. The presentation follows
          the materiality: below two percent this is a finding of SAFETY
          ("checked, immaterial") and renders as one quiet line; the amber
          treatment is reserved for when a material share of the answer has no
          evidence behind it. A warning box over a 1.8% effect teaches readers
          to ignore warning boxes. */}
      {flags.length > 0 && sa?.alternative_ecl != null
        && Math.abs(1 - Math.min(sa.alternative_ecl, sa.ecl) / Math.max(sa.alternative_ecl, sa.ecl)) < 0.02 ? (
        <p className="max-w-[88ch] px-1 text-tiny leading-relaxed text-ink-muted">
          Part of the Federal Reserve path runs beyond the range the model was
          fitted on ({flags.map((f) => f.key).join(', ')}). Constraining it to
          the fitted range changes severely adverse ECL by under 2%
          ({usd(sa.ecl)} against {usd(sa.alternative_ecl)} constrained), so
          almost none of the number rests on extrapolation.
        </p>
      ) : flags.length > 0 && (
        <Notice severity="warning" label="Beyond the model's experience">
          <div className="space-y-1">
            {flags.map((f) => <p key={f.key}>{f.note}</p>)}
          </div>
          {sa?.alternative_ecl != null && (() => {
            // When the two figures round to the same string, "gives $12M
            // instead of $12M, a reduction of 1%" reads as a bug. Below a
            // visible difference the honest sentence is that the cap barely
            // matters, stated once.
            const same = usd(sa.alternative_ecl) === usd(sa.ecl)
            const pct = (x: number) => x.toLocaleString(undefined,
              { style: 'percent', maximumFractionDigits: 1 })
            return (
              <p className="max-w-[88ch] mt-2 text-tiny leading-relaxed text-ink-secondary">
                {same ? (
                  <>
                    Constraining the forward path to the estimation range changes
                    severely adverse ECL by{' '}
                    <span className="tnum">{pct(Math.abs(1 - Math.min(sa.alternative_ecl, sa.ecl) / Math.max(sa.alternative_ecl, sa.ecl)))}</span>
                    {' '}or less, so almost none of this model's response comes from
                    outside the range it was estimated on.
                  </>
                ) : res?.capped ? (
                  <>
                    The forward path is constrained to the estimation range, so the figure
                    above is not the Federal Reserve's published scenario. On the published
                    path, severely adverse ECL is{' '}
                    <span className="tnum text-ink">{usd(sa.alternative_ecl)}</span> against{' '}
                    <span className="tnum">{usd(sa.ecl)}</span> here, a reduction of{' '}
                    <span className="tnum">{pct(1 - sa.ecl / sa.alternative_ecl)}</span>.
                  </>
                ) : (
                  <>
                    This projection uses the Federal Reserve's published path, part of which
                    lies outside the range the model was estimated on. Constraining the path
                    to that range gives{' '}
                    <span className="tnum text-ink">{usd(sa.alternative_ecl)}</span> instead of{' '}
                    <span className="tnum">{usd(sa.ecl)}</span>, a reduction of{' '}
                    <span className="tnum">{pct(1 - sa.alternative_ecl / sa.ecl)}</span>.
                    The difference between the two figures indicates how much of the response
                    falls outside the estimation range.
                  </>
                )}
              </p>
            )
          })()}
        </Notice>
      )}

      {res && sa && base && (
        <>
          <Card>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <HeroFigure
                label={`Lifetime ECL: ${ifrs9 ? 'IFRS 9 staged' : 'CECL, severely adverse'}`}
                value={usd(ifrs9 ? sa.ifrs9.total_ecl : sa.ecl)}
                sub={`${num(sa.n_accounts)} open accounts · ${usd(sa.exposure)} exposure · `
                  + `${res.horizon_months} month horizon from ${month(res.as_of)}`} />
              <div className="flex divide-x divide-hairline">
                <StatTile label="Baseline ECL" value={usd(base.ecl)}
                  explain={`${base.ecl_bps.toFixed(0)} basis points of exposure.`} />
                {/* The LEVEL leads. A multiple is the ratio of two numbers and
                    is dominated by whichever is smaller: a secured book loses
                    almost nothing in benign conditions, so a perfectly ordinary
                    stress loss divides by a very small baseline and returns a
                    large figure. Reading the multiple alone, a mortgage book
                    looks four times more sensitive than an unsecured one when
                    its stressed loss rate is in fact lower. */}
                <StatTile label="Severely adverse" value={usd(sa.ecl)}
                  explain={`${sa.ecl_bps.toFixed(0)} basis points of exposure, `
                    + `cumulative over ${res.horizon_months} months.`} />
                <StatTile label="Stress multiple" value={`${(sa.ecl / base.ecl).toFixed(2)}x`}
                  explain={'Severely adverse ECL divided by baseline ECL. On a '
                    + 'secured book this runs high because the baseline is small, '
                    + 'not because the stressed loss is extreme: collateral '
                    + 'covers the loss in benign conditions, so the denominator '
                    + 'is near zero. Compare the basis-point figures, which is '
                    + 'what the multiple is a ratio of.'} />
                <StatTile label="Probability-weighted"
                  value={usd(res.weighted_ecl)}
                  explain={`Weights: ${Object.entries(res.weights)
                    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')}`} />
              </div>
            </div>
          </Card>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <Card>
              <CardHead title="ECL attribution bridge"
                subtitle={`${res.bridge[0]?.label} to ${res.bridge.at(-1)?.label}`}
                caption="Sequential substitution: each component is moved from its baseline value to its stressed value one at a time. The interaction term is the residual, reported rather than distributed across the other steps."
                methodology="ecl" />
              <Waterfall steps={res.bridge} reconciles={res.bridge_reconciles}
                ariaLabel="ECL attribution bridge" />
            </Card>

            <Card>
              <CardHead title="Expected loss over the horizon"
                subtitle={elView === 'cumulative'
                  ? 'Cumulative · survival-adjusted, discounted at the effective interest rate'
                  : 'Per month · the paths separate as stress losses emerge, then contract as the stressed cohorts resolve'}
                right={<ViewTabs value={elView} onChange={setElView} tabs={[
                  { key: 'cumulative' as const, label: 'Cumulative' },
                  { key: 'monthly' as const, label: 'Monthly',
                    title: 'The loss flow per month, not the running total' },
                ]} />}
                />
              <Legend items={ordered.map((s, i) => ({ name: s.label, color: ordinal(i, ordered.length) }))} />
              {projection && (
                <EChart option={projection} height={230} ariaLabel="Expected loss by scenario" externalLegend
                  table={{ columns: ['Month', ...ordered.map((s) => s.label)],
                           rows: (ordered[0]?.monthly ?? []).map((m, i) =>
                             [m.month, ...ordered.map((s) => Math.round(
                               (elView === 'cumulative' ? s.monthly[i]?.cumulative_loss : s.monthly[i]?.loss) ?? 0))]) }} />
              )}
            </Card>
          </div>

          <Card>
            <CardHead title="Scenario comparison"
              caption="Each scenario applied to the same book at the same reporting date. Both paths are published by the Federal Reserve." />
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-hairline text-tiny text-ink-muted">
                  <th className="px-4 py-2 font-medium">Scenario</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 text-right font-medium">12-month PD</th>
                  <th className="px-3 py-2 text-right font-medium">LGD</th>
                  <th className="px-3 py-2 text-right font-medium">ECL</th>
                  <th className="px-3 py-2 text-right font-medium">bps</th>
                  <th className="px-3 py-2 text-right font-medium">vs baseline</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((s, i) => (
                  <tr key={s.key} className="border-b border-hairline">
                    <td className="px-4 py-1.5">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full"
                              style={{ background: ordinal(i, ordered.length) }} />
                        <span className="text-ink">{s.label}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill severity={s.published ? 'good' : 'warning'}>
                        {s.published ? 'Federal Reserve' : 'custom path'}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{pct(s.weighted_pd_12m * 100)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{s.weighted_lgd.toFixed(3)}</td>
                    <td className="px-3 py-1.5 text-right tnum font-medium text-ink">{usd(s.ecl)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{s.ecl_bps.toFixed(0)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">
                      {i === 0 ? '—' : `${(s.ecl / base.ecl).toFixed(2)}x`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ifrs9 && (
              <div className="border-t border-hairline px-4 py-3">
                <div className="text-micro uppercase tracking-wider text-ink-muted">IFRS 9 staging: severely adverse</div>
                <p className="mt-1 text-tiny text-ink-secondary">{sa.ifrs9.trigger}</p>
                <div className="mt-2 flex flex-wrap gap-4 text-xs">
                  {sa.ifrs9.stages.map((st) => (
                    <div key={st.stage} className="rounded-card border border-hairline px-3 py-1.5">
                      <div className="text-tiny text-ink-muted">Stage {st.stage} · {st.basis}</div>
                      <div className="tnum text-ink">{usd(st.ecl)}</div>
                      <div className="text-micro text-ink-muted">{num(st.n)} accounts · {usd(st.exposure)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* The paths card shares its row with the two assumption cards
              rather than owning a full-width band: a two-term table in a
              1500px card was mostly card. The three of them are one story —
              what the projection consumes, and the exposure and severity
              assumptions it consumes it with. */}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <StressedMevs terms={mevTerms}
            subtitle={`${mevTerms.length} macro term${mevTerms.length === 1 ? '' : 's'} in the fitted specification`} />

          <div className="space-y-3">
            <Card>
              <CardHead title="Exposure at default" subtitle={`Method: ${res.ead.method}`}
                caption="The exposure assumption applied to every account, and the parameters it was estimated from. It is carried into each ECL figure on this page." />
              <div className="max-w-[88ch] px-4 py-3 text-xs leading-relaxed text-ink-secondary">
                {res.ead.plain_english}
                {res.ead.ccf_note && (
                  <p className="mt-2 text-tiny text-ink-muted">{res.ead.ccf_note}</p>
                )}
              </div>
            </Card>
            <Card>
              <CardHead title="Loss given default"
                subtitle={`Fractional logit · fitted on ${num(res.lgd.n_defaults)} defaults`}
                caption={<><Eq tex="\mathbb{E}[\,\mathrm{LGD}\mid X\,] = \sigma(X\beta)" />, estimated by fractional-response quasi-likelihood on realised severity. Macro drivers are joined at the default month.</>} />
              <div className="grid grid-cols-3 divide-x divide-hairline">
                <StatTile label="Mean LGD" value={res.lgd.mean_lgd.toFixed(3)} />
                <StatTile label="Zero-loss share" value={pct(res.lgd.zero_loss_share * 100, 1)}
                  explain="Defaults where recovery covered the balance in full." />
                <StatTile label="Severity given loss"
                  value={res.lgd.mean_severity_given_loss.toFixed(3)} />
              </div>
              <div className="border-t border-hairline px-4 py-2 text-micro text-ink-muted">
                Drivers: {res.lgd.drivers.join(', ')} · mean workout{' '}
                {res.lgd.mean_workout_months.toFixed(1)} months
              </div>
            </Card>
          </div>
          </div>
        </>
      )}

      {lgdReady && !res && !busy && (
        <Card>
          <EmptyState title="Not projected yet"
            action={<button onClick={() => run.refetch()}
              className="mt-2 rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white">
              Run scenarios
            </button>}>
            Projects every open account over the published supervisory horizon under
            baseline, adverse and severely adverse, and builds the attribution bridge.
          </EmptyState>
        </Card>
      )}
      </>
      </div>
    </div>
  )
}
