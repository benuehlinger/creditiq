import { useEffect, useState } from 'react'
import { useUi } from '../lib/store'

/**
 * The one fork confirmation, rendered by the shell.
 *
 * A saved model is immutable, and a model taken off a search leaderboard is a
 * recorded result: an edit to either is a DEPARTURE, and the departure gets a
 * written rationale here, at the moment it happens — not reconstructed at
 * save time from memory. The guard lives in the store, so a mutation cannot
 * avoid it; this component only renders the question, which means there is
 * one dialog with one wording rather than one per surface drifting apart.
 *
 * The rationale is required. "Coefficient sign contradicts historical
 * performance" written when the variable is dropped is an audit trail;
 * an empty note reconstructed three weeks later is not.
 */

export const FORK_REASONS: Record<string, string> = {
  sign_contradicts_history: 'Coefficient sign contradicts historical performance',
  unstable_coefficients: 'Unstable coefficients',
  parsimony: 'Parsimony: simpler specification preferred',
  weak_stress_response: 'Weak or implausible stress response',
  data_quality: 'Driver has a data-quality concern',
  business_judgment: 'Business judgment',
  other: 'Other',
}

export default function ForkDialog() {
  const pending = useUi((s) => s.pendingEdit)
  const loaded = useUi((s) => (pending ? s.loaded[pending.portfolio] : null))
  const origin = useUi((s) => (pending ? s.origin[pending.portfolio] : null))
  const confirmEdit = useUi((s) => s.confirmEdit)
  const cancelEdit = useUi((s) => s.cancelEdit)
  const [reason, setReason] = useState('')
  const [text, setText] = useState('')
  useEffect(() => { setReason(''); setText('') }, [pending])
  if (!pending || (!loaded && !origin)) return null

  const parentName = loaded?.name ?? origin!.name
  const ready = reason !== '' && text.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
         onClick={cancelEdit}>
      <div className="w-full max-w-md rounded-card border border-hairline bg-raised p-5"
           onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ink">
          {loaded ? 'This creates a new Model ID' : 'This revises a screening result'}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
          {loaded ? (
            <>
              <span className="font-medium text-ink">{parentName}</span> is saved,
              and a saved model does not change. Changing{' '}
              <span className="font-mono text-tiny text-ink">{pending.label}</span>{' '}
              forks it: a new specification, a new hash, a new name, and{' '}
              {parentName} recorded as its parent. One rationale covers the
              fork; every difference from {parentName} is measured when the
              model is saved, so keep editing freely after this.
            </>
          ) : (
            <>
              This draft came off the leaderboard as{' '}
              <span className="font-medium text-ink">{parentName}</span>
              {origin!.rank != null && <> (rank {origin!.rank})</>}. Changing{' '}
              <span className="font-mono text-tiny text-ink">{pending.label}</span>{' '}
              departs from that recorded result. This rationale covers the
              departure; every difference from {parentName} is measured when
              the model is saved, so keep editing freely after this.
            </>
          )}
        </p>
        <div className="mt-3 space-y-2">
          <label className="block text-tiny text-ink-muted">
            Reason
            <select value={reason} onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-xs text-ink">
              <option value="">Choose a reason code…</option>
              {Object.entries(FORK_REASONS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </label>
          <label className="block text-tiny text-ink-muted">
            Justification
            <textarea value={text} onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder={`Why ${parentName} needs this change…`}
              className="mt-1 w-full rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-xs text-ink" />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={cancelEdit}
            className="rounded-ctl border border-hairline px-3 py-1.5 text-xs text-ink-secondary">
            Keep {parentName} as it is
          </button>
          <button disabled={!ready}
            title={ready ? undefined
              : 'A reason code and a written justification are required — this is the audit record.'}
            onClick={() => confirmEdit({ reasonCode: reason,
                                         justification: text.trim() })}
            className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
            {loaded ? 'Fork to a new model' : 'Revise with this rationale'}
          </button>
        </div>
      </div>
    </div>
  )
}
