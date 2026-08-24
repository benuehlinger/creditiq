import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { api, type EclResponse, type PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, HeroFigure, StatTile, StatusPill } from '../components/ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import Waterfall from '../charts/Waterfall'
import ScenarioEditor from '../components/ScenarioEditor'
import MacroPanel from '../components/MacroPanel'
import { baseOption, crosshairTooltip, lineSeries, xName, yName, gridFor } from '../charts/base'
import { ink, mode, ordinal } from '../design/tokens'
import { useUi } from '../lib/store'
import { month, num, pct, usd } from '../lib/format'

const DEFAULT_MEVS: Record<string, string[]> = {
  consumer: ['unemployment_rate', 'real_disp_income_growth'],
  mortgage: ['unemployment_rate'],
  cre: ['cre_price_index_yoy', 'bbb_yield'],
}
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
  const [res, setRes] = useState<EclResponse | null>(null)
  const [capped, setCapped] = useState(false)
  const [ifrs9, setIfrs9] = useState(false)
  const [custom, setCustom] = useState<Record<string, Record<string, number>>>({})
  // A CECL weighting is a management assumption, not a supervisory number.
  const [weights] = useState({ baseline: 0.75, severely_adverse: 0.25 })
  const [tab, setTab] = useState<'ecl' | 'macro'>('ecl')

  useEffect(() => { setRes(null); setCustom({}) }, [portfolio])

  const loaded = useUi((s) => s.loaded[pk])

  const run = useMutation({
    // Project the model that was FITTED, not a specification rebuilt from the
    // variable tray. Rebuilding it meant the scenario page could silently project
    // a different model from the one on the Model surface whenever the estimator,
    // the out-of-time date or the macro terms had been changed.
    mutationFn: (over?: Record<string, Record<string, number>>) => {
      if (!fitted) throw new Error('Fit a model on the Model surface first.')
      return api.ecl({
        ...fitted.request,
        // Severity is half the loss number, so it has to be the LGD model the
        // analyst actually fitted — not whatever the portfolio default happens
        // to be. Absent, the engine falls back to the documented default.
        lgd: fittedLgd?.spec ?? fitted.request.lgd ?? null,
        cap_to_fitted_range: capped,
        custom: over ?? custom,
        weights,
      })
    },
    onSuccess: setRes,
  })

  // A saved model has been opened: project it so this surface shows that model's
  // loss numbers rather than an empty state.
  useEffect(() => {
    if (loaded && fitted && !res && !run.isPending) run.mutate(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.hash, fitted?.hash])

  const byKey = useMemo(
    () => Object.fromEntries((res?.scenarios ?? []).map((s) => [s.key, s])), [res])
  const ordered = ORDER.filter((k) => byKey[k]).map((k) => byKey[k])

  const projection = useMemo(() => {
    if (!ordered.length) return null
    const k = ink(mode())
    return {
      ...baseOption(),
      grid: gridFor({ left: 74, right: 18, top: 14, bottom: 46 }),
      tooltip: crosshairTooltip((v) => usd(v), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               ...xName('Projection month', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName('Cumulative expected loss (USD)', 56),
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) } },
      // Severity is ORDERED, so a one-hue ramp — not three categorical colours.
      series: ordered.map((s, i) => lineSeries({
        name: s.label, color: ordinal(i, ordered.length), area: i === ordered.length - 1,
        data: s.monthly.map((m) => [m.month, m.cumulative_loss] as [string, number]),
      })),
    }
  }, [ordered, theme])

  if (!fitted) {
    return (
      <div className="p-4">
        <div className="mb-3 flex items-center gap-1">
          {(['ecl', 'macro'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`rounded-ctl px-3 py-1 text-xs font-medium transition-colors ${
                tab === t ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:text-ink-secondary'}`}>
              {t === 'ecl' ? 'Scenarios & ECL' : 'Macro variables'}
            </button>
          ))}
        </div>
        {tab === 'macro' ? <MacroPanel portfolio={portfolio} /> : (
          <Card>
            <CardHead title="Scenarios" subtitle={portfolio} />
            <EmptyState title="No fitted model to project">
This surface projects a fitted PD model forward and does not estimate one.
              Fit a PD model first. The macro variables tab is available without one.
            </EmptyState>
          </Card>
        )}
      </div>
    )
  }

  const sa = byKey.severely_adverse
  const base = byKey.baseline
  const flags = res?.extrapolation.filter((e) => e.outside) ?? []

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-1">
        {(['ecl', 'macro'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-ctl px-3 py-1 text-xs font-medium transition-colors ${
              tab === t ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:text-ink-secondary'}`}>
            {t === 'ecl' ? 'Scenarios & ECL' : 'Macro variables'}
          </button>
        ))}
      </div>

      {tab === 'macro' && <MacroPanel portfolio={portfolio} />}

      {tab === 'ecl' && (<>
      {!fittedLgd?.hash && (
        <Card>
          <div className="flex items-start gap-3 px-4 py-2.5">
            <StatusPill severity="warning">Severity model not fitted</StatusPill>
            <p className="min-w-0 flex-1 text-tiny leading-relaxed text-ink-secondary">
              These figures use the documented default LGD specification for this
              book, not one you fitted. Half of every loss number below comes from
              severity, so a projection on a substituted severity model is not the
              projection of your model.{' '}
              <button onClick={() => nav(`/${portfolio}/lgd/fit`)}
                className="font-medium text-accent underline">Fit the LGD model</button>.
            </p>
          </div>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-4 px-4 py-3">
          <div className="text-xs text-ink-secondary">
            Projecting <span className="font-medium text-ink">{fitted.name}</span>
            {' '}· PD {fitted.request.variables.length} variables,
            {' '}{fitted.request.mevs.length} macro terms
            {fittedLgd && <> · LGD {fittedLgd.spec.drivers.length +
              fittedLgd.spec.categoricals.length} drivers</>}
            {' '}· <span className="font-mono text-tiny">{fitted.hash}</span>
          </div>
          <label className="flex items-center gap-1.5 text-tiny text-ink-muted"
            title="Off by default: the projection uses the Federal Reserve's published path unmodified. When on, the forward path is winsorised to the range the model was estimated on. That keeps the projection within the observed range and also reduces the size of the shock. Both figures are reported either way.">
            <input type="checkbox" checked={capped}
              onChange={(e) => { setCapped(e.target.checked); setRes(null) }} />
            Constrain macro path to the fitted range ⓘ
          </label>
          <label className="flex items-center gap-1.5 text-tiny text-ink-muted">
            <input type="checkbox" checked={ifrs9} onChange={(e) => setIfrs9(e.target.checked)} />
            IFRS 9 staging view
          </label>
          <button onClick={() => run.mutate(undefined)} disabled={run.isPending}
            className="ml-auto rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60">
            {run.isPending ? 'Projecting…' : res ? 'Re-project' : 'Run scenarios'}
          </button>
        </div>
        {run.isPending && (
          <div className="border-t border-hairline px-4 py-2">
            <div className="flex items-center justify-between text-xs text-ink-secondary">
              <span>Fitting PD and LGD, then projecting every open account over the horizon…</span>
              <span className="text-ink-muted">about 8 seconds</span>
            </div>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-sunken">
              <div className="h-1 w-1/3 animate-[shimmer_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
            </div>
          </div>
        )}
        {run.isError && (
          <div className="border-t border-hairline px-4 py-2 text-xs"
               style={{ color: 'var(--status-critical)' }}>{String(run.error)}</div>
        )}
      </Card>

      {flags.length > 0 && (
        <div className="rounded-card border px-4 py-3"
             style={{ borderColor: 'var(--status-warning)',
                      background: 'color-mix(in srgb, var(--status-warning) 10%, transparent)' }}>
          <StatusPill severity="warning">Scenario leaves the estimation window</StatusPill>
          <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink">
            {flags.map((f) => <p key={f.key}>{f.note}</p>)}
          </div>
          {sa?.alternative_ecl != null && (
            <p className="mt-2 text-tiny leading-relaxed text-ink-secondary">
              {res?.capped ? (
                <>
                  The forward path is constrained to the estimation range, so the figure
                  above is not the Federal Reserve's published scenario. On the published
                  path, severely adverse ECL is{' '}
                  <span className="tnum text-ink">{usd(sa.alternative_ecl)}</span> against{' '}
                  <span className="tnum">{usd(sa.ecl)}</span> here, a reduction of{' '}
                  <span className="tnum">{(1 - sa.ecl / sa.alternative_ecl).toLocaleString(undefined, { style: 'percent' })}</span>.
                </>
              ) : (
                <>
                  This projection uses the Federal Reserve's published path, part of which
                  lies outside the range the model was estimated on. Constraining the path
                  to that range gives{' '}
                  <span className="tnum text-ink">{usd(sa.alternative_ecl)}</span> instead of{' '}
                  <span className="tnum">{usd(sa.ecl)}</span>, a reduction of{' '}
                  <span className="tnum">{(1 - sa.alternative_ecl / sa.ecl).toLocaleString(undefined, { style: 'percent' })}</span>.
                  The difference between the two figures indicates how much of the response
                  falls outside the estimation range.
                </>
              )}
            </p>
          )}
        </div>
      )}

      {res && sa && base && (
        <>
          <Card>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <HeroFigure
                label={`Lifetime ECL — ${ifrs9 ? 'IFRS 9 staged' : 'CECL, severely adverse'}`}
                value={usd(ifrs9 ? sa.ifrs9.total_ecl : sa.ecl)}
                sub={`${num(sa.n_accounts)} open accounts · ${usd(sa.exposure)} exposure · `
                  + `${res.horizon_months} month horizon from ${month(res.as_of)}`} />
              <div className="flex divide-x divide-hairline">
                <StatTile label="Baseline ECL" value={usd(base.ecl)}
                  explain={`${base.ecl_bps.toFixed(0)} basis points of exposure.`} />
                <StatTile label="Stress multiple" value={`${(sa.ecl / base.ecl).toFixed(2)}x`}
                  explain="Severely adverse ECL divided by baseline ECL." />
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
              <CardHead title="Cumulative expected loss over the horizon"
                subtitle="Survival-adjusted, discounted at the effective interest rate"
                caption="Scenario severity is an ordered dimension, so the scenarios take one hue from light to dark rather than separate colours." />
              <Legend items={ordered.map((s, i) => ({ name: s.label, color: ordinal(i, ordered.length) }))} />
              {projection && (
                <EChart option={projection} height={230} ariaLabel="Cumulative ECL by scenario" externalLegend
                  table={{ columns: ['Month', ...ordered.map((s) => s.label)],
                           rows: (ordered[0]?.monthly ?? []).map((m, i) =>
                             [m.month, ...ordered.map((s) => Math.round(s.monthly[i]?.cumulative_loss ?? 0))]) }} />
              )}
            </Card>
          </div>

          <Card>
            <CardHead title="Scenario comparison"
              caption="Each scenario applied to the same book at the same reporting date. Both paths are published by the Federal Reserve; a path edited in the scenario editor is marked as custom." />
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
                  <tr key={s.key} className="border-b border-hairline/40">
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
                <div className="text-micro uppercase tracking-wider text-ink-muted">IFRS 9 staging — severely adverse</div>
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

          <ScenarioEditor
            portfolio={portfolio}
            mevs={DEFAULT_MEVS[portfolio] ?? []}
            onApply={(c) => { setCustom(c); run.mutate(c) }}
            busy={run.isPending}
          />

          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHead title="Exposure at default" subtitle={`Method: ${res.ead.method}`}
                caption="The exposure assumption applied to every account, and the parameters it was estimated from. It is carried into each ECL figure on this page." />
              <div className="px-4 py-3 text-xs leading-relaxed text-ink-secondary">
                {res.ead.plain_english}
                {res.ead.ccf_note && (
                  <p className="mt-2 text-tiny text-ink-muted">{res.ead.ccf_note}</p>
                )}
              </div>
            </Card>
            <Card>
              <CardHead title="Loss given default"
                subtitle={`Fractional logit · fitted on ${num(res.lgd.n_defaults)} defaults`}
                caption="E[LGD] = sigmoid(X·β), estimated by fractional response quasi-likelihood on realised severity. Macro drivers are joined at the default month." />
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
        </>
      )}

      {!res && !run.isPending && (
        <Card>
          <EmptyState title="Not projected yet"
            action={<button onClick={() => run.mutate(undefined)}
              className="mt-2 rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white">
              Run scenarios
            </button>}>
            Projects every open account over the published supervisory horizon under
            baseline, adverse and severely adverse, and builds the attribution bridge.
          </EmptyState>
        </Card>
      )}
      </>)}
    </div>
  )
}
