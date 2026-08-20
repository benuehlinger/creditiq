import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type FitResponse } from '../lib/api'
import { Card, CardHead, StatTile, StatusPill } from './ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import { baseOption, crosshairTooltip, lineSeries, markLineAt } from '../charts/base'
import { accent, ink, mode, ordinal, series, status } from '../design/tokens'
import { useUi } from '../lib/store'
import { month, num, pct } from '../lib/format'

/**
 * Backtesting by performance date — the strongest section of the model surface.
 *
 * A single AUC on a random split says almost nothing about a credit model. Every
 * statistic here is per performance-date cohort, and the out-of-time boundary is
 * marked on every chart. Where the model breaks is reported, not smoothed.
 */
export default function BacktestPanel({ r, portfolio }: {
  r: FitResponse; portfolio: string
}) {
  const theme = useUi((s) => s.theme)
  const m = mode()
  const k = ink(m)
  const bt = r.backtest
  const [segCol, setSegCol] = useState<string>(bt.segment_column ?? '')

  const seg = useQuery({
    queryKey: ['seg', portfolio, r.hash, segCol],
    queryFn: () => api.segmentBacktest(portfolio, r.hash, segCol),
    enabled: !!segCol && segCol !== bt.segment_column,
  })
  const segments = segCol === bt.segment_column ? bt.segments : (seg.data?.segments ?? [])

  const actualVsPredicted = useMemo(() => {
    const c = bt.cohorts
    return {
      ...baseOption(),
      grid: { left: 52, right: 18, top: 14, bottom: 30 },
      tooltip: crosshairTooltip((v) => `${v.toFixed(2)}%`, (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               name: 'Default rate (% / yr)', nameLocation: 'middle' as const, nameGap: 38,
               nameTextStyle: { color: k.muted, fontSize: 10 },
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => `${v}%` } },
      series: [
        // The realised rate's credible band first, so the lines sit on top of it.
        { name: 'Jeffreys band', type: 'line' as const, stack: 'band', silent: true,
          showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 },
          data: c.map((x) => [x.period, x.actual_lo_annual] as [string, number]) },
        { name: 'Realised 95% band', type: 'line' as const, stack: 'band', silent: true,
          showSymbol: false, lineStyle: { opacity: 0 },
          areaStyle: { color: accent(), opacity: 0.13 },
          data: c.map((x) => [x.period, Math.max(x.actual_hi_annual - x.actual_lo_annual, 0)] as [string, number]) },
        { ...lineSeries({ name: 'Actual', color: accent(),
            data: c.map((x) => [x.period, x.actual_annual] as [string, number]) }),
          markLine: markLineAt(bt.oot_from, 'out of time →', status.serious) },
        // Slot 3 (magenta), not slot 4 (sky). Slots 1 and 4 are both blues and
        // were never validated as a PAIR — the palette's adjacent gate tests
        // 1-2, 2-3, 3-4, 4-5. Slots 1-3 clear the harder all-pairs gate, so a
        // two-series chart drawn from them is safe in both modes.
        lineSeries({ name: 'Predicted', color: series(2, m), dashed: true,
          data: c.map((x) => [x.period, x.predicted_annual] as [string, number]) }),
      ],
    }
  }, [bt, theme])

  const discrimination = useMemo(() => {
    const c = bt.cohorts.filter((x) => x.auc === x.auc)
    return {
      ...baseOption(),
      grid: { left: 44, right: 16, top: 12, bottom: 28 },
      tooltip: crosshairTooltip((v) => v.toFixed(3), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const, min: 0.5, max: 1,
               axisLabel: { color: k.muted, fontSize: 10 } },
      series: [
        { ...lineSeries({ name: 'AUC', color: accent(),
            data: c.map((x) => [x.period, x.auc] as [string, number]) }),
          markLine: markLineAt(bt.oot_from, '', status.serious) },
        lineSeries({ name: 'KS', color: series(1, m),
          data: c.map((x) => [x.period, x.ks] as [string, number]) }),
      ],
    }
  }, [bt, theme])

  const vintages = useMemo(() => {
    const v = bt.vintages.filter((x) => x.points.length > 6)
    return {
      ...baseOption(),
      grid: { left: 44, right: 16, top: 12, bottom: 30 },
      tooltip: crosshairTooltip((x) => `${x.toFixed(2)}%`, (d) => `${d} months on book`),
      xAxis: { ...(baseOption().xAxis as object), type: 'value' as const,
               name: 'Months on book', nameLocation: 'middle' as const, nameGap: 20,
               nameTextStyle: { color: k.muted, fontSize: 10 },
               axisLabel: { color: k.muted, fontSize: 10 } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               axisLabel: { color: k.muted, fontSize: 10, formatter: (x: number) => `${x}%` } },
      // Vintage is an ORDERED dimension, so it takes a one-hue ramp. Seventeen
      // categorical hues would be both illegal under the series cap and unreadable.
      series: v.map((x, i) => lineSeries({
        name: String(x.vintage), color: ordinal(i, v.length),
        data: x.points.map((p) => [p.mob, p.cumulative_default_pct] as [number, number]),
      })),
    }
  }, [bt, theme])

  const psi = useMemo(() => ({
    ...baseOption(),
    grid: { left: 40, right: 16, top: 12, bottom: 28 },
    tooltip: crosshairTooltip((v) => v.toFixed(4), (d) => month(d)),
    xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
             axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
    yAxis: { ...(baseOption().yAxis as object), type: 'value' as const, min: 0,
             max: (v: { max: number }) => Math.max(0.3, v.max * 1.15),
             axisLabel: { color: k.muted, fontSize: 10 } },
    series: [{
      ...lineSeries({ name: 'Score PSI', color: accent(),
        data: bt.score_psi.map((x) => [x.period, x.psi] as [string, number]) }),
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: k.muted, width: 1, type: [3, 3] as number[] },
        label: { color: k.muted, fontSize: 9, position: 'insideEndTop' as const },
        data: [{ yAxis: 0.10, label: { formatter: 'some shift' } },
               { yAxis: 0.25, label: { formatter: 'unstable' } }],
      },
    }],
  }), [bt, theme])

  const missed = bt.cohorts.filter((c) => !c.calibrated).length
  const aucs = bt.cohorts.map((c) => c.auc).filter((a) => a === a)
  const worstSeg = segments[0]

  return (
    <div className="space-y-3">
      <Card>
        <div className="grid grid-cols-2 divide-x divide-hairline md:grid-cols-4">
          <StatTile label="Cohorts backtested" value={String(bt.cohorts.length)}
            explain="Quarterly performance-date cohorts, each scored and compared with its realised rate." />
          <StatTile label="Calibration misses" value={`${missed} / ${bt.cohorts.length}`}
            explain="Cohorts where the predicted rate fell outside the Jeffreys 95% credible interval of the realised rate. Some misses are expected; a run of them in one direction is not."
            goodDirection="down" />
          <StatTile label="AUC range across cohorts"
            value={`${Math.min(...aucs).toFixed(3)} – ${Math.max(...aucs).toFixed(3)}`}
            explain="Discriminatory power is not one number. This is its spread across the cycle." />
          <StatTile label="Rank order held"
            value={`${(bt.rank_order.share_monotone * 100).toFixed(0)}%`}
            explain={`Share of periods in which the ${bt.rank_order.deciles} risk bands stayed in order worst-to-best. ${bt.rank_order.breaks} periods broke.`} />
        </div>
      </Card>

      <Card>
        <CardHead
          title="Actual against predicted, by performance date"
          subtitle="Quarterly · the shaded band is the Jeffreys 95% credible interval of the realised rate"
          caption="The headline backtest. The model is fitted only on months to the left of the boundary; everything to the right is a period it never saw."
          methodology="default-rate"
        />
        <Legend items={[{ name: 'Actual', color: accent() },
                        { name: 'Predicted', color: series(2, m) }]} />
        <EChart option={actualVsPredicted} height={240}
          ariaLabel="Actual against predicted default rate by performance date"
          table={{ columns: ['Period', 'Rows', 'Events', 'Actual (%/yr)', 'Predicted (%/yr)', 'Calibrated'],
                   rows: bt.cohorts.map((c) => [c.period, c.n, c.events,
                     Number(c.actual_annual.toFixed(3)), Number(c.predicted_annual.toFixed(3)),
                     c.calibrated ? 'yes' : 'no']) }} />
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title="Discriminatory power over time"
            subtitle="AUC and KS per cohort"
            caption="One AUC hides this. A model whose ranking power decays through the cycle will still show a respectable headline number." />
          <Legend items={[{ name: 'AUC', color: accent() }, { name: 'KS', color: series(1, m) }]} />
          <EChart option={discrimination} height={200} ariaLabel="AUC and KS by cohort"
            table={{ columns: ['Period', 'AUC', 'KS', 'Gini', 'Rows'],
                     rows: bt.cohorts.map((c) => [c.period, Number((c.auc || 0).toFixed(4)),
                       Number((c.ks || 0).toFixed(4)), Number((c.gini || 0).toFixed(4)), c.n]) }} />
        </Card>

        <Card>
          <CardHead title="Score stability"
            subtitle="PSI of the model's own output, against the first 12 months"
            caption="Whether the population the model scores has drifted away from the one it was fitted on." />
          <EChart option={psi} height={200} ariaLabel="Score population stability index"
            table={{ columns: ['Period', 'PSI', 'Rows'],
                     rows: bt.score_psi.map((p) => [p.period, Number((p.psi ?? 0).toFixed(4)), p.n]) }} />
        </Card>
      </div>

      <Card>
        <CardHead title="Vintage curves"
          subtitle={`Cumulative default rate by months on book · ${bt.vintages.length} origination vintages`}
          caption="Each line is one origination year, aged. Later vintages sitting above earlier ones at the same age means underwriting loosened — or the economy turned." />
        <Legend kind="line"
          items={bt.vintages.filter((x) => x.points.length > 6)
            .map((x, i, arr) => ({ name: String(x.vintage), color: ordinal(i, arr.length) }))} />
        <EChart option={vintages} height={230} ariaLabel="Vintage curves"
          table={{ columns: ['Vintage', 'Months on book', 'Cumulative default (%)', 'Rows'],
                   rows: bt.vintages.flatMap((v) => v.points.map((p) =>
                     [v.vintage, p.mob, Number(p.cumulative_default_pct.toFixed(3)), p.n])) }} />
      </Card>

      <Card>
        <CardHead
          title="Segment backtest"
          subtitle="Where does the model break?"
          caption="Finding a segment the model underperforms on, and saying so, is more persuasive than a clean chart. It is also the first thing a validator looks for."
          right={
            <select value={segCol} onChange={(e) => setSegCol(e.target.value)}
              className="rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink">
              {[bt.segment_column, 'vintage', 'terminal_event', 'status']
                .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
                .map((c) => <option key={c!} value={c!}>{c}</option>)}
            </select>
          }
        />
        {worstSeg && (
          <div className="border-b border-hairline px-4 py-2 text-xs text-ink-secondary">
            Weakest segment: <span className="font-mono text-ink">{worstSeg.segment}</span> at
            AUC {worstSeg.auc.toFixed(3)} ({worstSeg.auc_delta >= 0 ? '+' : ''}
            {worstSeg.auc_delta.toFixed(3)} against the book), predicted
            {' '}{pct(worstSeg.predicted_annual)} against {pct(worstSeg.actual_annual)} realised.
          </div>
        )}
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-hairline text-tiny text-ink-muted">
              <th className="px-4 py-2 font-medium">Segment</th>
              <th className="px-3 py-2 text-right font-medium">Rows</th>
              <th className="px-3 py-2 text-right font-medium">Events</th>
              <th className="px-3 py-2 text-right font-medium">AUC</th>
              <th className="px-3 py-2 text-right font-medium">vs book</th>
              <th className="px-3 py-2 text-right font-medium">Actual</th>
              <th className="px-3 py-2 text-right font-medium">Predicted</th>
              <th className="px-3 py-2 text-right font-medium">Bias</th>
              <th className="px-3 py-2 font-medium">Calibrated</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.segment} className="border-b border-hairline/40">
                <td className="px-4 py-1.5 font-mono text-tiny text-ink">{s.segment}</td>
                <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{num(s.n)}</td>
                <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{num(s.events)}</td>
                <td className="px-3 py-1.5 text-right tnum text-ink">{s.auc.toFixed(3)}</td>
                <td className="px-3 py-1.5 text-right tnum"
                    style={{ color: s.auc_delta < -0.03 ? 'var(--status-warning)' : 'var(--ink-secondary)' }}>
                  {s.auc_delta >= 0 ? '+' : ''}{s.auc_delta.toFixed(3)}
                </td>
                <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{pct(s.actual_annual)}</td>
                <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{pct(s.predicted_annual)}</td>
                <td className="px-3 py-1.5 text-right tnum"
                    style={{ color: Math.abs(s.bias_pct) > 15 ? 'var(--status-warning)' : 'var(--ink-secondary)' }}>
                  {s.bias_pct >= 0 ? '+' : ''}{s.bias_pct.toFixed(1)}%
                </td>
                <td className="px-3 py-1.5">
                  <StatusPill severity={s.calibrated ? 'good' : 'warning'}>
                    {s.calibrated ? 'within band' : 'outside band'}
                  </StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
