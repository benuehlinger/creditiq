import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, Skeleton, StatusPill } from '../components/ui'
import { useUi } from '../lib/store'
import { ratio, usd } from '../lib/format'

export default function VersionsSurface() {
  const { portfolio = 'consumer' } = useParams()
  const qc = useQueryClient()
  const picked = useUi((s) => s.selectedVariables[portfolio as PortfolioKey] ?? [])
  const [selected, setSelected] = useState<string[]>([])

  const list = useQuery({ queryKey: ['versions', portfolio],
                          queryFn: () => api.versions(portfolio) })
  const lineage = useQuery({ queryKey: ['lineage', portfolio],
                             queryFn: () => api.lineage(portfolio) })
  const cmp = useQuery({
    queryKey: ['compare', selected.join(',')],
    queryFn: () => api.compareVersions(selected),
    enabled: selected.length >= 2,
  })

  const save = useMutation({
    mutationFn: () => api.saveVersion({
      portfolio,
      variables: picked.map((c) => ({ column: c })),
      mevs: [],
      with_ecl: true,
      parent_hash: list.data?.find((v) => v.status === 'champion')?.hash ?? null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['versions', portfolio] })
      qc.invalidateQueries({ queryKey: ['lineage', portfolio] })
    },
  })
  const act = useMutation({
    mutationFn: ({ hash, kind }: { hash: string; kind: 'promote' | 'star' | 'delete' }) =>
      kind === 'promote' ? api.promoteVersion(hash)
        : kind === 'delete' ? api.deleteVersion(hash)
        : api.patchVersion(hash, { starred: !list.data?.find((v) => v.hash === hash)?.starred }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['versions', portfolio] })
      qc.invalidateQueries({ queryKey: ['lineage', portfolio] })
    },
  })

  const toggle = (h: string) =>
    setSelected((s) => s.includes(h) ? s.filter((x) => x !== h)
      : s.length >= 4 ? s : [...s, h])

  if (list.isLoading) return <div className="p-4"><Skeleton className="h-64" /></div>

  const versions = list.data ?? []

  return (
    <div className="space-y-3 p-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="text-xs text-ink-secondary">
            {versions.length} saved version{versions.length === 1 ? '' : 's'} ·
            {' '}every one is a portable JSON file that re-runs to identical numbers
          </div>
          <button onClick={() => save.mutate()} disabled={save.isPending || picked.length === 0}
            className="ml-auto rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            title={picked.length === 0 ? 'Select variables on Explore first' : 'Save the current specification'}>
            {save.isPending ? 'Saving…' : 'Save current specification'}
          </button>
          {selected.length >= 2 && (
            <button onClick={() => setSelected([])}
              className="rounded border border-hairline px-2 py-1 text-micro text-ink-muted hover:text-ink">
              Clear comparison ({selected.length})
            </button>
          )}
        </div>
      </Card>

      {versions.length === 0 ? (
        <Card><EmptyState title="No versions saved yet">
          Fit a model, then save it here. A version captures the data, the target, the
          sample design, every variable with its binning map, the estimator and the macro
          specification — so it can be emailed, diffed in git, and re-run to the same
          numbers.
        </EmptyState></Card>
      ) : (
        <Card>
          <CardHead title="Versions" subtitle={`${portfolio} · select 2 to 4 to compare`}
            caption="The name is derived from the configuration hash, so an identical specification always produces an identical name — an accidental duplicate is visible immediately." />
          <div className="thin-scroll overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-hairline text-tiny text-ink-muted">
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Vars</th>
                  <th className="px-3 py-2 text-right font-medium">AUC test</th>
                  <th className="px-3 py-2 text-right font-medium">AUC OOT</th>
                  <th className="px-3 py-2 text-right font-medium">ECL sev. adverse</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.hash} className={`border-b border-hairline/40 ${
                    selected.includes(v.hash) ? 'bg-accent-soft' : ''}`}>
                    <td className="px-3 py-1.5">
                      <input type="checkbox" checked={selected.includes(v.hash)}
                        onChange={() => toggle(v.hash)} />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        {v.starred && <span title="Starred">★</span>}
                        <span className="font-medium text-ink">{v.name}</span>
                      </div>
                      <div className="font-mono text-micro text-ink-muted">{v.hash}</div>
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill severity={v.status === 'champion' ? 'good' : 'warning'}>
                        {v.status}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">
                      {v.metrics.n_variables ?? '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink">{ratio(v.metrics.auc_test)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{ratio(v.metrics.auc_oot)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">
                      {v.ecl?.ecl_severely_adverse ? usd(v.ecl.ecl_severely_adverse) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-tiny text-ink-muted">
                      {v.created_at.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-1">
                        {v.status !== 'champion' && (
                          <button onClick={() => act.mutate({ hash: v.hash, kind: 'promote' })}
                            className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">
                            promote
                          </button>
                        )}
                        <button onClick={() => act.mutate({ hash: v.hash, kind: 'star' })}
                          className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">
                          {v.starred ? 'unstar' : 'star'}
                        </button>
                        <a href={`/api/versions/${v.hash}/export`} download={`${v.name}.json`}
                          className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">
                          export
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {cmp.data && selected.length >= 2 && <CompareView cmp={cmp.data} />}
      {lineage.data && lineage.data.nodes.length > 1 && <Lineage data={lineage.data} />}
    </div>
  )
}

function CompareView({ cmp }: { cmp: import('../lib/api').CompareResult }) {
  const flips = cmp.coefficients.filter((c) => c.sign_flip)
  return (
    <div className="space-y-3">
      <Card>
        <CardHead title="Metric comparison"
          subtitle={`${cmp.versions.length} versions`}
          caption="Coloured by direction: green where the version is better on that metric, red where it is worse." />
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-hairline text-tiny text-ink-muted">
              <th className="px-4 py-2 font-medium">Metric</th>
              {cmp.versions.map((v) => (
                <th key={v.hash} className="px-3 py-2 text-right font-medium">{v.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cmp.metrics.map((row) => {
              const vals = row.values.filter((x): x is number => x != null)
              const best = row.better === 'up' ? Math.max(...vals) : Math.min(...vals)
              const worst = row.better === 'up' ? Math.min(...vals) : Math.max(...vals)
              return (
                <tr key={row.key} className="border-b border-hairline/40">
                  <td className="px-4 py-1.5 text-ink-secondary">{row.label}</td>
                  {row.values.map((v, i) => (
                    <td key={i} className="px-3 py-1.5 text-right tnum"
                        style={{ color: v == null ? undefined
                          : v === best && vals.length > 1 ? 'var(--good-text)'
                          : v === worst && vals.length > 1 ? 'var(--status-critical)'
                          : 'var(--ink-secondary)' }}>
                      {v == null ? '—' : row.key.startsWith('ecl') ? usd(v) : v.toFixed(4)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title="Variable set difference"
            caption="A set diff, not two lists to eyeball." />
          <div className="space-y-2 px-4 py-3 text-xs">
            <div>
              <span className="text-ink-muted">Shared: </span>
              <span className="font-mono text-ink-secondary">
                {cmp.variables.shared.join(', ') || 'none'}
              </span>
            </div>
            {cmp.versions.map((v) => {
              const added = cmp.variables.added[v.hash] ?? []
              const missing = cmp.variables.missing[v.hash] ?? []
              if (!added.length && !missing.length) return null
              return (
                <div key={v.hash} className="border-t border-hairline pt-2">
                  <div className="text-tiny font-medium text-ink">{v.name}</div>
                  {added.length > 0 && (
                    <div className="mt-0.5"><span className="text-ink-muted">only here: </span>
                      <span className="font-mono" style={{ color: 'var(--good-text)' }}>
                        {added.join(', ')}</span></div>
                  )}
                  {missing.length > 0 && (
                    <div className="mt-0.5"><span className="text-ink-muted">absent: </span>
                      <span className="font-mono" style={{ color: 'var(--status-critical)' }}>
                        {missing.join(', ')}</span></div>
                  )}
                </div>
              )
            })}
          </div>
        </Card>

        <Card>
          <CardHead title="Coefficient comparison"
            subtitle={`${cmp.variables.shared.length} shared variables`}
            caption="A sign flip between specifications is a real finding about collinearity, not a rounding difference — so it is listed first and flagged."
            right={flips.length > 0 && (
              <StatusPill severity="critical">{flips.length} sign flip{flips.length === 1 ? '' : 's'}</StatusPill>
            )} />
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-hairline text-tiny text-ink-muted">
                <th className="px-4 py-2 font-medium">Variable</th>
                {cmp.versions.map((v) => (
                  <th key={v.hash} className="px-3 py-2 text-right font-medium">{v.name.split('-')[0]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cmp.coefficients.map((c) => (
                <tr key={c.variable} className="border-b border-hairline/40">
                  <td className="px-4 py-1.5 font-mono text-tiny">
                    <span className="text-ink">{c.variable}</span>
                    {c.sign_flip && <span className="ml-1.5"><StatusPill severity="critical">flip</StatusPill></span>}
                  </td>
                  {c.values.map((v, i) => (
                    <td key={i} className="px-3 py-1.5 text-right tnum text-ink-secondary">
                      {v == null ? '—' : v.toFixed(4)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  )
}

function Lineage({ data }: { data: { nodes: any[]; edges: any[] } }) {
  const byHash = new Map(data.nodes.map((n) => [n.hash, n]))
  const depth = new Map<string, number>()
  const parent = new Map<string, string>()
  data.edges.forEach((e) => parent.set(e.to, e.from))
  const d = (h: string): number => {
    if (depth.has(h)) return depth.get(h)!
    const p = parent.get(h)
    const v = p && byHash.has(p) ? d(p) + 1 : 0
    depth.set(h, v)
    return v
  }
  data.nodes.forEach((n) => d(n.hash))
  const maxDepth = Math.max(...[...depth.values()], 0)

  return (
    <Card>
      <CardHead title="Lineage"
        subtitle={`${data.nodes.length} versions · ${data.edges.length} forks`}
        caption="Which specification came from which. It tells the story of the analyst's afternoon in one picture." />
      <div className="thin-scroll overflow-x-auto px-4 py-3">
        <div className="flex gap-6">
          {Array.from({ length: maxDepth + 1 }, (_, level) => (
            <div key={level} className="flex min-w-[180px] flex-col gap-2">
              <div className="text-micro uppercase tracking-wider text-ink-muted">
                {level === 0 ? 'origin' : `fork ${level}`}
              </div>
              {data.nodes.filter((n) => depth.get(n.hash) === level).map((n) => (
                <div key={n.hash}
                  className="rounded-card border px-3 py-2"
                  style={{ borderColor: n.status === 'champion' ? 'var(--accent)' : 'var(--chrome-border)' }}>
                  <div className="flex items-center gap-1.5">
                    {n.starred && <span>★</span>}
                    <span className="text-xs font-medium text-ink">{n.name}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-micro text-ink-muted">
                    <span>{n.n_variables} vars</span>
                    {n.auc != null && <span className="tnum">AUC {n.auc.toFixed(3)}</span>}
                  </div>
                  {n.status === 'champion' && (
                    <div className="mt-1"><StatusPill severity="good">champion</StatusPill></div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
