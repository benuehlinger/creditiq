import type { EChartsOption } from 'echarts'
import { chrome, ink, marks, mode, surfaces } from '../design/tokens'

/** The chart chrome every CreditIQ chart shares.
 *
 *  These are the dataviz mark specs, applied once here instead of remembered at
 *  each call site: hairline SOLID gridlines one step off the surface (never
 *  dashed — dashing reads as "projection" when it is just a grid), recessive
 *  axes, and text in ink tokens rather than the series colour.
 */
export function baseOption(): EChartsOption {
  const m = mode()
  const k = ink(m)
  const c = chrome(m)
  const s = surfaces(m)

  return {
    backgroundColor: 'transparent',
    animationDuration: 320,
    animationEasing: 'cubicOut',
    textStyle: {
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      color: k.secondary,
      fontSize: 11,
    },
    grid: { left: 56, right: 20, top: 16, bottom: 34, containLabel: false },
    xAxis: {
      axisLine: { lineStyle: { color: c.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: { color: k.muted, fontSize: 11, margin: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: k.muted, fontSize: 11, margin: 10 },
      // Hairline, solid, one step off the surface. Recessive by design.
      splitLine: { lineStyle: { color: c.grid, width: marks.gridWidth, type: 'solid' } },
    },
    tooltip: {
      backgroundColor: s.raised,
      borderColor: c.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: k.primary, fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 28px rgba(0,0,0,0.28); border-radius: 8px;',
    },
    legend: {
      show: false, // switched on explicitly whenever there are two or more series
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 3,
      itemGap: 14,
      textStyle: { color: k.secondary, fontSize: 11 },
    },
  }
}

/** Crosshair tooltip for line and area charts.
 *
 *  The reader aims at a DATE, never at a 2px line, and one readout lists every
 *  series at that x — so the pointer never has to land on a stroke to get a
 *  value. */
export function crosshairTooltip(
  formatValue: (v: number) => string,
  formatAxis?: (v: string) => string,
) {
  const m = mode()
  const c = chrome(m)
  const k = ink(m)
  return {
    trigger: 'axis' as const,
    axisPointer: {
      type: 'line' as const,
      lineStyle: { color: c.axis, width: 1, type: 'solid' as const },
      snap: true,
    },
    formatter: (params: any) => {
      const arr = Array.isArray(params) ? params : [params]
      if (!arr.length) return ''
      const head = formatAxis ? formatAxis(arr[0].axisValue) : arr[0].axisValue
      const rows = arr
        .filter((p: any) => p.value != null && p.value[1] != null)
        .map((p: any) => {
          const v = Array.isArray(p.value) ? p.value[1] : p.value
          // Value leads, series name follows — the reader already has the series
          // and wants the number. A short stroke keys identity, not a filled box.
          return (
            `<div style="display:flex;align-items:center;gap:8px;margin-top:3px">` +
            `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${p.color}"></span>` +
            `<span style="font-variant-numeric:tabular-nums;font-weight:600;color:${k.primary}">${formatValue(v)}</span>` +
            `<span style="color:${k.muted};margin-left:auto">${escapeHtml(p.seriesName)}</span>` +
            `</div>`
          )
        })
        .join('')
      return `<div style="font-size:11px;color:${k.muted}">${escapeHtml(head)}</div>${rows}`
    },
  }
}

/** Per-mark tooltip for bars, cells and dots. No crosshair — the mark IS the hit
 *  target, and the hovered mark lifts so the reader sees it respond. */
export function markTooltip(format: (p: any) => string) {
  return { trigger: 'item' as const, formatter: (p: any) => format(p) }
}

/** Series and category names arrive from CSV headers and API responses. They are
 *  untrusted text and go into tooltip DOM escaped, never concatenated raw. */
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

/** Line series with the fixed mark spec: 2px, round join, markers at or above
 *  8px, and a 10% area wash where an area is wanted (never a saturated block). */
export function lineSeries(opts: {
  name: string
  data: [string | number, number | null][]
  color: string
  area?: boolean
  dashed?: boolean
  width?: number
  showSymbol?: boolean
  emphasisLift?: boolean
}) {
  const m = mode()
  const s = surfaces(m)
  return {
    name: opts.name,
    type: 'line' as const,
    data: opts.data,
    smooth: false,
    showSymbol: opts.showSymbol ?? false,
    symbolSize: marks.markerMinSize,
    // A surface-coloured ring keeps a marker legible where it crosses a line.
    itemStyle: { color: opts.color, borderColor: s.chart, borderWidth: marks.surfaceRing },
    lineStyle: {
      color: opts.color,
      width: opts.width ?? marks.lineWidth,
      cap: 'round' as const,
      join: 'round' as const,
      ...(opts.dashed ? { type: [5, 4] as number[] } : {}),
    },
    areaStyle: opts.area ? { color: opts.color, opacity: marks.areaOpacity } : undefined,
    emphasis: opts.emphasisLift === false ? undefined : { focus: 'series' as const },
  }
}

/** Bar series with the fixed mark spec: capped thickness so the band keeps its
 *  air, a 4px rounded data end square at the baseline, and a 2px surface gap
 *  doing the separating instead of a stroke around the mark. */
export function barSeries(opts: {
  name: string
  data: (number | null)[] | [string | number, number][]
  color: string | ((p: any) => string)
  horizontal?: boolean
  stack?: string
  maxWidth?: number
}) {
  const m = mode()
  const s = surfaces(m)
  const r = marks.barRadius
  return {
    name: opts.name,
    type: 'bar' as const,
    data: opts.data,
    stack: opts.stack,
    barMaxWidth: opts.maxWidth ?? marks.barMaxThickness,
    itemStyle: {
      color: opts.color as any,
      borderRadius: opts.horizontal ? [0, r, r, 0] : [r, r, 0, 0],
      // The gap is drawn in the surface colour, so touching marks separate
      // without any extra data-weight ink.
      borderColor: s.chart,
      borderWidth: opts.stack ? marks.surfaceGap : 0,
    },
    emphasis: { itemStyle: { opacity: 0.86 } },
  }
}

/** A vertical rule with a label. Used for the out-of-time boundary and for the
 *  history-to-scenario seam, both of which must be annotated rather than hidden. */
export function markLineAt(x: string | number, label: string, color?: string) {
  const m = mode()
  const k = ink(m)
  return {
    silent: true,
    symbol: 'none' as const,
    lineStyle: { color: color ?? k.muted, width: 1, type: [4, 4] as number[] },
    label: {
      formatter: label,
      position: 'insideEndTop' as const,
      color: k.muted,
      fontSize: 10,
      padding: [0, 0, 4, 4],
    },
    data: [{ xAxis: x }],
  }
}
