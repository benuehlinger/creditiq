import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BinningResult } from '../lib/api'
import { diverging, mode, sequential } from '../design/tokens'
import { num, pct } from '../lib/format'

const H = 236
const PAD = { l: 8, r: 8, t: 10, b: 34 }
const HIST_H = 34
const BAR_TOP = 56
const BAR_H = 104
const SHARE_H = 16

/**
 * The binning editor — the low-code centrepiece.
 *
 * Drag a bin edge and the weight of evidence and information value update live.
 * Drawn as SVG rather than routed through a chart library because the drag has
 * to feel immediate: the handle follows the pointer at frame rate and the refit
 * is debounced behind it, so the interaction never waits on a round trip. A
 * manual rebin costs about 25ms on the server, so it genuinely is live.
 *
 * Coordinates are REAL PIXELS from a measured container, not a stretched
 * viewBox. `preserveAspectRatio="none"` on a 100-unit box is the quick way to
 * get a responsive SVG, and it scales the horizontal axis by roughly seven —
 * which turns every label, circle and handle into a distorted sliver.
 *
 * The axis spans the 1st to 99th percentile, not min to max. One planted
 * impossible value — a DTI of 900 — would otherwise compress the whole
 * distribution into the leftmost two pixels and make dragging pointless.
 */
