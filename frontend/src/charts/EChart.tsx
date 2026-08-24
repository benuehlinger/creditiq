import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import { useUi } from '../lib/store'
import { escapeHtml } from './base'

export interface TableView {
  columns: string[]
  rows: (string | number)[][]
}

/**
 * The chart container.
 *
 * Owns responsive sizing, the theme swap, PNG/SVG export at presentation
 * resolution, and the TABLE-VIEW TWIN. The table view is not an extra: a
 * tooltip must never be the only way to read a value, so every chart ships with
 * a WCAG-clean equivalent behind a toggle.
 *
 * The container height includes the x-axis band. A fixed height that excludes it
 * gives the card a tiny nested scrollbar, which is the single most common chart
 * layout bug.
 */
/** Development-only invariant check.
 *
 *  Two rules are easy to satisfy once and easy to lose on the next chart: every
 *  axis names its quantity, and two or more series carry a legend so identity is
 *  never colour-alone. Both are checked here rather than in a test that reads
 *  source text, because the option object is the thing that actually renders.
 *  Silent in production. */
function auditChart(option: EChartsOption, ariaLabel: string, externalLegend: boolean) {
  const problems: string[] = []
  const axes = (a: unknown) => (Array.isArray(a) ? a : a ? [a] : []) as any[]
  for (const [which, list] of [['x', axes(option.xAxis)], ['y', axes(option.yAxis)]] as const) {
    list.forEach((ax, i) => {
      if (ax?.show === false) return
      if (!ax?.name) problems.push(`${which}-axis${list.length > 1 ? ` #${i}` : ''} has no title`)
    })
  }
  // A `silent` series is scaffolding — the transparent stack base under a
  // waterfall, for one. It carries no identity, so it needs no legend entry.
  const named = axes(option.series).filter((sr) => sr?.name && !sr?.silent)
  if (named.length >= 2 && !externalLegend && !(option.legend as any)?.show) {
    problems.push(`${named.length} named series but no legend`)
  }
  if (problems.length) {
    console.warn(`[chart] "${ariaLabel}": ${problems.join('; ')}`)
  }
}

export default function EChart({
  option, height = 260, table, ariaLabel, refetching = false, onReady,
  externalLegend = false,
}: {
  option: EChartsOption
  height?: number
  table?: TableView
  ariaLabel: string
  /** The card draws its own <Legend/> beside the chart — the house pattern,
   *  which keeps legend text on the card surface rather than inside the plot.
   *  Tells the development-time audit that identity is already covered. */
  externalLegend?: boolean
  /** While data reloads the chart HOLDS its previous render at reduced opacity —
   *  no skeleton flash, no layout jump. */
  refetching?: boolean
  onReady?: (inst: echarts.ECharts) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const theme = useUi((s) => s.theme)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    if (!host.current) return
    inst.current = echarts.init(host.current, undefined, { renderer: 'canvas' })
    onReady?.(inst.current)
    const ro = new ResizeObserver(() => inst.current?.resize())
    ro.observe(host.current)
    return () => { ro.disconnect(); inst.current?.dispose(); inst.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (import.meta.env.DEV) auditChart(option, ariaLabel, externalLegend)
    // notMerge on a theme change, because chrome colours live all through the
    // option tree and a merge would leave the old ones in place.
    inst.current?.setOption(option, { notMerge: true })
  }, [option, theme, ariaLabel, externalLegend])

  const exportImage = (type: 'png' | 'svg') => {
    if (!inst.current) return
    const url = inst.current.getDataURL({
      type: type === 'svg' ? 'svg' : 'png',
      pixelRatio: 3, // presentation resolution — this ends up in a deck
      backgroundColor: getComputedStyle(document.documentElement)
        .getPropertyValue('--surface-chart').trim(),
    })
    const a = document.createElement('a')
    a.href = url
    a.download = `${ariaLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${type}`
    a.click()
  }

  const exportCsv = () => {
    if (!table) return
    const esc = (v: string | number) => {
      const s = String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [table.columns.map(esc).join(','),
                 ...table.rows.map((r) => r.map(esc).join(','))].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `${ariaLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`
    a.click()
  }

  return (
    <figure className="relative">
      <div
        ref={host}
        role="img"
        aria-label={ariaLabel}
        className={refetching ? 'refetching' : undefined}
        style={{ height, width: '100%', display: showTable ? 'none' : 'block' }}
      />

      {showTable && table && (
        <div className="thin-scroll overflow-auto" style={{ maxHeight: height + 40 }}>
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-hairline">
                {table.columns.map((c) => (
                  <th key={c} className="px-3 py-1.5 font-medium text-ink-secondary">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-b border-hairline/50">
                  {r.map((v, j) => (
                    <td key={j} className="px-3 py-1 text-ink-secondary">
                      {typeof v === 'number' ? v.toLocaleString() : escapeHtml(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <figcaption className="flex items-center justify-end gap-1 px-3 pb-2 pt-1">
        {table && (
          <button
            onClick={() => setShowTable((v) => !v)}
            className="rounded border border-hairline px-1.5 py-px text-micro text-ink-muted hover:text-ink"
            title="Every value in this chart, as a table"
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        )}
        {table && (
          <button onClick={exportCsv}
            className="rounded border border-hairline px-1.5 py-px text-micro text-ink-muted hover:text-ink">
            CSV
          </button>
        )}
        <button onClick={() => exportImage('png')}
          className="rounded border border-hairline px-1.5 py-px text-micro text-ink-muted hover:text-ink"
          title="PNG at 3x for a deck">
          PNG
        </button>
        <button onClick={() => exportImage('svg')}
          className="rounded border border-hairline px-1.5 py-px text-micro text-ink-muted hover:text-ink">
          SVG
        </button>
      </figcaption>
    </figure>
  )
}
