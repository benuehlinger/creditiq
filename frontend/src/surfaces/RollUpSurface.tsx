import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, HeroFigure, Skeleton, StatTile, StatusPill } from '../components/ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import { baseOption, barSeries, crosshairTooltip, escapeHtml, lineSeries, markTooltip, xName, yName, gridFor } from '../charts/base'
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
  // Which saved model each book is reported on, held in the URL so a comparison
  // is linkable and survives a reload. Empty means the champion, or the
  // documented default where no champion has been promoted.
  const [params, setParams] = useSearchParams()
  const selection = useMemo(() => Object.fromEntries(
    (params.get('select') ?? '').split(',').filter((x) => x.includes(':'))
      .map((x) => x.split(':', 2) as [string, string])), [params])
  const setSelection = (next: Record<string, string>) => {
    const q = Object.entries(next).filter(([, v]) => v)
      .map(([k, v]) => `${k}:${v}`).sort().join(',')
    setParams(q ? { select: q } : {}, { replace: true })
  }
  const selKey = Object.entries(selection).filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`).sort().join(',')

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['rollup', selKey],
    queryFn: () => api.rollup(selection),
    staleTime: Infinity, placeholderData: (prev) => prev,
  })
  // The adopted position, always available for comparison. Cached server-side,
  // so this costs nothing once it has been run.
  const adopted = useQuery({
    queryKey: ['rollup', ''], queryFn: () => api.rollup({}), staleTime: Infinity,
  })

  const contribution = useMemo(() => {
    if (!data) return null
    const scen = data.scenarios
    return {
      ...baseOption(),
      grid: gridFor({ left: 78, right: 18, top: 14, bottom: 46 }),
      tooltip: markTooltip((p: any) =>
        `<div style="font-size:11px;color:${k.muted}">${escapeHtml(p.name)}</div>` +
        `<div><span style="font-weight:600">${usd(p.value)}</span> ` +
        `<span style="color:${k.muted}">${escapeHtml(p.seriesName)}</span></div>`),
      xAxis: { ...(baseOption().xAxis as object), type: 'category' as const,
               data: scen.map((s) => SCEN_LABEL[s] ?? s),
               ...xName('Supervisory scenario', 28),
               axisLabel: { color: k.muted, fontSize: 11 } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName('Lifetime ECL (USD)', 60),
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
      grid: gridFor({ left: 78, right: 18, top: 14, bottom: 46 }),
      tooltip: crosshairTooltip((v) => usd(v), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               ...xName('Projection month', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName('Cumulative ECL (USD)', 60),
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
      grid: gridFor({ left: 190, right: 40, top: 10, bottom: 46 }),
      tooltip: markTooltip((p: any) => {
        const r = rows[p.dataIndex]
        return `<div style="font-size:11px;color:${k.muted}">${escapeHtml(r.portfolio)} · ${escapeHtml(r.mev)}</div>` +
          `<div style="font-weight:600">${r.delta_pct >= 0 ? '+' : ''}${r.delta_pct.toFixed(1)}% of ECL</div>` +
          `<div style="font-size:11px;color:${k.secondary}">One standard deviation ${escapeHtml(r.direction)}, holding the rest of the scenario fixed. ${usd(r.delta_ecl)}.</div>`
      }),
      xAxis: { ...(baseOption().xAxis as object), type: 'value' as const,
               ...xName('Change in lifetime ECL (%)', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => `${v}%` },
               splitLine: { lineStyle: { color: 'var(--chrome-grid)', width: 1, type: 'solid' as const } } },
      yAxis: { ...(baseOption().yAxis as object), type: 'category' as const,
               data: rows.map((r) => `${r.portfolio} · ${r.mev}`),
               ...yName('Variable', 178),
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
  const anyDefault = data.portfolios.some((p) => p.source === 'default')
  const adoptedTotal = adopted.data?.totals?.severely_adverse?.ecl
  const shownTotal = data.totals?.severely_adverse?.ecl
  const delta = !data.is_adopted && adoptedTotal && shownTotal
    ? shownTotal - adoptedTotal : null

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
              explain="Cumulative probability of default over the first twelve months, exposure-weighted across all three books, under severely adverse. It covers a quarter of the horizon: the supervisory path troughs in quarters six to eight, so this understates the stress the ECL figure reflects." />
            <StatTile label="Weighted LGD, first 12 months" value={sa.weighted_lgd.toFixed(3)}
              explain="Mean predicted severity over the first twelve months, exposure-weighted, under severely adverse. Like the PD beside it this is a 12-month figure against a 39-month ECL, so the two do not multiply out to the stress multiple." />
          </div>
        </div>
        {anyDefault && (
          <div className="border-t border-hairline px-4 py-2 text-micro text-ink-muted">
            {data.note}
          </div>
        )}
      </Card>

      {/* Which models produced the number above. Placed before the portfolio
          cards because it qualifies every figure on the page. */}
      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          {data.is_adopted ? (
            <StatusPill severity="good">Adopted models</StatusPill>
          ) : (
            <StatusPill severity="warning">Selected set — not the adopted position</StatusPill>
          )}
          <span className="min-w-0 flex-1 text-tiny leading-relaxed text-ink-secondary">
            {data.is_adopted
              ? 'Each book is reported on its promoted champion, or on the documented default specification where no champion exists.'
              : 'One or more books are reported on a model that is not their champion. This is a comparison, not the position the firm holds.'}
          </span>
          {delta != null && (
            <span className="text-tiny text-ink-secondary">
              Severely adverse{' '}
              <span className="tnum font-medium text-ink">
                {delta > 0 ? '+' : '−'}{usd(Math.abs(delta))}
              </span>{' '}
              against the adopted set ({usd(adoptedTotal!)})
            </span>
          )}
          {!data.is_adopted && (
            <button onClick={() => setSelection({})}
              className="rounded-ctl border border-hairline px-2 py-1 text-tiny text-ink-secondary hover:text-ink">
              Reset to adopted
            </button>
          )}
          {isFetching && <span className="text-tiny text-ink-muted">re-projecting…</span>}
        </div>
        <div className="grid gap-px border-t border-hairline bg-hairline sm:grid-cols-3">
          {data.portfolios.map((p) => {
            const options = data.available[p.portfolio] ?? []
            return (
              <div key={p.portfolio} className="bg-surface px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full"
                        style={{ background: portfolioColor(p.portfolio, m) }} />
                  <span className="text-tiny font-medium text-ink">{p.label}</span>
                  {p.source === 'selected' && (
                    <span className="text-micro text-accent">selected</span>
                  )}
                  {p.sign_flips.length > 0 && (
                    <span className="text-micro" style={{ color: 'var(--status-critical)' }}
                          title={`${p.sign_flips.map((f) => f.replace('mev:', '')).join(', ')} fits against its economic prior in this specification. A macro term with the wrong sign moves the projection the wrong way under stress.`}>
                      sign flip
                    </span>
                  )}
                  {!p.data_is_current && (
                    <span className="text-micro" style={{ color: 'var(--status-warning)' }}
                          title="This version was fitted on a panel that no longer exists. The specification is replayed against the current data, so the figures here are current; the metrics stored with the version are not.">
                      stale data
                    </span>
                  )}
                </div>
                <select
                  value={p.version_hash ?? ''}
                  onChange={(e) => setSelection({ ...selection, [p.portfolio]: e.target.value })}
                  className="mt-1.5 w-full rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink">
                  <option value="">
                    {p.champion_hash
                      ? `Champion — ${p.champion_name}`
                      : 'Documented default specification'}
                  </option>
                  {options.map((v) => (
                    <option key={v.hash} value={v.hash}>
                      {v.name}{v.status === 'champion' ? ' · champion' : ''}
                      {v.data_is_current ? '' : ' · stale data'}
                      {v.auc_test ? ` · AUC ${v.auc_test.toFixed(3)}` : ''}
                    </option>
                  ))}
                </select>
                <p className="mt-1 font-mono text-micro text-ink-muted">
                  {p.model_hash}
                </p>
              </div>
            )
          })}
        </div>
        {!data.is_adopted && (
          <p className="border-t border-hairline px-4 py-2 text-micro leading-relaxed text-ink-muted">
            A selected set answers "what would the allowance be under this model".
            It is not the allowance. Promote a version on its book's Versions
            surface to make it the adopted model.
          </p>
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
                  <StatusPill severity={p.source === 'champion' ? 'good'
                    : p.source === 'selected' ? 'serious' : 'warning'}>
                    {p.source === 'champion' ? 'champion'
                      : p.source === 'selected' ? 'selected' : 'default spec'}
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
            <EChart option={contribution} height={230} ariaLabel="ECL by portfolio and scenario" externalLegend
              table={{ columns: ['Scenario', ...data.portfolios.map((p) => p.label), 'Total'],
                       rows: data.scenarios.map((s) => [SCEN_LABEL[s] ?? s,
                         ...data.portfolios.map((p) => Math.round(p.by_scenario[s]?.ecl ?? 0)),
                         Math.round(data.totals[s]?.ecl ?? 0)]) }} />
          )}
        </Card>

        <Card>
          <CardHead title="Loss emergence under severely adverse"
            subtitle={`Cumulative, stacked by portfolio`}
            caption="The timing of expected loss across the horizon, survival-adjusted and discounted at the effective interest rate." />
          <Legend items={data.portfolios.map((p) => ({ name: p.label, color: portfolioColor(p.portfolio, m) }))} />
          {projection && (
            <EChart option={projection} height={230} ariaLabel="Cumulative ECL by portfolio over the horizon" externalLegend
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
            caption="Each macro variable moved one standard deviation with all others held. In an actual downturn these variables move together, so this is a sensitivity ranking rather than a scenario." />
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
            subtitle="Drawn balances at the latest performance date"
            caption="Where the exposure sits, in the terms a credit committee uses. This is a property of the BOOK, not of a model, so it does not move when the adopted model above is changed — swapping a probability-of-default specification does not relocate a dollar of exposure. The bands total to the exposure on each portfolio's card." />
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
