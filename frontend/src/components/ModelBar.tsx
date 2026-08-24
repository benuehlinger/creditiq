import { useMemo } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey } from '../lib/api'
import { useUi, NONE } from '../lib/store'
import { STATE_COLOUR, useProgress } from '../lib/progress'

/** The stage within the current model, and the identity of the model on screen.
 *
 *  A model in CreditIQ is a PD specification together with an LGD
 *  specification. Expected credit loss is the product of PD, LGD and EAD, so an
 *  identifier covering only the PD specification would not identify what
 *  produced the loss figure. The identifier is withheld until both are fitted,
 *  and this row states which is outstanding. */
type Diff = NonNullable<ReturnType<typeof useProgress>['diff']>

/** What was actually changed since the version was opened.
 *
 *  This used to read "edited in 3 stages", which is a count of stages rather
 *  than an account of the work. Someone returning to the screen could not tell
 *  whether they had forked deliberately, changed one variable, or landed here by
 *  accident — the sets were known and thrown away. The names are now stated,
 *  and the full list is one hover away when there are too many to print. */
function EditSummary({ diff }: { diff: Diff | null }) {
  if (!diff) return <span>edited</span>

  const parts: { side: string; d: Diff['pd'] }[] = [
    { side: 'PD', d: diff.pd }, { side: 'LGD', d: diff.lgd },
  ]
  const touched = parts.filter((p) => p.d.added.length || p.d.removed.length)
  if (!touched.length) {
    return <span>{diff.needsRefit ? 'refit outstanding' : 'edited'}</span>
  }

  // Name the change where it is short enough to read at a glance; fall back to
  // counts when it is not. Either way the detail is on the tooltip.
  const phrase = (p: { side: string; d: Diff['pd'] }) => {
    const { added, removed } = p.d
    const brief = added.length + removed.length <= 2
    const bits: string[] = []
    if (added.length) {
      bits.push(brief ? `+${added.join(', +')}` : `+${added.length}`)
    }
    if (removed.length) {
      bits.push(brief ? `−${removed.join(', −')}` : `−${removed.length}`)
    }
    return `${p.side} ${bits.join(' ')}`
  }

  const detail = touched.map((p) => {
    const l: string[] = [`${p.side}: ${p.d.from} → ${p.d.to}`]
    if (p.d.added.length) l.push(`  added ${p.d.added.join(', ')}`)
    if (p.d.removed.length) l.push(`  removed ${p.d.removed.join(', ')}`)
    return l.join('\n')
  }).join('\n')

  return (
    <span className="truncate" title={`Changed since the version was opened:\n\n${detail}${
      diff.needsRefit ? '\n\nThe fit on screen no longer matches this specification. Refit before saving.' : ''}`}>
      <span className="font-mono text-tiny text-ink">{touched.map(phrase).join(' · ')}</span>
      {diff.needsRefit && (
        <span className="ml-1.5" style={{ color: 'var(--status-warning)' }}>refit needed</span>
      )}
    </span>
  )
}

