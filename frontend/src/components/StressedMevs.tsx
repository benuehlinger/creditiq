import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { ModelPathSeries } from '../lib/api'
import { Card, CardHead, Skeleton } from './ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import { baseOption, crosshairTooltip, gridFor } from '../charts/base'
import { ink, mode, ordinal } from '../design/tokens'
import { useUi } from '../lib/store'

/**
 * The macro terms of a specification, as the projection consumes them.
 *
 * This replaced the scenario editor on the scenario stage. The editor showed
 * raw supervisory variables that could be dragged; what the reader actually
 * needs is the opposite of an input — a statement of what was USED: each term
 * in the fitted specification (transformed and lagged exactly as it enters the
 * model), its history up to the projection date, and the two forward branches
 * the projection walks. The divergence at the seam IS the stress.
 *
 * Small multiples with ONE grammar, stated once: a single legend on the card
 * head, no per-chart export chips, the variable's published name over each
 * chart with its transform beneath in small type — the mono slug lives on the
 * hover, where an identifier belongs.
 */

/** How a term enters the model, in words. The canonical slug stays on hover. */
const TRANSFORM_WORDS: Record<string, string> = {
  level: 'Level', diff: '1-month change', four_quarter_change: '12-month change',
  yoy: '12-month % change', qoq_annualized: '3-month change, annualised',
  ma3: '3-month average', ma6: '6-month average', ma12: '12-month average',
  yoy_ma3: '12-month % change, 3-month average',
  diff_ma3: '1-month change, 3-month average', z_score: 'z-score',
}
function entersAs(s: ModelPathSeries): string {
  const t = TRANSFORM_WORDS[s.transform] ?? s.transform
  return s.lag_months ? `${t} · lagged ${s.lag_months} months` : t
}

/** The one legend all the small multiples share. */
export function MevLegend() {
  const k = ink(mode())
  return <Legend items={[
    { name: 'History', color: k.muted },
    { name: 'Supervisory Baseline', color: ordinal(0, 2) },
    { name: 'Supervisory Severely Adverse', color: ordinal(1, 2) },
  ]} />
}

