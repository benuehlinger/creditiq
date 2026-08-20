import { useMemo } from 'react'
import EChart from './EChart'
import { baseOption, escapeHtml } from './base'
import { ink, mode, status } from '../design/tokens'
import { usd } from '../lib/format'

/**
 * The ECL attribution bridge.
 *
 * A waterfall is the right form here because the reader's job is to follow a
 * SEQUENCE of changes from one total to another. Colour is STATUS, not
 * categorical: a step that raises expected loss is a risk increase and wears the
 * critical token; a step that reduces it wears the good token; the two endpoints
 * are neutral totals. That is the one case where a series colour would be wrong —
 * these bars mean good and bad, they are not identities.
 *
 * The invisible base segment is what makes a bar float. It carries no meaning and
 * is excluded from the tooltip and the table view.
 */
export default function Waterfall({ steps, reconciles, ariaLabel }: {
  steps: { label: string; value: number; running: number; kind: string; note: string }[]
  reconciles: { ok: boolean; residual: number }
  ariaLabel: string
}) {
  const m = mode()
  const k = ink(m)

  const option = useMemo(() => {
    const bases: number[] = []
    const bars: number[] = []
    const colors: string[] = []
    steps.forEach((s, i) => {
      if (s.kind === 'total') {
        bases.push(0); bars.push(s.value); colors.push(k.muted)
      } else {
        const prev = steps[i - 1].running
        bases.push(Math.min(prev, s.running))
        bars.push(Math.abs(s.value))
        colors.push(s.value >= 0 ? status.critical : status.good)
      }
    })
    return {
      ...baseOption(),
      grid: { left: 62, right: 18, top: 16, bottom: 56 },
      tooltip: {
        ...(baseOption().tooltip as object),
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        formatter: (ps: any) => {
          const p = (Array.isArray(ps) ? ps : [ps]).find((x: any) => x.seriesName === 'step')
          if (!p) return ''
          const s = steps[p.dataIndex]
          return `<div style="max-width:280px"><div style="font-size:11px;color:${k.muted}">${escapeHtml(s.label)}</div>` +
            `<div style="font-weight:600;font-size:13px">${s.kind === 'total' ? usd(s.value) : (s.value >= 0 ? '+' : '−') + usd(Math.abs(s.value))}</div>` +
            (s.note ? `<div style="font-size:11px;color:${k.secondary};margin-top:4px;white-space:normal">${escapeHtml(s.note)}</div>` : '') +
            `</div>`
        },
      },
      xAxis: {
        ...(baseOption().xAxis as object), type: 'category' as const,
        data: steps.map((s) => s.label),
        axisLabel: { color: k.muted, fontSize: 10, interval: 0, width: 90,
                     overflow: 'break' as const, lineHeight: 12 },
      },
      yAxis: {
        ...(baseOption().yAxis as object), type: 'value' as const,
        axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) },
      },
      series: [
        { name: 'base', type: 'bar' as const, stack: 'w', data: bases, silent: true,
          itemStyle: { color: 'transparent' }, barMaxWidth: 46 },
        { name: 'step', type: 'bar' as const, stack: 'w', data: bars, barMaxWidth: 46,
          itemStyle: {
            color: (p: any) => colors[p.dataIndex],
            borderRadius: [3, 3, 0, 0],
            // 2px surface gap so touching bars separate without a stroke
            borderColor: 'var(--surface-chart)', borderWidth: 2,
          },
          label: {
            show: true, position: 'top' as const, fontSize: 10, color: k.secondary,
            formatter: (p: any) => {
              const s = steps[p.dataIndex]
              return s.kind === 'total' ? usd(s.value)
                : `${s.value >= 0 ? '+' : '−'}${usd(Math.abs(s.value))}`
            },
          },
        },
      ],
    }
  }, [steps, m])

  return (
    <>
      <EChart option={option} height={260} ariaLabel={ariaLabel}
        table={{ columns: ['Step', 'Contribution', 'Running total'],
                 rows: steps.map((s) => [s.label, Math.round(s.value), Math.round(s.running)]) }} />
      <p className="px-4 pb-2 text-micro"
         style={{ color: reconciles.ok ? 'var(--ink-muted)' : 'var(--status-critical)' }}>
        {reconciles.ok
          ? `The steps reconcile to the total exactly (residual ${reconciles.residual.toExponential(1)}). No plug.`
          : `Bridge does not reconcile — residual ${usd(reconciles.residual)}.`}
      </p>
    </>
  )
}
