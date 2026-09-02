import type React from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { type PortfolioKey } from '../lib/api'
import { useUi, NONE } from '../lib/store'
import { columns } from '../lib/spec'
import { useModelIdentity, useProgress } from '../lib/progress'
import { ArrowRight } from './icons'

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

export default function ModelBar() {
  const { portfolio } = useParams()
  const pk = portfolio as PortfolioKey
  const nav = useNavigate()
  const loc = useLocation()
  const fitted = useUi((s) => (pk ? s.fitted[pk] : null))
  const lgd = useUi((s) => (pk ? s.fittedLgd[pk] : null))
  const loaded = useUi((s) => (pk ? s.loaded[pk] : null))
  // Select the SPECIFICATION, then derive the column list outside the selector.
  // `columns()` maps, so calling it inside the selector returns a new array on
  // every call, Zustand compares with Object.is, and the component re-renders
  // without end — see the note on NONE in the store.
  const pdSpec = useUi((s) => (pk ? s.pdSpec[pk] : undefined))
  const picked = pdSpec ? columns(pdSpec) : (NONE as string[])
  const setLoaded = useUi((s) => s.setLoaded)
  const setCta = useUi((s) => s.setCta)
  const progress = useProgress(portfolio)

  // Shared with the scenario stage, so the model cannot appear under two names
  // on two rows of the same screen.
  const ident = useModelIdentity(portfolio)

  if (!portfolio) return null

  // Derived from the one state machine, not recomputed here. Two components
  // deciding separately what "not fitted" means is how they end up disagreeing
  // on screen.
  const missing: string[] = []
  if (!fitted || progress.pdStale) missing.push('PD')
  if (!lgd?.hash || progress.lgdStale) missing.push('LGD')

  // Opening a saved version restores the PD half with its hash and the LGD half
  // without one, because the record stores no LGD hash and the frontend cannot
  // derive it. The severity stage re-estimates on mount and fills it in. Until
  // then the bar reported "LGD model not fitted", which is false: the model has
  // an LGD specification and it is on screen. It has not been replayed in this
  // session, which is a different thing and asks for a different action.
  const awaitingLgdReplay = !!loaded && !lgd?.hash
    && !!(lgd?.spec.drivers.length || lgd?.spec.categoricals.length)

  // The one-line account of which model is on screen. It used to be a row of
  // its own, under the section navigation, with the stage navigation on its
  // left; with the stages folded into the workbenches that row held a name and
  // a hash and forty pixels of nothing. It now sits at the right of the section
  // row. The long form of every state is on the hover, and the stage dots in
  // the navigation carry the detail.
  const pill = (label: string, tone: 'accent' | 'warning' | 'muted') => (
    <span className={`rounded px-1.5 py-0.5 font-medium ${
      tone === 'accent' ? 'bg-accent/15' : tone === 'warning' ? 'bg-warning/15' : 'bg-sunken'}`}
      style={{ color: tone === 'accent' ? 'var(--accent)'
        : tone === 'warning' ? 'var(--status-serious)' : 'var(--ink-muted)' }}>
      {label}
    </span>
  )

  let body: React.ReactNode
  let title: string
  if (loaded && missing.length === 0) {
    const edited = progress.mode === 'edited'
    const drifted = progress.mode === 'drifted'
    body = (
      <>
        {pill(edited ? 'Working draft' : 'Saved model',
              edited || drifted ? 'warning' : 'accent')}
        {edited && <span className="text-ink-muted">from</span>}
        <span className="font-medium text-ink">{loaded.name}</span>
        {edited && <EditSummary diff={progress.diff} />}
        {drifted && <span className="text-ink-muted">refit no longer matches the record</span>}
      </>
    )
    title = progress.mode === 'drifted'
      ? `Nothing has been edited, yet refitting this specification produced ${fitted?.hash}. The data, the specification format or the estimator has changed since ${loaded.name} was saved.`
      : edited
        ? `Edited since ${loaded.name} was opened. Saving creates ${ident.name ?? 'a new Model ID'} and leaves ${loaded.name} as it is.`
        : `${loaded.name} · ${loaded.hash}. Nothing has changed since it was opened.`
  } else if (missing.length) {
    const what = progress.pdStale && picked.length === 0 ? 'no PD variables'
      : progress.pdStale ? 'PD fit out of date'
      : awaitingLgdReplay ? 'LGD not re-estimated'
      : progress.lgdStale ? 'no LGD drivers'
      : missing.length === 2 ? 'no model fitted'
      : `${missing[0]} not fitted`
    body = (
      <>
        {pill('Working draft', 'muted')}
        <span className="text-ink-secondary">{what}</span>
        {fitted && <span className="font-mono text-micro text-ink-muted">{fitted.hash}</span>}
      </>
    )
    title = progress.pdStale && picked.length === 0
      ? 'No variables selected. The PD model needs a specification.'
      : progress.pdStale ? 'The PD specification changed. This fit is out of date.'
      : awaitingLgdReplay ? `${loaded!.name} is open. Its LGD half has not been re-estimated in this session.`
      : progress.lgdStale ? 'No LGD drivers selected.'
      : missing.length === 2 ? 'No model fitted yet.'
      : `${missing[0]} model not fitted. A Model ID requires both.`
  } else {
    body = (
      <>
        {pill('Working draft', 'muted')}
        <span className="font-medium text-ink">{ident.name ?? '…'}</span>
      </>
    )
    title = `${ident.hash ?? ''} · PD ${fitted!.request.variables.length} variables · LGD ${
      lgd!.spec.drivers.length + lgd!.spec.categoricals.length} drivers. Not yet saved.`
  }

  return (
    <div className="flex min-w-0 items-center gap-2 text-tiny" title={title}>
      <span className="flex min-w-0 items-center gap-2 truncate">{body}</span>
      {progress.next && (
        <button onClick={() => {
          const { to, label } = progress.next!
          // Clicking "Fit the PD model" while already on the PD stage used to
          // navigate to the page it was on — nothing visible happened, and a
          // button named after an action that does nothing reads as broken.
          // On the target stage, tell that stage to run the named action — but
          // ONLY for the doing CTAs. "Select PD variables" also targets the PD
          // stage, and the selection lives in the candidate list already on
          // screen; running a fit off that click would fit an incomplete
          // specification.
          const ACTIONABLE: Record<string, string> = {
            'Fit the PD model': 'pd', 'Fit the LGD model': 'lgd',
            'Save this model': 'versions', 'Save as a new version': 'versions',
          }
          if (loc.pathname.split('/')[2] === to) {
            const action = ACTIONABLE[label]
            if (action) setCta(action)
          } else nav(`/${portfolio}/${to}`)
        }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-ctl bg-accent px-2.5 py-1 text-xs font-medium text-white">
          {progress.next.label} <ArrowRight />
        </button>
      )}
      {loaded && (
        <button onClick={() => { setLoaded(pk, null); nav(`/${portfolio}/versions`) }}
          className="shrink-0 rounded-ctl border border-hairline px-2 py-1 text-xs text-ink-secondary hover:text-ink">
          Close
        </button>
      )}
    </div>
  )
}
