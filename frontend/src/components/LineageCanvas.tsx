import { useEffect, useMemo, useRef, useState } from 'react'
import type { LineageEdge, LineageGraph, LineageNode } from '../lib/api'
import { FORK_REASONS } from './ForkDialog'

/**
 * The lineage graph as a canvas you can move around in.
 *
 * The column layout it replaces sorted versions by GENERATION DEPTH and drew
 * no edges at all, so with two roots and one fork it was impossible to say
 * which root the fork came from — the one question the panel exists to answer.
 *
 * So: real edges, laid out as a tree. Every edge carries the rationale
 * captured at the fork gate, and clicking either a node or an edge opens the
 * story beside the graph. Roots that came off a search leaderboard say so,
 * with the rank they were taken at, which is the other half of "how did I get
 * here" — a root is no longer unexplained.
 *
 * Pan by dragging the background, zoom on the wheel or the buttons. The view
 * fits itself on first paint and whenever the graph changes shape, so the
 * common case needs no interaction at all.
 */

const NODE_W = 208
const NODE_H = 74
const GAP_X = 96          // between generations
const GAP_Y = 22          // between siblings

interface Placed { node: LineageNode; x: number; y: number }

/** Tidy-ish tree layout: generation on x, packed subtrees on y. A version can
 *  only have one parent, so the graph is a forest and this is enough — no
 *  crossing-minimisation needed. */
function layout(g: LineageGraph): { placed: Placed[]; w: number; h: number } {
  const byHash = new Map(g.nodes.map((n) => [n.hash, n]))
  const parentOf = new Map<string, string>()
  for (const e of g.edges) if (byHash.has(e.from)) parentOf.set(e.to, e.from)

  const kids = new Map<string, LineageNode[]>()
  const roots: LineageNode[] = []
  // Oldest first, so a branch reads top-to-bottom in the order it happened.
  const ordered = [...g.nodes].sort((a, b) =>
    a.created_at.localeCompare(b.created_at))
  for (const n of ordered) {
    const p = parentOf.get(n.hash)
    if (p && byHash.has(p)) kids.set(p, [...(kids.get(p) ?? []), n])
    else roots.push(n)
  }

  const placed: Placed[] = []
  let cursor = 0
  const walk = (n: LineageNode, depth: number): number => {
    const children = kids.get(n.hash) ?? []
    let y: number
    if (children.length === 0) {
      y = cursor
      cursor += NODE_H + GAP_Y
    } else {
      const ys = children.map((c) => walk(c, depth + 1))
      // Centred on its children, which is what makes a fork read as a fork.
      y = (ys[0] + ys[ys.length - 1]) / 2
    }
    placed.push({ node: n, x: depth * (NODE_W + GAP_X), y })
    return y
  }
  for (const r of roots) {
    walk(r, 0)
    cursor += GAP_Y * 2     // breathing room between separate families
  }

  const w = Math.max(...placed.map((p) => p.x + NODE_W), NODE_W) + 8
  const h = Math.max(...placed.map((p) => p.y + NODE_H), NODE_H) + 8
  return { placed, w, h }
}

const reasonLabel = (code?: string | null) =>
  (code && FORK_REASONS[code]) || code || 'No reason code recorded'

/** What an arrow says. One change is worth naming; a list is not readable at
 *  nine pixels, so several are counted and the panel carries the detail. */
const edgeLabel = (e: { changes?: string[]; change?: string | null }) => {
  const cs = e.changes?.length ? e.changes : e.change ? [e.change] : []
  if (!cs.length) return 'forked'
  return cs.length === 1 ? cs[0] : `${cs.length} changes`
}

