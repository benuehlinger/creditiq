import { useMemo } from 'react'
import { Busy } from './FitProgress'
import type { SeverityFreq, SeverityOverTime as Series, SeverityTimePoint } from '../lib/api'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import {
  baseOption, crosshairTooltip, gridFor, lineSeries, markLineAt, xName, yName,
} from '../charts/base'
import { accent, ink, mode, series, status } from '../design/tokens'
import { month, monthLong, num, pct } from '../lib/format'

/**
 * The dependent variable through time.
 *
 * The severity histogram shows the SHAPE of the target — a mass at full recovery
 * and a mass near total loss — and it is the right chart for that. It cannot show
 * WHEN. Severity on a secured book is a function of collateral values, so it
 * moves with the cycle: mortgage severity ran 0.57 through 2008 and 0.18 by 2025.
 * A driver is worth having only if it tracks that movement, and a model is worth
 * trusting only if its predicted level tracks it too. So this sits BESIDE the
 * histogram rather than replacing it.
 *
 * The band is the standard error of the COHORT MEAN, not a binomial interval.
 * Severity is a proportion per loan, but the quantity estimated here is an
 * average of proportions, and its spread comes from how much the loans in that
 * cohort differ from each other.
 */
export default function SeverityOverTime({
  d, freq, onFreq, busy = false, oot, height = 240,
}: {
  d: Series
  freq: SeverityFreq
  onFreq: (f: SeverityFreq) => void
  busy?: boolean
  /** Boundary of the out-of-time split, marked when a model is being judged. */
  oot?: string
  height?: number
}) {
  const m = mode()
  const k = ink(m)
  const hasPredicted = d.points.some((p) => p.predicted != null)

  const option = useMemo(() => {
    const pts = d.points
    const at = (f: (p: SeverityTimePoint) => number | null | undefined) =>
      pts.map((p) => [p.period, f(p) == null ? null : (f(p) as number) * 100] as
        [string, number | null])

    return {
      ...baseOption(),
      grid: gridFor({ left: 64, right: 18, top: 14, bottom: 46 }),
      tooltip: {
        ...crosshairTooltip((v) => `${v.toFixed(1)}%`, (v) => monthLong(v)),
        confine: true,
      },
      xAxis: {
        ...(baseOption().xAxis as object), type: 'time' as const,
        ...xName(`Resolution ${d.period_freq}`, 28),
        axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' },
      },
      yAxis: {
        ...(baseOption().yAxis as object), type: 'value' as const, min: 0,
        ...yName('Mean severity (%)', 44),
        axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => `${v}%` },
      },
      series: [
        // The interval first, so the lines sit on top of it. Drawn as a stacked
        // floor plus a transparent-bottomed band, which is how ECharts draws a
        // ribbon without a dedicated band series.
        { name: 'band floor', type: 'line' as const, stack: 'band', silent: true,
          data: at((p) => p.lo95), lineStyle: { opacity: 0 }, symbol: 'none',
          areaStyle: { opacity: 0 }, connectNulls: false, z: 1 },
        { name: 'Realised 95% interval', type: 'line' as const, stack: 'band', silent: true,
          data: at((p) => (p.hi95 == null || p.lo95 == null ? null : p.hi95 - p.lo95)),
          lineStyle: { opacity: 0 }, symbol: 'none', connectNulls: false,
          areaStyle: { color: accent(), opacity: 0.16 }, z: 1 },
        { ...lineSeries({ name: 'Realised', color: accent(),
                          data: at((p) => p.actual) }),
          z: 3, connectNulls: false,
          ...(oot ? { markLine: markLineAt(oot, 'out of time', status.serious) } : {}) },
        ...(hasPredicted
          ? [{ ...lineSeries({ name: 'Predicted', color: series(2, m), dashed: true,
                               data: at((p) => p.predicted) }), connectNulls: false }]
          : []),
      ],
    }
  }, [d, hasPredicted, oot, m, k])

  const misses = d.points.filter((p) => p.calibrated === false).length
  const plotted = d.points.filter((p) => !p.too_thin).length

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-1 text-micro text-ink-muted">
        <Legend items={hasPredicted
          ? [{ name: 'Realised', color: accent() },
             { name: 'Predicted', color: series(2, m) }]
          : [{ name: 'Mean realised severity', color: accent() }]} />
        {hasPredicted && (
          <span title="A predicted mean outside the interval of the realised mean is a calibration miss for that cohort, not sampling noise.">
            {misses} of {plotted} cohorts miss the interval
          </span>
        )}
        <FreqToggle freq={freq} onFreq={onFreq} busy={busy} />
      </div>

      <Coverage d={d} />

      <EChart option={option as never} height={height} externalLegend
        refetching={busy}
        ariaLabel="Mean realised severity over time"
        table={{
          columns: ['Period', 'Resolutions', 'Realised', ...(hasPredicted ? ['Predicted'] : []),
                    'Zero-loss share'],
          rows: d.points.map((p) => [
            p.period, p.n,
            p.actual == null ? 'too thin' : `${(p.actual * 100).toFixed(1)}%`,
            ...(hasPredicted
              ? [p.predicted == null ? '—' : `${(p.predicted * 100).toFixed(1)}%`] : []),
            p.zero_loss_share == null ? '—' : `${(p.zero_loss_share * 100).toFixed(0)}%`,
          ]),
        }} />
    </>
  )
}