export default function BinningEditor({
  result, onEdgesChange, pending,
}: {
  result: BinningResult
  onEdgesChange: (edges: number[]) => void
  pending: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [W, setW] = useState(720)
  const [dragEdges, setDragEdges] = useState<number[] | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)))
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const edges = dragEdges ?? result.edges ?? []
  const domain = result.domain ?? [0, 1]
  const plotW = W - PAD.l - PAD.r

  const toX = useCallback(
    (v: number) => PAD.l + ((v - domain[0]) / (domain[1] - domain[0] || 1)) * plotW,
    [domain, plotW],
  )
  const toV = useCallback(
    (x: number) => domain[0] + ((x - PAD.l) / plotW) * (domain[1] - domain[0]),
    [domain, plotW],
  )

  // the refit is debounced behind the handle so the pointer never waits
  useEffect(() => {
    if (dragEdges === null) return
    const t = setTimeout(() => onEdgesChange(dragEdges), 110)
    return () => clearTimeout(t)
  }, [dragEdges, onEdgesChange])

  useEffect(() => { setDragEdges(null) }, [result.column])

  const realBins = result.bins.filter((b) => !b.is_special)
  const maxRate = Math.max(...realBins.map((b) => b.event_rate || 0), 1e-9)
  const maxWoe = Math.max(...realBins.map((b) => Math.abs(b.woe) || 0), 1e-9)
  const maxShare = Math.max(...realBins.map((b) => b.pct_of_total), 1e-9)
  const hist = result.histogram
  const maxCount = hist ? Math.max(...hist.counts, 1) : 1
  const m = mode()

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging === null || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const v = toV(e.clientX - rect.left)
    const next = [...edges]
    // An edge may not cross its neighbours — that would silently reorder the
    // bins and produce a binning the analyst did not ask for.
    const span = domain[1] - domain[0]
    const lo = dragging === 0 ? domain[0] : next[dragging - 1]
    const hi = dragging === next.length - 1 ? domain[1] : next[dragging + 1]
    next[dragging] = Math.min(Math.max(v, lo + span * 0.004), hi - span * 0.004)
    setDragEdges(next)
  }

  const removeEdge = (i: number) => {
    const next = edges.filter((_, k) => k !== i)
    setDragEdges(next); onEdgesChange(next)
  }
  const splitBin = (a: number, b: number) => {
    const next = [...edges, (a + b) / 2].sort((x, y) => x - y)
    setDragEdges(next); onEdgesChange(next)
  }

  const geoms = useMemo(() => {
    const inner = edges.filter((e) => e > domain[0] && e < domain[1])
    const bounds = [domain[0], ...inner, domain[1]]
    return realBins.slice(0, bounds.length - 1).map((b, i) => ({
      bin: b, x0: toX(bounds[i]), x1: toX(bounds[i + 1]),
      v0: bounds[i], v1: bounds[i + 1],
    }))
  }, [realBins, edges, domain, toX])

  const ticks = useMemo(
    () => Array.from({ length: 5 }, (_, k) => domain[0] + (k / 4) * (domain[1] - domain[0])),
    [domain],
  )

  return (
    <div ref={wrapRef} className={pending ? 'refetching' : undefined}>
      <svg ref={svgRef} width={W} height={H} className="touch-none select-none"
           onPointerMove={onPointerMove} onPointerUp={() => setDragging(null)}
           onPointerLeave={() => setDragging(null)}>
        {/* Population density, so the analyst can see where the book actually
            sits before deciding where to cut. */}
        {hist?.counts.map((c, i) => {
          const x0 = toX(hist.bounds[i]), x1 = toX(hist.bounds[i + 1])
          const h = (c / maxCount) * HIST_H
          return <rect key={i} x={x0} y={PAD.t + HIST_H - h} width={Math.max(x1 - x0 - 1, 1)}
                       height={h} fill={sequential(0.2, m)} opacity={0.55} rx={1} />
        })}
        <text x={PAD.l} y={PAD.t + 9} fontSize={9} fill="var(--ink-muted)">population</text>
        <line x1={PAD.l} y1={PAD.t + HIST_H} x2={W - PAD.r} y2={PAD.t + HIST_H}
              stroke="var(--chrome-grid)" strokeWidth={1} />

        {/* One block per bin: height is the event rate, fill is the weight of
            evidence on the diverging ramp (blue safer, magenta riskier). */}
        {geoms.map((g, i) => {
          const h = ((g.bin.event_rate || 0) / maxRate) * BAR_H
          const w = Math.max(g.x1 - g.x0 - 2, 1)      // the 2px surface gap
          const sh = Math.max((g.bin.pct_of_total / maxShare) * SHARE_H, 1)
          return (
            <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
               onDoubleClick={() => splitBin(g.v0, g.v1)} style={{ cursor: 'zoom-in' }}>
              <rect x={g.x0} y={BAR_TOP} width={w} height={BAR_H + SHARE_H + 4} fill="transparent" />
              <rect x={g.x0} y={BAR_TOP + BAR_H - h} width={w} height={h} rx={3}
                    fill={diverging((g.bin.woe || 0) / maxWoe, m)}
                    opacity={hover === i ? 1 : 0.9} />
              <rect x={g.x0} y={BAR_TOP + BAR_H + 4} width={w} height={sh} rx={1.5}
                    fill="var(--deemphasis)" opacity={0.55} />
              <title>
                {`${g.bin.label}\n${num(g.bin.count)} rows (${(g.bin.pct_of_total * 100).toFixed(1)}% of book)`
                 + `\nEvent rate ${(g.bin.event_rate * 100).toFixed(3)}%`
                 + `\nWoE ${g.bin.woe.toFixed(4)}   IV contribution ${g.bin.iv_contribution.toFixed(4)}`
                 + `\n\nDouble-click to split this bin`}
              </title>
            </g>
          )
        })}
        <line x1={PAD.l} y1={BAR_TOP + BAR_H} x2={W - PAD.r} y2={BAR_TOP + BAR_H}
              stroke="var(--chrome-axis)" strokeWidth={1} />

        {/* Draggable edges. The hit target is far wider than the visible rule —
            a 1px line is not something anyone can reliably grab. */}
        {edges.map((e, i) => {
          const x = toX(e)
          if (x < PAD.l - 2 || x > W - PAD.r + 2) return null
          const on = dragging === i
          return (
            <g key={i}>
              <rect x={x - 12} y={PAD.t} width={24} height={BAR_TOP + BAR_H - PAD.t}
                    fill="transparent" style={{ cursor: 'ew-resize' }}
                    onPointerDown={(ev) => { ev.preventDefault(); setDragging(i) }} />
              <line x1={x} y1={PAD.t} x2={x} y2={BAR_TOP + BAR_H}
                    stroke="var(--accent)" strokeWidth={on ? 2 : 1} opacity={on ? 1 : 0.8}
                    style={{ pointerEvents: 'none' }} />
              <circle cx={x} cy={PAD.t} r={on ? 5 : 4} fill="var(--accent)"
                      stroke="var(--surface-chart)" strokeWidth={2}
                      style={{ cursor: 'ew-resize' }}
                      onPointerDown={(ev) => { ev.preventDefault(); setDragging(i) }} />
              {on && (
                <text x={x} y={PAD.t + HIST_H + 14} textAnchor="middle" fontSize={10}
                      fill="var(--accent)" style={{ pointerEvents: 'none' }}>
                  {fmtNum(e)}
                </text>
              )}
              <g style={{ cursor: 'pointer' }} onClick={() => removeEdge(i)}>
                <circle cx={x} cy={BAR_TOP + BAR_H + SHARE_H + 14} r={7}
                        fill="var(--surface-sunken)" stroke="var(--chrome-border)" />
                <text x={x} y={BAR_TOP + BAR_H + SHARE_H + 17.5} textAnchor="middle"
                      fontSize={10} fill="var(--ink-muted)" style={{ pointerEvents: 'none' }}>×</text>
                <title>Remove this edge — merges the two bins either side</title>
              </g>
            </g>
          )
        })}

        {ticks.map((t, i) => (
          <text key={i} x={toX(t)} y={H - 4} fontSize={10} fill="var(--ink-muted)"
                textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>
            {fmtNum(t)}
          </text>
        ))}
      </svg>

      <p className="px-4 pb-1 text-micro text-ink-muted">
        Drag an edge to rebin · double-click a bin to split · × removes an edge
        {hover !== null && geoms[hover] && (
          <span className="ml-2 text-ink-secondary">
            — {geoms[hover].bin.label}: {pct(geoms[hover].bin.event_rate * 100, 3)} event rate,
            WoE {geoms[hover].bin.woe.toFixed(3)}, {num(geoms[hover].bin.count)} rows
          </span>
        )}
      </p>
    </div>
  )
}

function fmtNum(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}K`
  if (a >= 100) return v.toFixed(0)
  if (a >= 1) return v.toFixed(1)
  return v.toFixed(3)
}