export default function LineageCanvas({ data, onOpen }: {
  data: LineageGraph
  /** Load this version into the workspace. With a destination, also go
   *  there; without one, stay — the hot-load that makes the PD, LGD and
   *  Scenarios stages show the selected model on their next visit. */
  onOpen?: (hash: string, dest?: 'pd' | 'lgd' | 'scenarios') => void
}) {
  const { placed, w, h } = useMemo(() => layout(data), [data])
  const pos = useMemo(
    () => new Map(placed.map((p) => [p.node.hash, p])), [placed])

  const [sel, setSel] = useState<
    { kind: 'node'; hash: string } | { kind: 'edge'; to: string } | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  // Fit on load and whenever the graph changes shape — the common case is a
  // graph that fits, and it should need no interaction to be readable.
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const cw = el.clientWidth - 24
    const ch = el.clientHeight - 24
    const k = Math.min(1, cw / w, ch / h)
    setView({ x: (cw - w * k) / 2 + 12, y: 12, k })
  }, [w, h])

  useEffect(() => {
    const el = frame.current
    if (!el) return
    // Non-passive so the page does not scroll under a zoom gesture.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setView((v) => {
        // Scale by the wheel DELTA, not a fixed step per event: a trackpad
        // fires dozens of small events per flick, and a fixed 1.12x each
        // rocketed the zoom across its whole range in one gesture.
        const k = Math.min(2.5, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0022)))
        // Keep the point under the cursor fixed.
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const fit = () => {
    const el = frame.current
    if (!el) return
    const cw = el.clientWidth - 24
    const ch = el.clientHeight - 24
    const k = Math.min(1, cw / w, ch / h)
    setView({ x: (cw - w * k) / 2 + 12, y: 12, k })
  }

  const detail: LineageNode | null =
    sel ? pos.get(sel.kind === 'node' ? sel.hash : sel.to)?.node ?? null : null
  const detailEdge: LineageEdge | null =
    detail ? data.edges.find((e) => e.to === detail.hash) ?? null : null
  const detailParent = detailEdge ? pos.get(detailEdge.from)?.node ?? null : null

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="relative">
        <div ref={frame}
             onPointerDown={(e) => {
               if ((e.target as HTMLElement).closest('[data-node],[data-edge]')) return
               drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
               ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
             }}
             onPointerMove={(e) => {
               const d = drag.current
               if (!d) return
               setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x),
                                       y: d.vy + (e.clientY - d.y) }))
             }}
             onPointerUp={() => { drag.current = null }}
             onPointerCancel={() => { drag.current = null }}
             className="relative h-[420px] cursor-grab touch-none overflow-hidden rounded-card border border-hairline bg-sunken/40 active:cursor-grabbing">
          <div className="absolute origin-top-left"
               style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
                        width: w, height: h }}>
            <svg width={w} height={h} className="absolute inset-0 overflow-visible">
              {data.edges.map((e) => {
                const a = pos.get(e.from)
                const b = pos.get(e.to)
                if (!a || !b) return null
                const x1 = a.x + NODE_W
                const y1 = a.y + NODE_H / 2
                const x2 = b.x
                const y2 = b.y + NODE_H / 2
                const mid = (x1 + x2) / 2
                const on = sel?.kind === 'edge' && sel.to === e.to
                return (
                  <g key={`${e.from}-${e.to}`} data-edge
                     onClick={() => setSel({ kind: 'edge', to: e.to })}
                     className="cursor-pointer">
                    {/* a fat invisible hit area — a 1px line is unclickable */}
                    <path d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                          fill="none" stroke="transparent" strokeWidth={14} />
                    <path d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                          fill="none"
                          stroke={on ? 'var(--accent)' : 'var(--chrome-border-strong)'}
                          strokeWidth={on ? 2 : 1.25} />
                    <circle cx={x2 - 3} cy={y2} r={2.5}
                            fill={on ? 'var(--accent)' : 'var(--chrome-border-strong)'} />
                    {/* What changed, on the edge: the graph explains itself.
                        One change is named; several are counted, because a
                        list does not fit on an arrow — the panel has it. */}
                    <text x={mid} y={(y1 + y2) / 2 - 6} textAnchor="middle"
                          className="pointer-events-none"
                          style={{ fontSize: 9, fill: on ? 'var(--accent)' : 'var(--ink-muted)' }}>
                      {edgeLabel(e)}
                    </text>
                  </g>
                )
              })}
            </svg>

            {placed.map(({ node, x, y }) => {
              const on = sel?.kind === 'node' && sel.hash === node.hash
              const champ = node.status === 'champion'
              const fromSearch = !!node.origin?.name
              return (
                <button key={node.hash} data-node
                        onClick={() => {
                          setSel({ kind: 'node', hash: node.hash })
                          // Selecting a model IS opening it: the workbenches
                          // show it from here on, without leaving this page.
                          onOpen?.(node.hash)
                        }}
                        style={{ left: x, top: y, width: NODE_W, height: NODE_H,
                                 borderColor: on ? 'var(--accent)'
                                   : champ ? 'var(--accent)' : 'var(--chrome-border)',
                                 boxShadow: on
                                   ? '0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)'
                                   : undefined }}
                        className="absolute rounded-card border bg-raised px-2.5 py-2 text-left hover:border-accent">
                  <div className="flex items-center gap-1">
                    {node.starred && <span className="text-micro">★</span>}
                    <span className="truncate text-xs font-medium text-ink">{node.name}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-micro text-ink-muted">
                    <span>{node.n_variables} vars</span>
                    {node.auc != null && <span className="tnum">AUC {node.auc.toFixed(3)}</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    {champ && (
                      <span className="rounded-full px-1.5 text-micro"
                            style={{ background: 'color-mix(in srgb, var(--status-good) 18%, transparent)',
                                     color: 'var(--status-good)' }}>champion</span>
                    )}
                    {fromSearch && (
                      <span className="truncate rounded-full border border-hairline px-1.5 text-micro text-ink-muted"
                            title={`Taken from the screening leaderboard as ${node.origin!.name}`}>
                        from screening{node.origin!.rank != null
                          ? ` · rank ${node.origin!.rank}` : ''}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          <div className="absolute right-2 top-2 flex gap-1">
            {[['−', () => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.2) }))],
              ['+', () => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.2) }))],
             ].map(([label, fn]) => (
              <button key={label as string} onClick={fn as () => void}
                className="h-6 w-6 rounded-ctl border border-hairline bg-surface text-xs text-ink-secondary hover:text-ink">
                {label as string}
              </button>
            ))}
            <button onClick={fit}
              className="h-6 rounded-ctl border border-hairline bg-surface px-2 text-micro text-ink-secondary hover:text-ink">
              Fit
            </button>
          </div>
          <p className="pointer-events-none absolute bottom-2 left-3 text-micro text-ink-muted">
            Drag to pan · scroll to zoom · click a model or an arrow
          </p>
        </div>
      </div>

      {/* ── the story, beside the graph ─────────────────────────────────── */}
      <div className="rounded-card border border-hairline bg-surface p-3">
        {!detail ? (
          <p className="text-xs leading-relaxed text-ink-secondary">
            Select a model to see where it came from and why it was changed.
            An arrow carries the rationale recorded when the change was made.
          </p>
        ) : (
          <div className="space-y-3 text-xs">
            <div>
              <div className="flex items-center gap-1.5">
                {detail.starred && <span>★</span>}
                <span className="font-medium text-ink">{detail.name}</span>
              </div>
              <div className="mt-0.5 font-mono text-micro text-ink-muted">{detail.hash}</div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-micro">
              <Stat label="Status" value={detail.status} />
              <Stat label="Variables" value={String(detail.n_variables)} />
              {detail.auc != null && <Stat label="AUC (test)" value={detail.auc.toFixed(3)} />}
              <Stat label="Saved" value={detail.created_at.slice(0, 10)} />
            </div>

            <div className="border-t border-hairline pt-2">
              <h5 className="mb-1 text-micro font-medium uppercase tracking-wide text-ink-muted">
                Where it came from
              </h5>
              {detailParent ? (
                <p className="leading-relaxed text-ink-secondary">
                  Forked from <span className="font-medium text-ink">{detailParent.name}</span>.
                </p>
              ) : detail.fork?.from_name ? (
                <p className="leading-relaxed text-ink-secondary">
                  Forked from{' '}
                  <span className="font-medium text-ink">{detail.fork.from_name}</span>,
                  which is no longer saved on this book.
                </p>
              ) : detail.origin?.name ? (
                <p className="leading-relaxed text-ink-secondary">
                  Taken from the screening leaderboard as{' '}
                  <span className="font-medium text-ink">{detail.origin.name}</span>
                  {detail.origin.rank != null && <> at rank {detail.origin.rank}</>}
                  {detail.origin.config_hash && (
                    <> · run <span className="font-mono text-micro">
                      {detail.origin.config_hash.slice(0, 8)}</span></>
                  )}.
                </p>
              ) : (
                <p className="leading-relaxed text-ink-muted">
                  Built by hand on this book. No parent recorded.
                </p>
              )}
            </div>

            {onOpen && (
              <div className="border-t border-hairline pt-2">
                <h5 className="mb-1.5 text-micro font-medium uppercase tracking-wide text-ink-muted">
                  Open this model
                </h5>
                <div className="flex gap-1.5">
                  {([['pd', 'PD'], ['lgd', 'LGD'], ['scenarios', 'Scenarios']] as const)
                    .map(([dest, label]) => (
                      <button key={dest}
                        onClick={() => onOpen(detail.hash, dest)}
                        className="rounded-ctl border border-hairline px-2.5 py-1 text-xs text-ink-secondary hover:text-ink">
                        {label}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {(detail.fork?.reason_code || detail.fork?.justification) && (
              <div className="rounded-ctl border border-hairline p-2"
                   style={{ borderLeftWidth: 3, borderLeftColor: 'var(--accent)' }}>
                <h5 className="mb-1 text-micro font-medium uppercase tracking-wide text-ink-muted">
                  Why it was changed
                </h5>
                {(detail.fork.changes?.length
                  ? detail.fork.changes
                  : detail.fork.change ? [detail.fork.change] : []).map((c) => (
                  <p key={c} className="font-mono text-micro text-ink-secondary">
                    {c}
                  </p>
                ))}
                <p className="font-medium text-ink">{reasonLabel(detail.fork.reason_code)}</p>
                {detail.fork.justification && (
                  <p className="mt-1 leading-relaxed text-ink-secondary">
                    “{detail.fork.justification}”
                  </p>
                )}
                {detail.fork.at && (
                  <p className="mt-1 text-micro text-ink-muted">
                    Recorded {detail.fork.at.slice(0, 10)}
                  </p>
                )}
              </div>
            )}

            {!detail.fork?.reason_code && detailParent && (
              <p className="text-micro text-ink-muted">
                No rationale was recorded for this fork. Versions saved before
                the fork gate existed carry none.
              </p>
            )}

            {detail.notes && !detail.fork?.justification && (
              <div className="border-t border-hairline pt-2">
                <h5 className="mb-1 text-micro font-medium uppercase tracking-wide text-ink-muted">
                  Notes
                </h5>
                <p className="leading-relaxed text-ink-secondary">{detail.notes}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-ink-muted">{label}</div>
      <div className="text-ink">{value}</div>
    </div>
  )
}