/** Monthly or quarterly cohorts, matching the PD backtest's control. */
function FreqToggle({ freq, onFreq, busy }: {
  freq: SeverityFreq; onFreq: (f: SeverityFreq) => void; busy: boolean
}) {
  return (
    <span className="ml-auto flex items-center gap-1">
      <span>Cohort</span>
      {([['MS', 'month'], ['QS', 'quarter'], ['YS', 'year']] as const).map(([f, label]) => (
        <button key={f} onClick={() => onFreq(f)} disabled={busy}
          title={f === 'MS'
            ? 'Group by month, the frequency of the panel. Whether it is readable depends on how many workouts the book resolves; the note below says how many months were too thin to average.'
            : f === 'QS'
              ? 'Group by quarter. Roughly three times the resolutions behind each point, so the interval narrows and a thin book still has a line.'
              : 'Group by year. The coarsest view, and the only readable one on a book that resolves a couple of workouts a month.'}
          className={`rounded-ctl border px-1.5 py-0.5 transition-colors ${
            freq === f ? 'border-accent bg-accent-soft text-ink'
                       : 'border-hairline text-ink-muted hover:text-ink'} disabled:opacity-50`}>
          {label}
        </button>
      ))}
      {busy && <Busy>regrouping</Busy>}
    </span>
  )
}

/** What the chart is NOT showing.
 *
 *  A mean needs enough workouts to be a mean. On the commercial book only seven
 *  of 158 months clear the floor, so a monthly chart there is seven points and a
 *  lot of white space — which reads as missing data rather than as a book that
 *  resolves two loans a month. */
function Coverage({ d }: { d: Series }) {
  if (!d.periods_dropped) return null
  const share = d.periods_dropped / Math.max(d.periods_total, 1)
  return (
    <p className="max-w-[88ch] px-4 pb-1 text-micro leading-relaxed"
       style={{ color: share > 0.5 ? 'var(--status-warning)' : 'var(--ink-muted)' }}>
      {num(d.periods_dropped)} of {num(d.periods_total)} {d.period_freq}s are not
      plotted: fewer than {d.min_resolutions} workouts resolved, which is too few to
      average.{' '}
      {share > 0.5 && `This book resolves too little to read by ${d.period_freq}. Group by quarter or year instead.`}
    </p>
  )
}

/** Shared by the Explore card, which has no model and so no prediction. */
export function severitySummary(d: Series) {
  return `${num(d.n_defaults)} resolutions · book mean ${pct(d.mean * 100, 1)} · `
    + `${num(d.periods_kept)} ${d.period_freq}s plotted`
}

export { month }
