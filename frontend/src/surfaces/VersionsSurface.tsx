import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, Skeleton, StatusPill } from '../components/ui'
import { useUi, NONE } from '../lib/store'
import { useLoadVersion } from '../lib/loadVersion'
import { useProgress } from '../lib/progress'
import { ratio, usd } from '../lib/format'

/** A dash where a severity statistic should be.
 *
 *  Versions saved before the record measured LGD carry no severity numbers. The
 *  specification is still there and still re-runs; nothing was measured at the
 *  time. Saying so beats an unexplained dash. */
function NoLgd() {
  return (
    <span className="text-ink-muted"
          title="This version was saved before the record measured the severity model. Its LGD specification is intact and re-runs — open it and refit to record these numbers.">—</span>
  )
}

/** Root mean squared error on realised severity, out of time.
 *
 *  The calibration bias — mean predicted minus mean realised — is no longer its
 *  own column. It has not been dropped: it rides on this tooltip as the two
 *  means it is derived from, and it is a row in the comparison panel where two
 *  versions can be read against each other. A single version's bias in
 *  isolation is not a number anyone acts on; the same figure next to a rival's
 *  is. */
function LgdRmse({ m }: { m: Record<string, any> }) {
  const r = m.lgd_rmse as number | undefined
  if (r == null) return <td className="px-3 py-1.5 text-right tnum"><NoLgd /></td>
  const pts = (m.lgd_bias ?? 0) * 100
  return (
    <td className="px-3 py-1.5 text-right tnum text-ink-secondary"
        title={`Predicted ${(m.lgd_mean_predicted * 100).toFixed(1)}% against realised `
             + `${(m.lgd_mean_actual * 100).toFixed(1)}% on ${m.lgd_n} defaults, ${m.lgd_basis}`
             + `${m.lgd_basis_note ? ` (${m.lgd_basis_note})` : ''}. `
             + `Calibration bias ${pts >= 0 ? '+' : '−'}${Math.abs(pts).toFixed(2)} LGD points`
             + `${Math.abs(pts) < 0.5 ? ', immaterial against the interval on this many workouts'
                  : pts > 0 ? ' — severity is overstated, so the loss figure is too high'
                            : ' — severity is understated, so the loss figure is too low'}.`}>
      {r.toFixed(3)}
      {m.lgd_basis === 'in sample' && (
        <span className="ml-1 text-micro" style={{ color: 'var(--status-warning)' }}
              title="Scored in sample — this book cannot support an out-of-time severity split.">!</span>
      )}
    </td>
  )
}

/** The identity of each half, and whether it is shared with another version.
 *
 *  Severity is fitted on resolved defaults and never sees the PD
 *  specification, so changing PD leaves the LGD model unchanged down to its
 *  coefficients. Settling on a severity model and then iterating PD against it
 *  is therefore the normal way to work — and it leaves several versions
 *  carrying ONE severity model. Their severity columns agree, and without this
 *  nothing says whether that is one model seen twice or two that happen to
 *  agree. It matters: a miscalibrated severity model is inherited by every
 *  version bound to it, including a champion. */
