import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill } from './ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import { baseOption, crosshairTooltip, lineSeries, markLineAt, xName, yName, gridFor } from '../charts/base'
import { ink, mode, ordinal, status } from '../design/tokens'
import { month } from '../lib/format'
import { useUi } from '../lib/store'

/**
 * Event rate over time, by bin — and population stability beside it.
 *
 * A single bad-rate-by-bin chart says a variable separates. It cannot say
 * whether it separates CONSISTENTLY. A variable whose bins cross over, or whose
 * population drifts out of the bins it was fitted on, will pass every static
 * screen and then fail in production. Showing this at SELECTION time is the
 * point — by the time anyone usually looks, the model is already built.
 *
 * The bins are ORDINAL, not categorical: bin 1 to bin 8 is an order, so they take
 * a one-hue ramp and the reader sees the ordering in the colour. Eight
 * categorical hues here would be both illegal under the series cap and wrong.
 */
export default function BinStability({ portfolio, column, edges }: {
  portfolio: string; column: string; edges?: number[]
}) {
  const theme = useUi((s) => s.theme)
  const biv = useQuery({
    queryKey: ['biv', portfolio, column, edges?.join(',')],
    queryFn: () => api.bivariate(portfolio, column, edges),
  })
  const psi = useQuery({
    queryKey: ['psi', portfolio, column],
    queryFn: () => api.psi(portfolio, column),
  })

  const { option, legend, table } = useMemo(() => {
    if (!biv.data) return { option: null, legend: [], table: undefined }
    const k = ink(mode())
    const order = biv.data.bins.filter((b) => b !== 'Missing')
    const present = order.filter((b) => biv.data!.points.some((p) => p.bin === b))
    const series = present.map((b, i) => {
      const pts = biv.data!.points.filter((p) => p.bin === b)
        .map((p) => [p.period, p.rate] as [string, number])
      return lineSeries({ name: b, data: pts, color: ordinal(i, present.length) })
    })
    return {
      option: {
        ...baseOption(),
        grid: gridFor({ left: 58, right: 14, top: 10, bottom: 44 }),
        tooltip: crosshairTooltip((v) => `${v.toFixed(2)}%`, (d) => month(d)),
        xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
                 ...xName('Performance quarter', 26),
                 axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
        yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
                 ...yName('Event rate (% / yr)', 40),
                 axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => `${v}%` } },
        series: series.map((s, i) =>
          i === 0 ? { ...s, markLine: markLineAt('2020-03-01', '', status.serious) } : s),
      },
      legend: present.map((b, i) => ({ name: b, color: ordinal(i, present.length) })),
      table: {
        columns: ['Period', 'Bin', 'Rows', 'Annualized rate (%)'],
        rows: biv.data.points.map((p) => [p.period, p.bin, p.n, Number(p.rate.toFixed(3))]),
      },
    }
  }, [biv.data, theme])

  const psiOption = useMemo(() => {
    if (!psi.data?.points.length) return null
    const k = ink(mode())
    const pts = psi.data.points.map((p) => [p.period, p.psi] as [string, number])
    return {
      ...baseOption(),
      grid: gridFor({ left: 54, right: 14, top: 10, bottom: 44 }),
      tooltip: crosshairTooltip((v) => v.toFixed(4), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               ...xName('Performance quarter', 26),
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName('PSI', 38),
               axisLabel: { color: k.muted, fontSize: 10 } },
      series: [{
        ...lineSeries({ name: 'PSI', data: pts, color: 'var(--accent)' }),
        // 0.10 and 0.25 are the conventional action bands, drawn so the reader
        // does not have to remember them.
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: k.muted, width: 1, type: [3, 3] as number[] },
          label: { color: k.muted, fontSize: 9, position: 'insideEndTop' as const },
          data: [{ yAxis: 0.10, label: { formatter: 'some shift 0.10' } },
                 { yAxis: 0.25, label: { formatter: 'unstable 0.25' } }],
        },
      }],
    }
  }, [psi.data, theme])

  const worstPsi = Math.max(0, ...(psi.data?.points ?? []).map((p) => p.psi || 0))

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <Card>
        <CardHead
          title="Event rate over time, by bin"
          subtitle={`${column} · quarterly · cells under 250 account-months are dropped as unestimable`}
          caption="Event rate per bin, by period. Bins that hold their rank order separate the population consistently. Lines that cross indicate the variable discriminates in some periods and not others."
        />
        {biv.isLoading || !option ? <Skeleton className="h-[200px]" /> : (
          <>
            <Legend items={legend} kind="line" />
            <EChart option={option} height={196} table={table}
                    ariaLabel={`${column} event rate over time by bin`}
                    externalLegend
                    refetching={biv.isFetching && !biv.isLoading} />
          </>
        )}
      </Card>

      <Card>
        <CardHead
          title="Population stability"
          subtitle={`PSI against the first 12 months`}
          caption="Population stability index against the first twelve months. It measures whether the distribution of the variable across its bins has moved since the model was fitted."
          right={
            <StatusPill severity={worstPsi > 0.25 ? 'critical' : worstPsi > 0.10 ? 'warning' : 'good'}>
              max {worstPsi.toFixed(3)}
            </StatusPill>
          }
        />
        {psi.isLoading || !psiOption ? <Skeleton className="h-[200px]" /> : (
          <EChart option={psiOption} height={196}
                  ariaLabel={`${column} population stability index over time`}
                  table={{
                    columns: ['Period', 'PSI', 'Rows'],
                    rows: (psi.data?.points ?? []).map((p) => [p.period, Number((p.psi ?? 0).toFixed(4)), p.n]),
                  }} />
        )}
      </Card>
    </div>
  )
}
