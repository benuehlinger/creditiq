import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, HeroFigure, Skeleton, StatTile, StatusPill } from '../components/ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import { baseOption, barSeries, crosshairTooltip, escapeHtml, lineSeries, markTooltip } from '../charts/base'
import { diverging, ink, mode, portfolioColor, sequential } from '../design/tokens'
import { useUi } from '../lib/store'
import { month, num, pct, usd } from '../lib/format'

const SCEN_LABEL: Record<string, string> = {
  baseline: 'Baseline', adverse: 'Adverse', severely_adverse: 'Severely adverse',
}

/**
 * The executive view. This is the screen that closes the room, so it is designed
 * as the hero: one number first, then where the number comes from.
 *
 * Colour discipline matters more here than anywhere else, because all three books
 * appear together. Portfolios take palette slots 1 to 3 — the three that clear
 * the harder all-pairs gate — and scenario severity takes an ORDINAL ramp,
 * because baseline to severely adverse is an order, not three identities.
 */
export default function RollUpSurface() {
  const nav = useNavigate()
  const theme = useUi((s) => s.theme)
  const m = mode()
  const k = ink(m)
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['rollup'], queryFn: api.rollup, staleTime: Infinity,
  })

  const contribution = useMemo(() => {
    if (!data) return null
    const scen = data.scenarios
    return {
      ...baseOption(),
      grid: { left: 66, right: 18, top: 14, bottom: 30 },
      tooltip: markTooltip((p: any) =>
        `<div style="font-size:11px;color:${k.muted}">${escapeHtml(p.name)}</div>` +
        `<div><span style="font-weight:600">${usd(p.value)}</span> ` +
        `<span style="color:${k.muted}">${escapeHtml(p.seriesName)}</span></div>`),
      xAxis: { ...(baseOption().xAxis as object), type: 'category' as const,
               data: scen.map((s) => SCEN_LABEL[s] ?? s),
               axisLabel: { color: k.muted, fontSize: 11 } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) } },
      series: data.portfolios.map((p) => barSeries({
        name: p.label, stack: 'ecl', maxWidth: 64,
        color: portfolioColor(p.portfolio, m),
        data: scen.map((s) => p.by_scenario[s]?.ecl ?? 0),
      })),
    }
  }, [data, theme])

  const projection = useMemo(() => {
    if (!data) return null
    const rows = data.monthly.filter((r) => r.scenario === 'severely_adverse')
    if (!rows.length) return null
    return {
      ...baseOption(),
      grid: { left: 66, right: 18, top: 14, bottom: 30 },
      tooltip: crosshairTooltip((v) => usd(v), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) } },
      series: data.portfolios.map((p) => ({
        ...lineSeries({ name: p.label, color: portfolioColor(p.portfolio, m), area: true,
          data: rows.map((r) => [r.month, Number(r[p.portfolio] ?? 0)] as [string, number]) }),
        stack: 'total',
        areaStyle: { color: portfolioColor(p.portfolio, m), opacity: 0.18 },
      })),
    }
  }, [data, theme])

  const tornado = useMemo(() => {
    if (!data?.tornado.length) return null
    const rows = [...data.tornado].sort((a, b) => a.delta_pct - b.delta_pct)
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.delta_pct)), 1)
    return {
      ...baseOption(),
      grid: { left: 190, right: 40, top: 10, bottom: 28 },
      tooltip: markTooltip((p: any) => {
        const r = rows[p.dataIndex]
        return `<div style="font-size:11px;color:${k.muted}">${escapeHtml(r.portfolio)} · ${escapeHtml(r.mev)}</div>` +
          `<div style="font-weight:600">${r.delta_pct >= 0 ? '+' : ''}${r.delta_pct.toFixed(1)}% of ECL</div>` +
          `<div style="font-size:11px;color:${k.secondary}">One standard deviation ${escapeHtml(r.direction)}, holding the rest of the scenario fixed. ${usd(r.delta_ecl)}.</div>`
      }),
      xAxis: { ...(baseOption().xAxis as object), type: 'value' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => `${v}%` },
               splitLine: { lineStyle: { color: 'var(--chrome-grid)', width: 1, type: 'solid' as const } } },
      yAxis: { ...(baseOption().yAxis as object), type: 'category' as const,
               data: rows.map((r) => `${r.portfolio} · ${r.mev}`),
               axisLabel: { color: k.muted, fontSize: 10 }, splitLine: { show: false } },
      series: [barSeries({
        name: 'ECL sensitivity', horizontal: true, maxWidth: 16, color: '',
        // Diverging: this is a SIGNED quantity around zero, so it takes the
        // diverging ramp rather than a categorical hue.
        data: rows.map((r) => ({ value: r.delta_pct,
          itemStyle: { color: diverging(r.delta_pct / maxAbs, m),
                       borderRadius: r.delta_pct >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] } })) as any,
      })],
    }
  }, [data, theme])

  if (isLoading) {
    return <div className="space-y-3 p-4">
      <Skeleton className="h-32" /><Skeleton className="h-64" /><Skeleton className="h-64" />
    </div>
  }
  if (isError || !data) {
    return <div className="p-4"><Card>
      <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--status-critical)' }}>
        {String(error ?? 'Roll-up unavailable')}
      </div>
    </Card></div>
  }

  const base = data.totals.baseline
  const sa = data.totals.severely_adverse
  const anyDefault = data.portfolios.some((p) => !p.from_champion)

  return (
    <div className="space-y-3 p-4">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <HeroFigure
            label="Total expected credit loss — severely adverse"
            value={usd(sa.ecl)}
            sub={`${usd(sa.exposure)} exposure across ${data.portfolios.length} portfolios · `
              + `${sa.ecl_bps.toFixed(0)} basis points · ${(sa.ecl / base.ecl).toFixed(1)}x baseline`}
          />
          <div className="flex flex-wrap divide-x divide-hairline">
            <StatTile label="Baseline ECL" value={usd(base.ecl)}
              explain={`${base.ecl_bps.toFixed(0)} basis points of exposure.`} />
            <StatTile label="Increase under stress" value={usd(sa.ecl - base.ecl)}
              explain="Severely adverse less baseline." />
            <StatTile label="Weighted 12-month PD" value={pct(sa.weighted_pd_12m * 100)}
              explain="Exposure-weighted across all three books, severely adverse." />
            <StatTile label="Weighted LGD" value={sa.weighted_lgd.toFixed(3)}
              explain="Exposure-weighted loss given default, severely adverse." />
          </div>
        </div>
        {anyDefault && (
          <div className="border-t border-hairline px-4 py-2 text-micro text-ink-muted">
            {data.note}
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="Position by portfolio"
          caption="Each book carries its accent colour throughout the workspace. Select one to open its specification." />
        <div className="grid gap-px bg-hairline sm:grid-cols-3">
          {data.portfolios.map((p) => {
            const s = p.by_scenario.severely_adverse
            const b = p.by_scenario.baseline
            const champ = data.champions[p.portfolio]
            return (
              <button key={p.portfolio}
                onClick={() => nav(champ ? `/${p.portfolio}/versions` : `/${p.portfolio}/data`)}
                className="bg-surface p-4 text-left transition-colors hover:bg-sunken">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full"
                          style={{ background: portfolioColor(p.portfolio, m) }} />
                    <span className="text-sm font-medium text-ink">{p.label}</span>
                  </span>
                  <StatusPill severity={p.from_champion ? 'good' : 'warning'}>
                    {p.from_champion ? 'champion' : 'default spec'}
                  </StatusPill>
                </div>
                <div className="mt-3 text-2xl font-semibold tracking-tight"
                     style={{ color: portfolioColor(p.portfolio, m) }}>
                  {usd(s.ecl)}
                </div>
                <div className="mt-0.5 text-tiny text-ink-muted">
                  severely adverse · {s.ecl_bps.toFixed(0)} bps · {(s.ecl / b.ecl).toFixed(1)}x baseline
                </div>
                <dl className="mt-3 space-y-1 text-tiny">
                  <Row k="Model" v={p.model_name} />
                  <Row k="Exposure" v={usd(p.exposure)} />
                  <Row k="Accounts" v={num(p.n_accounts)} />
                  <Row k="EAD method" v={p.ead_method === 'ccf'
                    ? `CCF ${p.ead_ccf ? (p.ead_ccf * 100).toFixed(0) + '%' : ''}` : 'Amortizing'} />
                </dl>
                {p.extrapolation_flags.length > 0 && (
                  <div className="mt-2">
                    <StatusPill severity="warning">
                      {p.extrapolation_flags.length} variable{p.extrapolation_flags.length === 1 ? '' : 's'} out of range
                    </StatusPill>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title="Where the loss comes from"
            subtitle="ECL by portfolio, under each scenario"
            caption="Stacked so the total is readable and the split is visible at the same time." />
          <Legend kind="rect"
            items={data.portfolios.map((p) => ({ name: p.label, color: portfolioColor(p.portfolio, m) }))} />
          {contribution && (
            <EChart option={contribution} height={230} ariaLabel="ECL by portfolio and scenario"
              table={{ columns: ['Scenario', ...data.portfolios.map((p) => p.label), 'Total'],
                       rows: data.scenarios.map((s) => [SCEN_LABEL[s] ?? s,
                         ...data.portfolios.map((p) => Math.round(p.by_scenario[s]?.ecl ?? 0)),
                         Math.round(data.totals[s]?.ecl ?? 0)]) }} />
          )}
        </Card>

        <Card>
          <CardHead title="Loss emergence under severely adverse"
            subtitle={`Cumulative, stacked by portfolio`}
            caption="When the loss actually arrives, not just how much. Survival-adjusted and discounted." />
          <Legend items={data.portfolios.map((p) => ({ name: p.label, color: portfolioColor(p.portfolio, m) }))} />
          {projection && (
            <EChart option={projection} height={230} ariaLabel="Cumulative ECL by portfolio over the horizon"
              table={{ columns: ['Month', ...data.portfolios.map((p) => p.label)],
                       rows: data.monthly.filter((r) => r.scenario === 'severely_adverse')
                         .map((r) => [String(r.month),
                           ...data.portfolios.map((p) => Math.round(Number(r[p.portfolio] ?? 0)))]) }} />
          )}
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card>
          <CardHead title="Sensitivity — which variable moves total ECL most"
            subtitle="One standard deviation in the adverse direction, holding the rest of the scenario fixed"
            caption="A partial derivative, not a scenario. In a real downturn these move together; this deliberately moves one at a time so the ranking is attributable." />
          {tornado && (
            <EChart option={tornado} height={Math.max(180, data.tornado.length * 34)}
              ariaLabel="ECL sensitivity tornado"
              table={{ columns: ['Portfolio', 'Variable', 'Shock', 'ECL change', 'ECL change (%)'],
                       rows: data.tornado.map((t) => [t.portfolio, t.mev, `1 sd ${t.direction}`,
                         Math.round(t.delta_ecl), Number(t.delta_pct.toFixed(2))]) }} />
          )}
        </Card>

        <Card>
          <CardHead title="Concentration"
            caption="Where the exposure sits, in the terms a credit committee uses." />
          <div className="space-y-4 px-4 py-3">
            {Object.entries(data.concentration).map(([p, bands]) => {
              const maxShare = Math.max(...bands.map((b) => b.share), 0.01)
              return (
                <div key={p}>
                  <div className="flex items-center gap-2 text-tiny">
                    <span className="h-2 w-2 rounded-full"
                          style={{ background: portfolioColor(p as any, m) }} />
                    <span className="text-ink-secondary">
                      {data.portfolios.find((x) => x.portfolio === p)?.label ?? p}
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {bands.map((b) => (
                      <div key={b.band} className="flex items-center gap-2">
                        <span className="w-20 shrink-0 text-right font-mono text-micro text-ink-muted">
                          {b.band}
                        </span>
                        <div className="h-3 flex-1 rounded-sm bg-sunken">
                          <div className="h-3 rounded-sm"
                               style={{ width: `${(b.share / maxShare) * 100}%`,
                                        background: sequential(0.3 + 0.6 * (b.share / maxShare), m) }} />
                        </div>
                        <span className="w-16 shrink-0 text-right tnum text-micro text-ink-secondary">
                          {usd(b.exposure)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="truncate text-ink-secondary">{v}</dd>
    </div>
  )
}
