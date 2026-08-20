import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { api, type EclResponse, type PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, HeroFigure, StatTile, StatusPill } from '../components/ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import Waterfall from '../charts/Waterfall'
import ScenarioEditor from '../components/ScenarioEditor'
import MacroPanel from '../components/MacroPanel'
import { baseOption, crosshairTooltip, lineSeries } from '../charts/base'
import { ink, mode, ordinal } from '../design/tokens'
import { useUi } from '../lib/store'
import { month, num, pct, usd } from '../lib/format'

const DEFAULT_MEVS: Record<string, string[]> = {
  consumer: ['unemployment_rate', 'real_disp_income_growth'],
  mortgage: ['unemployment_rate'],
  cre: ['cre_price_index_yoy', 'bbb_yield'],
}
const ORDER = ['baseline', 'adverse', 'severely_adverse']

export default function ScenarioSurface() {
  const { portfolio = 'consumer' } = useParams()
  const theme = useUi((s) => s.theme)
  const picked = useUi((s) => s.selectedVariables[portfolio as PortfolioKey] ?? [])
  const [res, setRes] = useState<EclResponse | null>(null)
  const [capped, setCapped] = useState(true)
  const [ifrs9, setIfrs9] = useState(false)
  const [custom, setCustom] = useState<Record<string, Record<string, number>>>({})
  const [weights] = useState({ baseline: 0.5, adverse: 0.3, severely_adverse: 0.2 })
  const [tab, setTab] = useState<'ecl' | 'macro'>('ecl')

  useEffect(() => { setRes(null); setCustom({}) }, [portfolio])

  const run = useMutation({
    mutationFn: (over?: Record<string, Record<string, number>>) => api.ecl({
      portfolio,
      variables: picked.map((c) => ({ column: c })),
      mevs: (DEFAULT_MEVS[portfolio] ?? []).map((k) => ({ key: k })),
      cap_to_fitted_range: capped,
      custom: over ?? custom,
      weights,
    }),
    onSuccess: setRes,
  })

  const byKey = useMemo(
    () => Object.fromEntries((res?.scenarios ?? []).map((s) => [s.key, s])), [res])
  const ordered = ORDER.filter((k) => byKey[k]).map((k) => byKey[k])

  const projection = useMemo(() => {
    if (!ordered.length) return null
    const k = ink(mode())
    return {
      ...baseOption(),
      grid: { left: 62, right: 18, top: 14, bottom: 30 },
      tooltip: crosshairTooltip((v) => usd(v), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               name: 'Cumulative expected loss', nameLocation: 'middle' as const,
               nameGap: 48, nameTextStyle: { color: k.muted, fontSize: 10 },
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) } },
      // Severity is ORDERED, so a one-hue ramp — not three categorical colours.
      series: ordered.map((s, i) => lineSeries({
        name: s.label, color: ordinal(i, ordered.length), area: i === ordered.length - 1,
        data: s.monthly.map((m) => [m.month, m.cumulative_loss] as [string, number]),
      })),
    }
  }, [ordered, theme])

  if (picked.length === 0) {
    return (
      <div className="p-4"><Card>
        <CardHead title="Scenarios" subtitle={portfolio} />
        <EmptyState title="No model to project">
          The scenario engine projects a fitted PD model forward. Select variables on
          Explore and fit on Model first.
        </EmptyState>
      </Card></div>
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
      <Card>
        <div className="flex flex-wrap items-center gap-4 px-4 py-3">
          <div className="text-xs text-ink-secondary">
            {picked.length} variables · CECL lifetime over the published horizon
          </div>
          <label className="flex items-center gap-1.5 text-tiny text-ink-muted"
            title="Winsorizes the forward macro path to the range the model was fitted on. Keeps the projection inside the evidence — and caps the stress. Both numbers are reported.">
            <input type="checkbox" checked={capped}
              onChange={(e) => { setCapped(e.target.checked); setRes(null) }} />
            Cap macro path to the fitted range ⓘ
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
          {res?.capped && sa?.uncapped_ecl != null && (
            <p className="mt-2 text-tiny text-ink-secondary">
              The macro path is currently capped to the fitted range. Uncapping it takes
              severely adverse ECL from <span className="tnum">{usd(sa.ecl)}</span> to{' '}
              <span className="tnum">{usd(sa.uncapped_ecl)}</span> —{' '}
              <span className="tnum">{(sa.uncapped_ecl / sa.ecl).toFixed(1)}x</span>, entirely
              from extrapolation rather than evidence.
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
                caption="Why the number moved. Sequential substitution: one component swapped at a time, with the residual reported rather than absorbed."
                methodology="ecl" />
              <Waterfall steps={res.bridge} reconciles={res.bridge_reconciles}
                ariaLabel="ECL attribution bridge" />
            </Card>

            <Card>
              <CardHead title="Cumulative expected loss over the horizon"
                subtitle="Survival-adjusted, discounted at the effective interest rate"
                caption="Severity is an ordered dimension, so the three scenarios take one hue light to dark rather than three separate colours." />
              <Legend items={ordered.map((s, i) => ({ name: s.label, color: ordinal(i, ordered.length) }))} />
              {projection && (
                <EChart option={projection} height={230} ariaLabel="Cumulative ECL by scenario"
                  table={{ columns: ['Month', ...ordered.map((s) => s.label)],
                           rows: (ordered[0]?.monthly ?? []).map((m, i) =>
                             [m.month, ...ordered.map((s) => Math.round(s.monthly[i]?.cumulative_loss ?? 0))]) }} />
              )}
            </Card>
          </div>

          <Card>
            <CardHead title="Scenario comparison"
              caption="Every scenario on the same book, at the same date. Published paths are marked; the derived one is labelled as derived." />
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
                        {s.published ? 'Federal Reserve' : 'derived by Helios'}
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
                caption="Stated in plain English and carried into every ECL number on this page." />
              <div className="px-4 py-3 text-xs leading-relaxed text-ink-secondary">
                {res.ead.plain_english}
                {res.ead.ccf_note && (
                  <p className="mt-2 text-tiny text-ink-muted">{res.ead.ccf_note}</p>
                )}
              </div>
            </Card>
            <Card>
              <CardHead title="Loss given default"
                subtitle={`Two-stage · fitted on ${num(res.lgd.n_defaults)} defaults`}
                caption="P(loss > 0) times E[loss | loss > 0]. The mass at exactly zero is the part a single beta model cannot represent." />
              <div className="grid grid-cols-3 divide-x divide-hairline">
                <StatTile label="Mean LGD" value={res.lgd.mean_lgd.toFixed(3)} />
                <StatTile label="Zero-loss share" value={pct(res.lgd.zero_loss_share * 100, 1)}
                  explain="Defaults that liquidated whole with no economic loss." />
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