export default function ModelBar({ stages }: {
  stages?: { to: string; label: string }[]
}) {
  const { portfolio } = useParams()
  const pk = portfolio as PortfolioKey
  const nav = useNavigate()
  const fitted = useUi((s) => (pk ? s.fitted[pk] : null))
  const lgd = useUi((s) => (pk ? s.fittedLgd[pk] : null))
  const loaded = useUi((s) => (pk ? s.loaded[pk] : null))
  const picked = useUi((s) => (pk ? s.selectedVariables[pk] ?? NONE : NONE)) as string[]
  const setLoaded = useUi((s) => s.setLoaded)
  const progress = useProgress(portfolio)

  const request = useMemo(() => (fitted
    ? { ...fitted.request, lgd: lgd?.spec ?? null }
    : null), [fitted, lgd])

  const ident = useQuery({
    queryKey: ['identity', portfolio, fitted?.hash, lgd?.hash],
    queryFn: () => api.identity(request!),
    enabled: !!request,
  })

  if (!portfolio) return null

  // Derived from the one state machine, not recomputed here. Two components
  // deciding separately what "not fitted" means is how they end up disagreeing
  // on screen.
  const missing: string[] = []
  if (!fitted || progress.pdStale) missing.push('PD')
  if (!lgd?.hash || progress.lgdStale) missing.push('LGD')

  return (
    <div className="flex h-10 shrink-0 items-center gap-4 border-b border-hairline bg-sunken px-4 text-tiny">
      {/* left: the stage within this model */}
      {stages ? (
        <div className="flex items-center gap-0.5 rounded-ctl bg-surface p-0.5">
          {stages.map((s) => {
            // The parent navigation item summarises; this is where the detail is.
            const st = progress.stages.find((x) => x.to === s.to)?.state
            return (
              <NavLink key={s.to} to={`/${portfolio}/${s.to}`}
                title={st === 'changed'
                  ? 'Changed since the saved model was opened'
                  : st === 'done' ? 'Complete' : 'Not started'}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 rounded-[5px] px-3 py-1 font-medium transition-colors ${
                    isActive ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:text-ink-secondary'}`}>
                {st && (
                  <span className="h-1.5 w-1.5 rounded-full ring-1"
                        style={{ background: STATE_COLOUR[st],
                                 ['--tw-ring-color' as string]: st === 'todo'
                                   ? 'var(--chrome-axis)' : 'transparent' }} />
                )}
                {s.label}
              </NavLink>
            )
          })}
        </div>
      ) : null}
      {stages && <span className="h-4 w-px bg-hairline" />}

      {/* right: which model these surfaces are showing, and the one thing to do
          next. Reporting state without saying what it wants left the reader to
          work it out from eight dots. */}
      {loaded && missing.length === 0 ? (
        <>
          <span className={`rounded px-1.5 py-0.5 font-medium ${
            progress.mode === 'edited' ? 'bg-warning/15' : 'bg-accent/15'}`}
            style={{ color: progress.mode === 'edited'
              ? 'var(--status-serious)' : 'var(--accent)' }}>
            {progress.mode === 'edited' ? 'Working draft' : 'Saved model'}
          </span>
          {/* "Working draft hardy-pergola-22" read as though the draft WERE that
              version. It came FROM it — which is the answer to "how did I get
              here", and the word carrying it was missing. */}
          {progress.mode === 'edited' && <span className="text-ink-muted">from</span>}
          <span className="font-medium text-ink">{loaded.name}</span>
          <span className="font-mono text-micro text-ink-muted">{loaded.hash}</span>

          {progress.mode === 'edited' ? (
            // Editing an opened model is the normal way to build a challenger.
            // This used to raise the same red alarm as a genuine replay
            // disagreement, which made routine work look like a fault.
            <span className="flex min-w-0 items-center gap-1.5 text-ink-secondary">
              <EditSummary diff={progress.diff} />
              <span className="whitespace-nowrap">—{' '}
                {ident.data?.name
                  ? <>saves as <span className="text-ink">{ident.data.name}</span></>
                  : 'saves as a new Model ID'}, leaving {loaded.name} as it is.
              </span>
            </span>
          ) : progress.mode === 'drifted' ? (
            // Nothing was edited and the replay still disagrees. That is a real
            // problem: the inputs or the estimator moved after this was written.
            <span className="truncate font-medium"
                  style={{ color: 'var(--status-critical)' }}
                  title={`Nothing has been edited, yet replaying this specification produced ${fitted?.hash}. The data, the specification format or the estimator has changed since ${loaded.name} was saved.`}>
              You changed nothing, but refitting gave a different model
              ({fitted?.name}). The data or the estimator has changed since this
              was saved.
            </span>
          ) : (
            <span className="truncate text-ink-muted">
              You have not changed anything since opening this model.
            </span>
          )}
        </>
      ) : missing.length ? (
        <>
          <span className="text-ink-muted">Working draft</span>
          <span className="truncate text-ink">
            {progress.pdStale && picked.length === 0
              ? 'no variables selected — the PD model needs a specification'
              : progress.pdStale
                ? `the PD fit no longer matches the ${picked.length} selected variables`
              : progress.lgdStale ? 'no LGD drivers selected'
              : missing.length === 2 ? 'no model fitted'
              : `${missing[0]} model not fitted — a Model ID requires both`}
          </span>
          {fitted && (
            <span className="font-mono text-micro text-ink-muted">
              PD {fitted.request.variables.length} vars · {fitted.hash}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="text-ink-muted">Working draft</span>
          <span className="font-medium text-ink">{ident.data?.name ?? '…'}</span>
          <span className="font-mono text-micro text-ink-muted">{ident.data?.hash}</span>
          <span className="truncate text-ink-muted">
            PD {fitted!.request.variables.length} vars · LGD {lgd!.spec.drivers.length +
              lgd!.spec.categoricals.length} drivers
          </span>
        </>
      )}

      {/* one call to action, never two */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {progress.next && (
          <button onClick={() => nav(`/${portfolio}/${progress.next!.to}`)}
            className="rounded-ctl bg-accent px-2.5 py-0.5 font-medium text-white">
            {progress.next.label} →
          </button>
        )}
        {loaded && (
          <button onClick={() => { setLoaded(pk, null); nav(`/${portfolio}/versions`) }}
            className="rounded-ctl border border-hairline px-2 py-0.5 text-ink-secondary hover:text-ink">
            Close
          </button>
        )}
      </div>
    </div>
  )
}
