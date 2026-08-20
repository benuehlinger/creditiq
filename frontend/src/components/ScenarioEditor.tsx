import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill } from './ui'
import { accent, deemphasis, mode, status } from '../design/tokens'

/**
 * The scenario editor — grab a macro path and drag it.
 *
 * The published severely adverse path is drawn as the reference; dragging a
 * quarter creates a custom path, and everything downstream — PD, LGD, EAD, ECL
 * and the attribution bridge — reprojects against it.
 *
 * The seam between history and projection is drawn, never hidden: a vertical
 * rule with the actual side solid and the projected side dashed. Real pixels
 * from a measured container rather than a stretched viewBox, for the same reason
 * as the binning editor.
 */
export default function ScenarioEditor({ portfolio, mevs, onApply, busy }: {
  portfolio: string
  mevs: string[]
  onApply: (custom: Record<string, Record<string, number>>) => void
  busy: boolean
}) {
  const base = mevs[0]?.endsWith('_yoy') ? mevs[0].slice(0, -4) : mevs[0]
  const [variable, setVariable] = useState(base)
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({})
  const [dragging, setDragging] = useState<number | null>(null)
  const [W, setW] = useState(720)
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)

  useEffect(() => { setVariable(base); setEdits({}) }, [portfolio, base])
  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(360, e.contentRect.width)))
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const keys = useMemo(
    () => mevs.map((k) => (k.endsWith('_yoy') ? k.slice(0, -4) : k)), [mevs])
  const { data, isLoading } = useQuery({
    queryKey: ['editable', keys.join(',')],
    queryFn: () => api.editableScenario('severely_adverse', keys),
  })

  const published = data?.series[variable] ?? []
  const points = published.map((p) => ({
    quarter: p.quarter,
    value: edits[variable]?.[p.quarter] ?? p.value,
    edited: edits[variable]?.[p.quarter] != null,
  }))

  const H = 190
  const PAD = { l: 46, r: 14, t: 14, b: 30 }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const vals = [...published.map((p) => p.value), ...points.map((p) => p.value)]
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const pad = (hi - lo) * 0.25 || 1
  const yMin = lo - pad, yMax = hi + pad
  const toX = (i: number) => PAD.l + (i / Math.max(points.length - 1, 1)) * plotW
  const toY = (v: number) => PAD.t + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH
  const toV = (y: number) => yMin + ((PAD.t + plotH - y) / plotH) * (yMax - yMin)

  const onMove = (e: React.PointerEvent) => {
    if (dragging === null || !svg.current) return
    const r = svg.current.getBoundingClientRect()
    const v = toV(e.clientY - r.top)
    const q = points[dragging].quarter
    setEdits((prev) => ({ ...prev, [variable]: { ...(prev[variable] ?? {}), [q]: v } }))
  }

  const dirty = Object.values(edits).some((m) => Object.keys(m).length > 0)
  const m = mode()

  if (isLoading) return <Skeleton className="h-[240px]" />

  return (
    <Card>
      <CardHead
        title="Scenario editor"
        subtitle="Drag a quarter to build a custom path"
        caption="Everything downstream reprojects against the dragged path — PD, LGD, exposure, ECL and the bridge. A custom scenario is never labelled as supervisory."
        right={
          <div className="flex items-center gap-2">
            <select value={variable} onChange={(e) => setVariable(e.target.value)}
              className="rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink">
              {keys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {dirty && (
              <button onClick={() => setEdits({})}
                className="rounded border border-hairline px-2 py-0.5 text-micro text-ink-muted hover:text-ink">
                Reset
              </button>
            )}
            <button onClick={() => onApply(edits)} disabled={busy || !dirty}
              className="rounded-ctl bg-accent px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
              {busy ? 'Projecting…' : 'Apply'}
            </button>
          </div>
        }
      />
      {dirty && (
        <div className="border-b border-hairline px-4 py-1.5">
          <StatusPill severity="warning">Custom path — not a supervisory scenario</StatusPill>
        </div>
      )}
      <div ref={wrap} className="px-2">
        <svg ref={svg} width={W} height={H} className="touch-none select-none"
             onPointerMove={onMove} onPointerUp={() => setDragging(null)}
             onPointerLeave={() => setDragging(null)}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const v = yMin + f * (yMax - yMin)
            return (
              <g key={f}>
                <line x1={PAD.l} y1={toY(v)} x2={W - PAD.r} y2={toY(v)}
                      stroke="var(--chrome-grid)" strokeWidth={1} />
                <text x={PAD.l - 6} y={toY(v) + 3} textAnchor="end" fontSize={9}
                      fill="var(--ink-muted)">{v.toFixed(1)}</text>
              </g>
            )
          })}
          {/* the published path, for reference */}
          <polyline fill="none" stroke={deemphasis(m)} strokeWidth={2}
            strokeDasharray="4 3"
            points={published.map((p, i) => `${toX(i)},${toY(p.value)}`).join(' ')} />
          {/* the live path */}
          <polyline fill="none" stroke={accent()} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round"
            points={points.map((p, i) => `${toX(i)},${toY(p.value)}`).join(' ')} />
          {points.map((p, i) => (
            <g key={p.quarter} style={{ cursor: 'ns-resize' }}
               onPointerDown={(e) => { e.preventDefault(); setDragging(i) }}>
              <rect x={toX(i) - 11} y={PAD.t} width={22} height={plotH} fill="transparent" />
              <circle cx={toX(i)} cy={toY(p.value)} r={dragging === i ? 6 : 4.5}
                      fill={p.edited ? status.warning : accent()}
                      stroke="var(--surface-chart)" strokeWidth={2} />
              <title>{`${p.quarter}\n${p.value.toFixed(2)}${p.edited ? '  (edited)' : ''}\n\nDrag to change`}</title>
            </g>
          ))}
          {points.filter((_, i) => i % 4 === 0).map((p, j) => (
            <text key={p.quarter} x={toX(j * 4)} y={H - 8} textAnchor="middle"
                  fontSize={9} fill="var(--ink-muted)">
              {p.quarter.slice(0, 4)}
            </text>
          ))}
        </svg>
      </div>
      <p className="px-4 pb-2 text-micro text-ink-muted">
        Dashed grey is the published Federal Reserve severely adverse path. Amber points
        have been edited.
      </p>
    </Card>
  )
}