export function MevPathGrid({ terms, height = 120, tags }: {
  terms: string[]
  height?: number
  /** Which books carry each term, for the roll-up. A term shared by two books
   *  is ONE exposure seen twice, so it renders once with both dots — that is
   *  information (a common factor), and it is also what keeps the grid dense. */
  tags?: Record<string, { color: string; label: string }[]>
}) {
  const theme = useUi((s) => s.theme)
  const q = useQuery({
    queryKey: ['mevpaths', terms.slice().sort().join(',')],
    queryFn: () => api.modelPaths(terms),
    enabled: terms.length > 0,
    staleTime: Infinity,
  })

  const charts = useMemo(() => {
    if (!q.data) return null
    const m = mode()
    const k = ink(m)
    return q.data.series.map((s: ModelPathSeries) => {
      const lastHist = s.history.at(-1)
      // Each forward branch starts from the last actual point, so the lines
      // are continuous through the seam rather than floating loose of it.
      const branch = (pts: { date: string; value: number }[]) =>
        lastHist ? [[lastHist.date, lastHist.value] as [string, number],
                    ...pts.map((p) => [p.date, p.value] as [string, number])]
                 : pts.map((p) => [p.date, p.value] as [string, number])
      const fmt = (v: number) => `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${s.unit === '%' ? '%' : ''}`
      const option = {
        ...baseOption(),
        grid: gridFor({ left: 42, right: 6, top: 8, bottom: 20 }),
        tooltip: crosshairTooltip((v) => fmt(v), (d) => String(d).slice(0, 7)),
        xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
                 axisLabel: { color: k.muted, fontSize: 9, formatter: '{yyyy}' } },
        yAxis: { ...(baseOption().yAxis as object), type: 'value' as const, scale: true,
                 axisLabel: { color: k.muted, fontSize: 9, formatter: (v: number) => fmt(v) } },
        series: [
          { type: 'line' as const, name: 'History', symbol: 'none', z: 1,
            lineStyle: { color: k.muted, width: 1.25 },
            data: s.history.map((p) => [p.date, p.value] as [string, number]) },
          { type: 'line' as const, name: 'Supervisory Baseline', symbol: 'none', z: 2,
            lineStyle: { color: ordinal(0, 2), width: 1.75 },
            data: branch(s.baseline) },
          { type: 'line' as const, name: 'Supervisory Severely Adverse', symbol: 'none', z: 3,
            lineStyle: { color: ordinal(1, 2), width: 1.75 },
            // The seam, marked once per chart on the branch drawn last.
            markLine: lastHist ? {
              symbol: 'none', silent: true, label: { show: false },
              lineStyle: { color: k.muted, width: 1, type: 'dashed' as const, opacity: 0.5 },
              data: [{ xAxis: lastHist.date }],
            } : undefined,
            data: branch(s.severely_adverse) },
        ],
      }
      // The break-off in figures: where each branch takes the series, stated
      // as its most extreme point so the chart's story survives as a number.
      const dev = (pts: { value: number }[]) => {
        if (!pts.length || !lastHist) return null
        return pts.reduce((a, b) =>
          Math.abs(b.value - lastHist.value) > Math.abs(a.value - lastHist.value) ? b : a).value
      }
      return { s, option, fmt, now: lastHist?.value ?? null,
               base: s.baseline.at(-1)?.value ?? null, severe: dev(s.severely_adverse) }
    })
  }, [q.data, theme])

  if (q.isLoading) {
    return <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
      {terms.map((t) => <Skeleton key={t} className="h-44" />)}
    </div>
  }
  if (!charts?.length) {
    return <p className="px-4 py-6 text-center text-xs text-ink-muted">
      This specification carries no macro terms, so the projection does not respond to a scenario.
    </p>
  }
  return (
    <div className="grid gap-x-6 gap-y-5 px-4 pb-4 pt-3"
         style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
      {charts.map(({ s, option, fmt, now, base, severe }) => (
        <figure key={s.term} className="min-w-0" title={s.term}>
          <figcaption className="mb-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs font-semibold text-ink">{s.label}</span>
              {tags?.[s.term] && (
                <span className="flex shrink-0 items-center gap-1.5"
                      title={tags[s.term].map((t) => t.label).join(' · ')}>
                  {tags[s.term].map((t) => (
                    <span key={t.label} className="h-1.5 w-1.5 rounded-full"
                          style={{ background: t.color }} />
                  ))}
                </span>
              )}
            </div>
            <div className="text-micro text-ink-muted">
              {entersAs(s)}
              {tags?.[s.term] && (
                <span> · {tags[s.term].map((t) => t.label).join(' · ')}</span>
              )}
            </div>
          </figcaption>
          <EChart option={option} height={height} compact
                  ariaLabel={`${s.label} under both scenarios`} externalLegend />
          {/* The break-off, in the same three words on every chart, so the
              grid reads as one table of figures rather than three captions. */}
          <div className="mt-1.5 flex items-baseline gap-4 border-t border-hairline pt-1.5 text-micro">
            <span className="text-ink-muted">Now{' '}
              <span className="tnum font-medium text-ink">{now != null ? fmt(now) : '—'}</span></span>
            <span className="text-ink-muted">Baseline{' '}
              <span className="tnum font-medium text-ink">{base != null ? fmt(base) : '—'}</span></span>
            <span className="text-ink-muted">Severe{' '}
              <span className="tnum font-medium" style={{ color: 'var(--status-serious)' }}>
                {severe != null ? fmt(severe) : '—'}</span></span>
          </div>
        </figure>
      ))}
    </div>
  )
}

export default function StressedMevs({ terms, subtitle }: {
  terms: string[]
  subtitle?: string
}) {
  return (
    <Card>
      <CardHead title="Macro paths in this projection"
        subtitle={subtitle}
        caption="Each macro term of the fitted specification, exactly as the model consumes it: history to the projection date, then the two Federal Reserve branches the projection walks. The gap that opens at the dashed seam is the stress."
        right={<MevLegend />} />
      <MevPathGrid terms={terms} />
    </Card>
  )
}
