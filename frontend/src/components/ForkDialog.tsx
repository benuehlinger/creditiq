import { useUi } from '../lib/store'

/**
 * The one fork confirmation, rendered by the shell.
 *
 * A saved model is immutable, so an edit while one is open has to fork. That
 * rule used to be enforced by wrapping each mutation at its call site, which
 * meant it held on the two fit surfaces and not on the two explore surfaces: a
 * saved model could be silently rewritten just by rebinning a variable, and
 * whether you were warned depended on which screen you happened to be on.
 *
 * The guard now lives in the store, so a mutation cannot avoid it. This
 * component only renders the question — which means there is one dialog with
 * one wording, rather than one per surface drifting apart.
 */
export default function ForkDialog() {
  const pending = useUi((s) => s.pendingEdit)
  const loaded = useUi((s) => (pending ? s.loaded[pending.portfolio] : null))
  const confirmEdit = useUi((s) => s.confirmEdit)
  const cancelEdit = useUi((s) => s.cancelEdit)
  if (!pending || !loaded) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
         onClick={cancelEdit}>
      <div className="max-w-md rounded-card border border-hairline bg-raised p-5"
           onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ink">This creates a new Model ID</h3>
        <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">{loaded.name}</span> is saved, and a
          saved model does not change. Changing{' '}
          <span className="font-mono text-tiny text-ink">{pending.label}</span> forks it:
          a new specification, a new hash, a new name, and {loaded.name} recorded as its
          parent. The original stays exactly as it was.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={cancelEdit}
            className="rounded-ctl border border-hairline px-3 py-1.5 text-xs text-ink-secondary">
            Keep viewing {loaded.name}
          </button>
          <button onClick={confirmEdit}
            className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
            Fork to a new model
          </button>
        </div>
      </div>
    </div>
  )
}
