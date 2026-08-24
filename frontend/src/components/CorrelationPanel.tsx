import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill } from './ui'
import { useUi, NONE } from '../lib/store'
import { diverging, mode } from '../design/tokens'
import type { PortfolioKey } from '../lib/api'

/** Correlation, clustering and the one-per-cluster assist.
 *
 *  The matrix is hierarchically clustered so correlated blocks sit together and
 *  are visible, rather than scattered across an alphabetical grid. Colour is
 *  DIVERGING on the signed correlation with a neutral grey midpoint — the
 *  midpoint has to read as "nothing", which is why it is grey and not a hue. */
export default function CorrelationPanel({ portfolio }: { portfolio: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['corr', portfolio], queryFn: () => api.correlation(portfolio),
  })
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null)
  const toggleVariable = useUi((s) => s.toggleVariable)
  const picked = useUi((s) => s.selectedVariables[portfolio as PortfolioKey] ?? NONE) as string[]
  const m = mode()

  const cell = useMemo(() => (data ? Math.max(9, Math.min(26, 620 / data.columns.length)) : 16),
    [data])

  if (isLoading || !data) return <Skeleton className="h-[560px]" />

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHead
          title="Correlation matrix"
          subtitle={`${data.columns.length} numeric candidates · ${data.method} · hierarchically clustered`}
          caption="Blocks of correlated variables sit together. Blue is negative, magenta positive, grey is no relationship."
        />
        <div className="thin-scroll overflow-auto p-4">
          <div className="inline-block">
            <div style={{ display: 'grid', gridTemplateColumns: `160px repeat(${data.columns.length}, ${cell}px)` }}>
              <div />
              {data.columns.map((c: string, j: number) => (
                <div key={c} className="relative" style={{ height: 110 }}>
                  <span className="absolute bottom-1 left-1/2 origin-bottom-left -rotate-90 whitespace-nowrap font-mono text-micro text-ink-muted"
                        style={{ transformOrigin: 'bottom left' }}>
                    {c}
                  </span>
                </div>
              ))}
              {data.columns.map((rname: string, i: number) => (
                <>
                  <div key={`r${rname}`} className="truncate pr-2 text-right font-mono text-micro leading-none text-ink-muted"
                       style={{ height: cell, lineHeight: `${cell}px` }}>
                    {rname}
                  </div>
                  {data.columns.map((cname: string, j: number) => {
                    const v = data.matrix[i][j]
                    const on = hover?.i === i || hover?.j === j
                    return (
                      <div key={`${rname}-${cname}`}
                        onMouseEnter={() => setHover({ i, j })}
                        onMouseLeave={() => setHover(null)}
                        title={`${rname} × ${cname}\n${data.method} r = ${v.toFixed(3)}`}
                        style={{
                          width: cell, height: cell,
                          // the 2px surface gap does the separating, not a border
                          background: i === j ? 'var(--chrome-grid)' : diverging(v, m),
                          outline: on ? '1px solid var(--accent)' : 'none',
                          boxShadow: `inset 0 0 0 1px var(--surface-chart)`,
                        }} />
                    )
                  })}
                </>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <div className="space-y-3">
        <Card>
          <CardHead title="High correlation pairs"
            subtitle="|r| ≥ 0.90"
            caption="At this level of correlation the two variables carry close to the same information. Including both makes the individual coefficients unstable and their signs unreliable." />
          {data.high_pairs.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-muted">No pair above 0.90.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {data.high_pairs.slice(0, 10).map((p: { a: string; b: string; corr: number }) => (
                <li key={`${p.a}-${p.b}`} className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0 font-mono text-tiny text-ink-secondary">
                    <div className="truncate">{p.a}</div>
                    <div className="truncate">{p.b}</div>
                  </div>
                  <StatusPill severity={p.corr > 0.95 ? 'critical' : 'warning'}>
                    r {p.corr.toFixed(3)}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHead title="One per cluster"
            subtitle={`${data.clusters.length} clusters at |r| ≥ 0.70`}
            caption="The highest information value in each correlated cluster. Selecting from this list is optional; nothing is applied automatically." />
          <ul className="divide-y divide-hairline">
            {data.clusters.filter((c: { members: string[] }) => c.members.length > 1).map((c: { cluster: number; members: string[]; recommended: string }) => (
              <li key={c.cluster} className="px-4 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-tiny text-ink">{c.recommended}</span>
                  <button
                    onClick={() => toggleVariable(portfolio as PortfolioKey, c.recommended)}
                    className={`rounded border px-1.5 py-0.5 text-micro ${
                      picked.includes(c.recommended)
                        ? 'border-accent text-accent' : 'border-hairline text-ink-muted hover:text-ink'}`}>
                    {picked.includes(c.recommended) ? 'selected' : 'add'}
                  </button>
                </div>
                <div className="mt-0.5 text-micro text-ink-muted">
                  over {c.members.filter((x: string) => x !== c.recommended).join(', ')}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
