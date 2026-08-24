import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type CurvePoint, type CurveResult, type LevelPoint, type Treatment } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill } from './ui'
import { chrome, deemphasis, ink, mode, sequential, series } from '../design/tokens'
import { num, pct, ratio } from '../lib/format'

/** Ticks read as quantities, not as raw floats: 1.835 for a driver that only
 *  takes whole numbers is noise, and 0.0000123 needs a different treatment from
 *  285000. */
function formatTick(v: number): string {
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${Math.round(v / 1e3)}k`
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toPrecision(2)
}

const H = 320
const VOL_H = 54
// Left padding carries a rotated axis title as well as the tick labels; bottom
// padding carries the tick labels and the x-axis title.
const PAD = { l: 74, r: 16, t: 14, b: 42 }

/** The relationship between one variable and the target, at a resolution that
 *  supports a decision about how the variable should enter the model.
 *
 *  Shown for every variable regardless of the treatment selected: the empirical
 *  log-odds per bucket with a 95% interval, and the number of observations
 *  behind each bucket on the same axis. A bucket rate is only as reliable as
 *  its volume, so the two are read together.
 *
 *  The log-odds scale is used rather than the default rate because a logistic
 *  regression is linear in the log-odds. The shape on this scale maps to a
 *  treatment:
 *
 *    approximately straight   continuous, one column
 *    a smooth bend            spline, with knots placed at the bend
 *    a change of direction    bins, which impose no shape
 *    monotone but curved      weight of evidence, one column
 *
 *  Knots are placed here rather than in the binning editor because the optimal
 *  binning produces six to eight bins, which is too coarse to locate a bend. */
export default function VariableViews({
  portfolio, column, treatment, knots, nKnots, onKnots,
}: {
  portfolio: string
  column: string
  treatment: Treatment
  knots: number[] | undefined
  nKnots: number
  onKnots: (k: number[] | undefined) => void
}) {
  const [scale, setScale] = useState<'log_odds' | 'rate'>('log_odds')
  // Placement by search rather than at quantiles. Quantile knots go where the
  // DATA is dense and ignore the response, so on a variable that bends once at a
  // thin point every knot lands in the straight run.
  const place = useMutation({
    mutationFn: () => api.autoKnots(portfolio, column, nKnots),
    onSuccess: (r) => { if (r.knots.length) onKnots(r.knots) },
  })

  // Changing the COUNT re-places the knots.
  //
  // Raising the count used to leave the curve on its old knots until the "place
  // automatically" button was pressed, so the stepper read as broken: the number
  // changed and nothing on the chart did. Asking for a different number of knots
  // IS a request to re-derive their positions, so any positions are recomputed —
  // including dragged ones, which cannot survive a change in how many there are.
  //
  // Keyed on a CHANGE rather than on the value, so opening a saved model does
  // not overwrite the knots that model was fitted with.
  const lastN = useRef<number | null>(null)
  useEffect(() => {
    const prev = lastN.current
    lastN.current = nKnots
    if (prev === null || prev === nKnots || treatment !== 'spline') return
    place.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nKnots, treatment])
  // A fresh variable with no knots yet gets them placed on arrival.
  useEffect(() => {
    lastN.current = nKnots
    if (!knots && treatment === 'spline') place.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [column, treatment])
  const [resolution, setResolution] = useState(30)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['curve', portfolio, column, (knots ?? []).join(','), resolution],
    queryFn: () => api.curve(portfolio, column, knots, resolution),
    placeholderData: (prev) => prev,
  })

  if (isLoading || !data) return <Skeleton className="h-[420px]" />
  if (data.note) {
    return (
      <Card>
        <CardHead title="Shape" subtitle={column} />
        <p className="px-4 py-6 text-xs text-ink-secondary">{data.note}</p>
      </Card>
    )
  }

  return (
    <Card>
      <CardHead
        title="Shape"
        subtitle={data.kind === 'numeric'
          ? `${data.resolution} quantile buckets · ${num(data.n_events)} defaults`
          : `${data.n_levels} levels ordered by risk · ${num(data.n_events)} defaults`}
        caption={data.kind === 'numeric'
          ? 'Log-odds of default per bucket, with a 95% interval, and the number of observations behind each bucket on the same axis. The candidate curves are fitted with the estimator the model uses, on the rows the model uses, with the same spline basis — not by least squares through the bucket means.'
          : 'Levels ordered by log-odds of default, with the number of observations beside each. The vertical rule is the book base rate.'}
        right={data.kind === 'numeric' && (
          <div className="flex items-center gap-1">
            {(['log_odds', 'rate'] as const).map((s) => (
              <button key={s} onClick={() => setScale(s)}
                className={`rounded border px-1.5 py-0.5 text-micro ${
                  scale === s ? 'border-accent text-ink' : 'border-hairline text-ink-muted hover:text-ink'}`}>
                {s === 'log_odds' ? 'log-odds' : 'default rate'}
              </button>
            ))}
            <span className="ml-2 flex items-center gap-1" title="Number of quantile buckets. More buckets resolve the shape in more detail and carry fewer events each, widening the intervals. Buckets with fewer than 20 defaults are merged with their neighbour.">
              <button onClick={() => setResolution((v) => Math.max(10, v - 10))}
                className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">−</button>
              <span className="tabular-nums text-micro text-ink-muted">{resolution}</span>
              <button onClick={() => setResolution((v) => Math.min(60, v + 10))}
                className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">+</button>
            </span>
          </div>
        )}
      />

      <Verdict data={data} treatment={treatment} />

      <div className={isFetching ? 'opacity-60 transition-opacity' : ''}>
        {data.kind === 'numeric'
          ? <NumericShape data={data} scale={scale} treatment={treatment}
                          knots={knots ?? data.candidate_knots ?? []}
                          custom={!!knots} onKnots={onKnots}
                          nKnots={nKnots}
                          onAutoPlace={() => place.mutate()}
                          placing={place.isPending}
                          gain={place.data?.gain_over_quantile ?? null} />
          : <CategoricalShape data={data} />}
      </div>
    </Card>
  )
}

/** The recommendation, its number, and how it compares with what is selected. */
function Verdict({ data, treatment }: { data: CurveResult; treatment: Treatment }) {
  const rec = data.recommendation
  const agrees = rec.treatment === treatment
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-y border-hairline px-4 py-2">
      <StatusPill severity={agrees ? 'good' : 'warning'}>
        {agrees ? `Consistent with ${treatment}` : `Shape indicates ${rec.treatment}`}
      </StatusPill>
      <p className="min-w-0 flex-1 text-tiny leading-relaxed text-ink-secondary">{rec.reason}</p>
      {data.linear && (
        <span className="shrink-0 text-micro tabular-nums text-ink-muted"
              title={`Both curves are fitted with the estimator the model uses, on ${data.linear.n_rows.toLocaleString()} rows carrying ${data.linear.n_events.toLocaleString()} events. Pseudo R-squared is McFadden's. BIC penalises by the event count, which is the effective sample size for a rare outcome.`}>
          pseudo R² {ratio(data.linear.pseudo_r2, 3)}
          {data.spline && <> → {ratio(data.spline.pseudo_r2, 3)} · ΔBIC{' '}
            <span style={{ color: data.spline.delta_bic < 0 ? undefined : 'inherit' }}>
              {data.spline.delta_bic > 0 ? '+' : ''}{data.spline.delta_bic.toFixed(0)}
            </span></>}
          {data.reversals ? <> · {data.reversals} direction change{data.reversals === 1 ? '' : 's'}</> : null}
        </span>
      )}
      {data.missing_rate > 0.001 && (
        <span className="text-micro text-ink-muted">{pct(data.missing_rate * 100, 1)} missing</span>
      )}
    </div>
  )
}