function Components({ v, all }: {
  v: import('../lib/api').VersionRecord
  all: import('../lib/api').VersionRecord[]
}) {
  const pd = v.metrics.pd_hash as string | undefined
  const lgd = v.metrics.lgd_hash as string | undefined
  if (!pd && !lgd) return null

  const sharers = (key: 'pd_hash' | 'lgd_hash', h: string) =>
    all.filter((o) => o.hash !== v.hash && o.metrics[key] === h).map((o) => o.name)

  const part = (label: string, h: string | undefined, key: 'pd_hash' | 'lgd_hash') => {
    if (!h) return <span className="text-ink-muted">{label} —</span>
    const others = sharers(key, h)
    return (
      <span style={{ color: others.length ? 'var(--accent)' : undefined }}
            title={others.length
              ? `The same ${label} specification is in ${others.join(', ')}. It is one model, not a coincidence — anything wrong with it is wrong in all of them.`
              : `This ${label} specification is unique to this version.`}>
        {label} {h.slice(0, 8)}{others.length ? ` ·${others.length + 1}` : ''}
      </span>
    )
  }
  return (
    <div className="mt-0.5 flex gap-2 font-mono text-micro text-ink-muted">
      {part('PD', pd, 'pd_hash')}
      {part('LGD', lgd, 'lgd_hash')}
    </div>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export default function VersionsSurface() {
  const { portfolio = 'consumer' } = useParams()
  const qc = useQueryClient()
  const picked = useUi((s) => s.selectedVariables[portfolio as PortfolioKey] ?? NONE) as string[]
  const pk = portfolio as PortfolioKey
  const fitted = useUi((s) => s.fitted[pk])
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const loaded = useUi((s) => s.loaded[pk])
  const setLoaded = useUi((s) => s.setLoaded)
  // The tray can drift after a fit. One state machine decides this, so the
  // panel, the navigation and this surface cannot disagree about it.
  const progress = useProgress(portfolio)
  const stale = progress.pdStale || progress.lgdStale
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

  const [saveMode, setSaveMode] = useState<'new' | 'replace'>('new')

  const save = useMutation({
    // The request that was fitted is replayed unchanged. Rebuilding it from the
    // current tray state would save a different specification from the one on
    // the model surfaces.
    mutationFn: () => {
      if (!fitted) throw new Error('Fit a model first — there is nothing to save.')
      if (!fittedLgd) {
        throw new Error(
          'Fit an LGD model first. A Model ID covers the PD specification and the ' +
          'LGD specification together, because both of them produced the loss number.')
      }
      // `replaces` supersedes the open version: it inherits its status, tags and
      // starred flag, and the superseded file is removed. Without it both remain
      // and the new one records the other as its parent.
      const base = loaded?.hash ?? fitted.request.parent_hash ?? null
      return api.saveVersion({
        ...fitted.request,
        lgd: fittedLgd.spec,
        with_ecl: true,
        parent_hash: saveMode === 'replace' ? null : base,
        replaces: saveMode === 'replace' ? base : null,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['versions', portfolio] })
      qc.invalidateQueries({ queryKey: ['lineage', portfolio] })
    },
  })
  const load = useLoadVersion(portfolio)

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

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const toggle = (h: string) =>
    setSelected((s) => s.includes(h) ? s.filter((x) => x !== h)
      : s.length >= 4 ? s : [...s, h])

  if (list.isLoading) return <div className="p-4"><Skeleton className="h-64" /></div>

  const versions = list.data ?? []

  const pendingDelete = versions.find((v) => v.hash === confirmDelete)

  return (
    <div className="space-y-3 p-4">
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
             onClick={() => setConfirmDelete(null)}>
          <div className="max-w-md rounded-card border border-hairline bg-raised p-5"
               onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-ink">
              Delete {pendingDelete.name}?
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
              The specification file is removed. Versions recording it as their parent
              keep the reference, which will no longer resolve. Export it first if you
              need a copy.
              {pendingDelete.status === 'champion' && (
                <> This is the current champion for this book, so the roll-up will fall
                back to the documented default specification.</>
              )}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)}
                className="rounded-ctl border border-hairline px-3 py-1.5 text-xs text-ink-secondary">
                Cancel
              </button>
              <button
                onClick={() => {
                  act.mutate({ hash: pendingDelete.hash, kind: 'delete' })
                  if (loaded?.hash === pendingDelete.hash) setLoaded(pk, null)
                  setConfirmDelete(null)
                }}
                className="rounded-ctl px-3 py-1.5 text-xs font-semibold text-white"
                style={{ background: 'var(--status-critical)' }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 text-xs text-ink-secondary">
            {versions.length} saved version{versions.length === 1 ? '' : 's'} ·
            {' '}each is a JSON file holding the full specification
            {fitted && (
              <div className="mt-0.5 text-tiny text-ink-muted">
                {fittedLgd?.spec
                  ? <>Current specification: PD {plural(fitted.request.variables.length, 'variable')},
                      {' '}{plural(fitted.request.mevs.length, 'macro term')} · LGD
                      {' '}{plural(fittedLgd.spec.drivers.length + fittedLgd.spec.categoricals.length, 'driver')}
                      {loaded && <> · opened from <span className="text-ink">{loaded.name}</span></>}</>
                  : <>PD fitted ({fitted.request.variables.length} variables). A Model ID covers
                      the PD and LGD specifications together, so the LGD model is required
                      before this can be named.</>}
              </div>
            )}
          </div>
          {selected.length >= 2 && (
            <button onClick={() => setSelected([])}
              className="rounded border border-hairline px-2 py-1 text-micro text-ink-muted hover:text-ink">
              Clear comparison ({selected.length})
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {loaded && (
              <button onClick={() => { setSaveMode('replace'); save.mutate() }}
                disabled={save.isPending || !progress.complete || progress.mode === 'clean'}
                className="rounded-ctl border border-hairline px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink disabled:opacity-40"
                title={`Supersede ${loaded.name}. The new specification inherits its status, tags and starred flag, and ${loaded.name} is removed. The hash is derived from the specification, so it changes with the specification.`}>
                Update {loaded.name}
              </button>
            )}
            <button onClick={() => { setSaveMode('new'); save.mutate() }}
              disabled={save.isPending || !progress.complete || progress.mode === 'clean'}
              className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              title={
                progress.pdStale ? 'The PD fit no longer matches the selected variables. Refit before saving.'
                : progress.lgdStale ? 'No LGD drivers are selected. Refit before saving.'
                : !fitted ? 'Fit a PD model first'
                : !fittedLgd?.spec ? 'Fit an LGD model first — a Model ID covers both'
                : progress.mode === 'clean' ? `Nothing has changed since ${loaded!.name} was opened.`
                : loaded ? `Keep ${loaded.name} and save this as a separate version, recording ${loaded.name} as its parent.`
                : 'Save this specification as a version'}>
              {save.isPending ? 'Saving…'
                : progress.pdStale || progress.lgdStale ? 'Refit before saving'
                : !fitted ? 'No PD model'
                : !fittedLgd?.spec ? 'No LGD model'
                : progress.mode === 'clean' ? 'No changes to save'
                : loaded ? 'Save as a new version' : 'Save this model'}
            </button>
          </div>
        </div>
        {stale && (
          <div className="border-t border-hairline px-4 py-2">
            <StatusPill severity="warning">Selection changed since the fit</StatusPill>
            <span className="ml-2 text-tiny text-ink-secondary">
              {picked.length === 0
                ? <>No variables are selected, so there is no specification to save.
                    The last fit, {fitted!.name}, is still held and will be discarded
                    when you refit.</>
                : <>The variable tray no longer matches {fitted!.name}. Refit on the
                    PD model surface so the saved version is the model on screen.</>}
            </span>
          </div>
        )}
        {save.isError && (
          <div className="border-t border-hairline px-4 py-2 text-xs"
               style={{ color: 'var(--status-critical)' }}>{String(save.error)}</div>
        )}
      </Card>

      {versions.length === 0 ? (
        <Card><EmptyState title="No versions saved yet">
Fit a model, then save it here. A version records the data, the target, the
          sample design, every variable with its binning map, the estimator, the macro
          specification and the LGD specification. It can be exported and re-run to the same
          numbers.
        </EmptyState></Card>
      ) : (
        <Card>
          <CardHead title="Versions" subtitle={`${portfolio} · select 2 to 4 to compare`}
            caption="The name is derived from the configuration hash, so an identical specification always produces an identical name — an accidental duplicate is visible immediately." />
          <div className="thin-scroll overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface">
                {/* A model is a PD specification AND an LGD specification, and
                    the loss number comes from both. The columns are banded so it
                    is obvious which half each statistic describes — the list
                    previously reported PD only. */}
                <tr className="text-micro text-ink-muted">
                  <th className="px-3 pt-2" colSpan={3} />
                  <th className="border-l border-hairline px-3 pt-2 text-center font-medium"
                      colSpan={3}>PD</th>
                  <th className="border-l border-hairline px-3 pt-2 text-center font-medium"
                      colSpan={2}>LGD</th>
                  <th className="border-l border-hairline px-3 pt-2 text-center font-medium"
                      colSpan={2}>Lifetime ECL</th>
                  <th className="border-l border-hairline px-3 pt-2" colSpan={2} />
                </tr>
                <tr className="border-b border-hairline text-tiny text-ink-muted">
                  <th className="w-8 px-3 pb-2" />
                  <th className="px-3 pb-2 font-medium">Version</th>
                  <th className="px-3 pb-2 font-medium">Status</th>
                  <th className="border-l border-hairline px-3 pb-2 text-right font-medium"
                      title="Variables in the PD specification.">Vars</th>
                  <th className="px-3 pb-2 text-right font-medium"
                      title="Area under the ROC curve on the held-out test split. Rank ordering only — it says nothing about the level.">AUC test</th>
                  <th className="px-3 pb-2 text-right font-medium"
                      title="Area under the ROC curve on months after the out-of-time boundary, which were not used in estimation.">AUC OOT</th>
                  <th className="border-l border-hairline px-3 pb-2 text-right font-medium"
                      title="Drivers in the LGD specification.">Drivers</th>
                  <th className="px-3 pb-2 text-right font-medium"
                      title="Root mean squared error on realised severity, scored out of time, in LGD units. Hover a value for the predicted and realised means behind it. Calibration bias is in the comparison panel — select two or more versions.">RMSE</th>
                  <th className="border-l border-hairline px-3 pb-2 text-right font-medium"
                      title="Lifetime expected credit loss under the Federal Reserve supervisory baseline.">Baseline</th>
                  <th className="px-3 pb-2 text-right font-medium"
                      title="Lifetime expected credit loss under the Federal Reserve supervisory severely adverse scenario.">Sev. adverse</th>
                  <th className="px-3 pb-2 font-medium">Created</th>
                  <th className="px-3 pb-2 font-medium">Actions</th>
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
                        {v.data_is_current === false && (
                          <span className="rounded px-1 text-micro"
                                style={{ color: 'var(--status-warning)' }}
                                title="Fitted on a panel that no longer exists. The specification still re-runs — that is the point of it — but the stored metrics describe different data, so re-run it before quoting them.">
                            stale data
                          </span>
                        )}
                        <span className="font-medium text-ink">{v.name}</span>
                      </div>
                      <div className="font-mono text-micro text-ink-muted">{v.hash}</div>
                      <Components v={v} all={versions} />
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill severity={v.status === 'champion' ? 'good' : 'warning'}>
                        {v.status}
                      </StatusPill>
                    </td>
                    <td className="border-l border-hairline px-3 py-1.5 text-right tnum text-ink-secondary">
                      {v.metrics.n_variables ?? '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink">{ratio(v.metrics.auc_test)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{ratio(v.metrics.auc_oot)}</td>
                    <td className="border-l border-hairline px-3 py-1.5 text-right tnum text-ink-secondary">
                      {v.metrics.n_lgd_drivers ?? '—'}
                    </td>
                    <LgdRmse m={v.metrics} />
                    <td className="border-l border-hairline px-3 py-1.5 text-right tnum text-ink-secondary">
                      {v.ecl?.ecl_baseline ? usd(v.ecl.ecl_baseline) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink">
                      {v.ecl?.ecl_severely_adverse ? usd(v.ecl.ecl_severely_adverse) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-tiny text-ink-muted">
                      {v.created_at.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-1">
                        <button onClick={() => load.mutate(v.hash)}
                          disabled={load.isPending}
                          className="rounded border border-accent/50 px-1.5 py-0.5 text-micro font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
                          title="Replay this specification and put every surface into it — Explore, PD, LGD, Scenarios and the roll-up.">
                          {load.isPending && load.variables === v.hash ? 'loading…' : 'open'}
                        </button>
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
                        <button onClick={() => setConfirmDelete(v.hash)}
                          className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink"
                          style={{ borderColor: 'color-mix(in srgb, var(--status-critical) 40%, transparent)' }}
                          title="Delete this version. The JSON file is removed.">
                          delete
                        </button>
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
              // `zero` is a third direction, for a bias: the good value is the
              // one nearest nothing, which is neither the largest nor the
              // smallest signed number.
              const rank = (x: number) => (row.better === 'up' ? -x
                : row.better === 'zero' ? Math.abs(x) : x)
              const best = vals.length
                ? vals.reduce((a, b) => (rank(b) < rank(a) ? b : a)) : NaN
              const worst = vals.length
                ? vals.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : NaN
              return (
                <tr key={row.key} className="border-b border-hairline/40">
                  <td className="px-4 py-1.5 text-ink-secondary">{row.label}</td>
                  {row.values.map((v, i) => (
                    <td key={i} className="px-3 py-1.5 text-right tnum"
                        style={{ color: v == null ? undefined
                          : v === best && vals.length > 1 ? 'var(--good-text)'
                          : v === worst && vals.length > 1 ? 'var(--status-critical)'
                          : 'var(--ink-secondary)' }}>
                      {v == null ? '—' : row.key.startsWith('ecl') ? usd(v)
                        : row.key === 'lgd_bias'
                          ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)}pt`
                        : v.toFixed(4)}
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
            caption="Variables present in each version, shown as a set difference." />
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
            caption="Coefficients for variables shared by the selected versions. A coefficient that changes sign between specifications indicates collinearity with a term that differs between them, and is listed first."
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
        caption="The parent relationship between specifications. Each version records the model it was derived from." />
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