function NumericShape({ data, scale, treatment, knots, custom, onKnots,
                       nKnots, onAutoPlace, placing, gain }: {
  data: CurveResult; scale: 'log_odds' | 'rate'; treatment: Treatment
  knots: number[]; custom: boolean; onKnots: (k: number[] | undefined) => void
  nKnots: number; onAutoPlace: () => void; placing: boolean; gain: number | null
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [W, setW] = useState(760)
  const [drag, setDrag] = useState<number | null>(null)
  const [local, setLocal] = useState<number[] | null>(null)

  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(360, e.contentRect.width)))
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const m = mode()
  const k = ink(m)
  const c = chrome(m)
  const pts = data.points as CurvePoint[]
  const [dlo, dhi] = data.domain ?? [0, 1]
  const showKnots = treatment === 'spline'
  const drawnKnots = local ?? knots

  const val = (p: CurvePoint) => (scale === 'rate' ? p.rate : p.log_odds)
  const band = (p: CurvePoint): [number, number] => scale === 'rate'
    ? [1 / (1 + Math.exp(-p.lo95)), 1 / (1 + Math.exp(-p.hi95))]
    : [p.lo95, p.hi95]

  const yDomain = useMemo(() => {
    const all = pts.flatMap((p) => band(p))
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    const pad = (hi - lo) * 0.06 || 0.1
    return [lo - pad, hi + pad] as [number, number]
  }, [pts, scale])

  const plotH = H - VOL_H - PAD.t - PAD.b
  const x = (v: number) => PAD.l + ((v - dlo) / (dhi - dlo || 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - yDomain[0]) / (yDomain[1] - yDomain[0] || 1)) * plotH
  const xInv = (px: number) => dlo + ((px - PAD.l) / (W - PAD.l - PAD.r || 1)) * (dhi - dlo)

  const maxN = Math.max(...pts.map((p) => p.n), 1)
  const volY = PAD.t + plotH + 18

  const path = (grid: number[], fitted: number[]) => fitted
    .map((v, i) => {
      const yy = scale === 'rate' ? 1 / (1 + Math.exp(-v)) : v
      return `${i ? 'L' : 'M'}${x(grid[i]).toFixed(1)},${y(yy).toFixed(1)}`
    }).join(' ')

  // The observed relationship, drawn through the buckets themselves. A fitted
  // line smooths over the changes of slope that determine where a knot belongs,
  // which is the reason for looking at this view.
  const observed = pts
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(val(p)).toFixed(1)}`)
    .join(' ')

  // ── knot interaction ──
  const pointerX = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    return Math.min(dhi, Math.max(dlo, xInv(e.clientX - r.left)))
  }
  const onMove = (e: React.PointerEvent) => {
    if (drag == null) return
    const next = [...(local ?? knots)]
    next[drag] = pointerX(e)
    setLocal(next)
  }
  const commit = () => {
    if (drag != null && local) onKnots([...local].sort((a, b) => a - b))
    setDrag(null); setLocal(null)
  }

  const ticks = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i <= 4; i++) out.push(yDomain[0] + (i / 4) * (yDomain[1] - yDomain[0]))
    return out
  }, [yDomain])

  return (
    <div ref={wrap} className="px-4 pb-3 pt-2">
      <svg ref={svg} width={W} height={H} className="block select-none"
           style={{ cursor: drag != null ? 'ew-resize' : 'default' }}
           onPointerMove={onMove} onPointerUp={commit} onPointerLeave={commit}
           onDoubleClick={showKnots ? (e) => {
             const r = svg.current!.getBoundingClientRect()
             onKnots([...knots, xInv(e.clientX - r.left)].sort((a, b) => a - b))
           } : undefined}>
        {/* gridlines: hairline, solid, one step off the surface */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={c.grid} strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={k.muted}>
              {scale === 'rate' ? pct(t * 100, 2) : t.toFixed(1)}
            </text>
          </g>
        ))}

        {/* the observed relationship, bucket to bucket */}
        <path d={observed} fill="none" stroke={sequential(0.55, m)} strokeWidth={2}
              strokeLinejoin="round" />
        {/* the spline at the current knots, shown only while placing them */}
        {showKnots && data.spline && data.grid && (
          <path d={path(data.grid, data.spline.fitted)} fill="none"
                stroke={series(1, m)} strokeWidth={2} strokeDasharray="5 3" />
        )}

        {/* the empirical points, with their uncertainty */}
        {pts.map((p, i) => {
          const [b0, b1] = band(p)
          return (
            <g key={i}>
              <line x1={x(p.x)} x2={x(p.x)} y1={y(b0)} y2={y(b1)}
                    stroke={c.axis} strokeWidth={1.5} />
              <circle cx={x(p.x)} cy={y(val(p))} r={3.5}
                      fill={sequential(0.55, m)} stroke={c.border} strokeWidth={1}>
                <title>
                  {`${p.lo.toPrecision(4)} to ${p.hi.toPrecision(4)}\n` +
                   `${num(p.n)} account-months, ${num(p.events)} defaults\n` +
                   `rate ${pct(p.rate * 100, 2)} · log-odds ${p.log_odds.toFixed(2)}`}
                </title>
              </circle>
            </g>
          )
        })}

        {/* knots */}
        {showKnots && drawnKnots.map((kn, i) => (
          <g key={i}>
            <line x1={x(kn)} x2={x(kn)} y1={PAD.t} y2={PAD.t + plotH}
                  stroke={series(1, m)} strokeWidth={1} strokeOpacity={0.5} />
            <rect x={x(kn) - 5} y={PAD.t + plotH - 4} width={10} height={12} rx={3}
                  fill={series(1, m)} style={{ cursor: 'ew-resize' }}
                  onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); setDrag(i) }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    onKnots(knots.filter((_, j) => j !== i))
                  }}>
              <title>Drag to move. Double-click to remove.</title>
            </rect>
          </g>
        ))}

        {/* volume, sharing the x-axis. Never a second y-axis on the same panel:
            two scales in one frame invite a comparison the data does not support. */}
        {/* y-axis title, rotated into the left gutter */}
        <text transform={`translate(14,${PAD.t + plotH / 2}) rotate(-90)`}
              textAnchor="middle" fontSize={10} fill={k.secondary}>
          {scale === 'rate' ? 'Default rate (monthly)' : 'Log-odds of default'}
        </text>
        <text transform={`translate(14,${volY + (VOL_H - 20) / 2}) rotate(-90)`}
              textAnchor="middle" fontSize={9} fill={k.muted}>
          Accounts
        </text>
        {pts.map((p, i) => {
          const w = Math.max(2, (x(p.hi) - x(p.lo)) - 2)
          const h = Math.max(1, (p.n / maxN) * (VOL_H - 20))
          return (
            <rect key={i} x={x(p.lo) + 1} y={volY + (VOL_H - 20) - h} width={w} height={h}
                  rx={1.5} fill={deemphasis(m)}>
              <title>{`${num(p.n)} account-months (${pct((p.n / data.n) * 100, 1)} of the book)`}</title>
            </rect>
          )
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={volY + VOL_H - 20} y2={volY + VOL_H - 20}
              stroke={c.axis} strokeWidth={1} />
        {[dlo, dlo + (dhi - dlo) / 4, (dlo + dhi) / 2, dhi - (dhi - dlo) / 4, dhi]
          .map((t, i) => (
            <text key={i} x={x(t)} y={H - 22} fontSize={10} fill={k.muted}
                  textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>
              {formatTick(t)}
            </text>
          ))}
        <text x={PAD.l + (W - PAD.l - PAD.r) / 2} y={H - 5} textAnchor="middle"
              fontSize={10} fill={k.secondary}>
          {data.column}
        </text>
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-micro text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: sequential(0.55, m) }} />
          observed, bucket to bucket
        </span>
        {showKnots && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded"
                    style={{ background: `repeating-linear-gradient(90deg, ${series(1, m)} 0 5px, transparent 5px 8px)` }} />
              spline at {drawnKnots.length} knot{drawnKnots.length === 1 ? '' : 's'}
            </span>
            <span className="rounded-ctl px-1.5 py-0.5 font-medium"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              Drag a knot to move it. Double-click the plot to add a knot, or a knot to remove it. Set how many under “knots” above.
            </span>
            <button onClick={onAutoPlace} disabled={placing}
              className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-secondary hover:text-ink disabled:opacity-50"
              title="Search knot positions against the fit instead of placing them at quantiles. The search scores on grouped counts, which is fast; the fit reported above is re-estimated on the full rows.">
              {placing ? 'placing…' : `place ${nKnots} knots automatically`}
            </button>
            {gain != null && gain !== 0 && (
              <span title="Improvement in log-likelihood over quantile placement, on the grouped approximation the search uses.">
                {gain > 0 ? '+' : ''}{gain.toFixed(1)} log-likelihood vs quantiles
              </span>
            )}
            {custom && (
              <button onClick={() => onKnots(undefined)} className="underline hover:text-ink">
                reset to quantiles
              </button>
            )}
          </>
        )}
        {data.sampled && (
          <span title="Screening statistics are computed on a deterministic subsample. Every default is retained and only non-events are thinned. The final fit uses the full panel.">
            sampled for screening
          </span>
        )}
      </div>
    </div>
  )
}

function CategoricalShape({ data }: { data: CurveResult }) {
  const m = mode()
  const pts = data.points as LevelPoint[]
  const maxN = Math.max(...pts.map((p) => p.n), 1)
  const lo = Math.min(...pts.map((p) => p.lo95))
  const hi = Math.max(...pts.map((p) => p.hi95))
  const span = hi - lo || 1
  const at = (v: number) => ((v - lo) / span) * 100
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * span)
  return (
    <div className="px-4 pb-3 pt-2">
      {/* the scale the dots sit on, stated rather than implied */}
      <div className="mb-1 grid grid-cols-[150px_minmax(0,1fr)_92px] items-end gap-2">
        <span />
        <div className="relative h-6">
          {ticks.map((t, i) => (
            <span key={i} className="absolute bottom-0 text-micro tabular-nums text-ink-muted"
                  style={{ left: `${at(t)}%`,
                           transform: i === 0 ? 'none'
                             : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
              {t.toFixed(1)}
            </span>
          ))}
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 text-micro text-ink-secondary">
            Log-odds of default
          </span>
        </div>
        <span className="text-right text-micro text-ink-secondary">Accounts · rate</span>
      </div>
      <div className="space-y-1">
        {pts.map((p) => (
          <div key={p.level} className="grid grid-cols-[150px_minmax(0,1fr)_92px] items-center gap-2">
            <span className="truncate font-mono text-tiny text-ink-secondary" title={p.level}>
              {p.level}
            </span>
            <div className="relative h-4">
              {/* the base rate, so every level is read against the book */}
              <div className="absolute top-0 h-4 w-px bg-hairline"
                   style={{ left: `${at(data.base_log_odds)}%` }} />
              <div className="absolute top-[7px] h-0.5 rounded"
                   style={{ left: `${at(p.lo95)}%`, width: `${at(p.hi95) - at(p.lo95)}%`,
                            background: 'var(--chrome-axis)' }} />
              <div className="absolute top-1 h-2 w-2 rounded-full"
                   style={{ left: `calc(${at(p.log_odds)}% - 4px)`,
                            background: p.thin ? deemphasis(m) : sequential(0.55, m) }}
                   title={`log-odds ${p.log_odds.toFixed(2)} · rate ${pct(p.rate * 100, 2)}`} />
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <div className="h-2 rounded-sm" title={`${num(p.n)} account-months`}
                   style={{ width: `${Math.max(2, (p.n / maxN) * 44)}px`,
                            background: deemphasis(m) }} />
              <span className="w-11 text-right text-micro tabular-nums text-ink-muted">
                {pct(p.rate * 100, 2)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="pt-2 text-micro text-ink-muted">
        The dot is the log-odds for the level, the rule behind it the 95% interval,
        and the hairline the book base rate. Grey dots carry fewer than 20 defaults,
        so their position is estimated imprecisely. Empirical-Bayes shrinkage on the
        weight of evidence reduces the influence of those levels in the fit.
      </p>
    </div>
  )
}
