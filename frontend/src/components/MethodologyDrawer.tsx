import { useUi } from '../lib/store'
import { METHODOLOGY } from '../lib/methodology'

/** Being able to open this mid-demo and show the formula is worth more than any
 *  chart. Every computed quantity in the app is inspectable from here. */
export default function MethodologyDrawer() {
  const { methodologyOpen, setMethodology } = useUi()
  if (!methodologyOpen) return null
  const entry = METHODOLOGY[methodologyOpen]
  if (!entry) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/35" onClick={() => setMethodology(null)}>
      <aside
        className="thin-scroll h-full w-[520px] max-w-[92vw] overflow-y-auto border-l border-hairline bg-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-start justify-between gap-4 border-b border-hairline bg-raised px-5 py-4">
          <div>
            <div className="text-micro uppercase tracking-wider text-ink-muted">Methodology</div>
            <h2 className="mt-0.5 text-lg font-semibold">{entry.title}</h2>
          </div>
          <button
            onClick={() => setMethodology(null)}
            className="rounded-ctl border border-hairline px-2 py-1 text-tiny text-ink-secondary hover:text-ink"
          >
            Close
          </button>
        </header>
        <div className="space-y-4 px-5 py-5 text-sm leading-relaxed text-ink-secondary">
          {entry.body.map((b, i) =>
            b.kind === 'formula' ? (
              <pre
                key={i}
                className="thin-scroll overflow-x-auto rounded-card border border-hairline bg-sunken px-4 py-3 font-mono text-xs text-ink"
              >
                {b.text}
              </pre>
            ) : b.kind === 'note' ? (
              <p key={i} className="rounded-card border-l-2 border-accent bg-accent-soft px-3 py-2 text-xs text-ink">
                {b.text}
              </p>
            ) : (
              <p key={i}>{b.text}</p>
            ),
          )}
          {entry.references && (
            <div className="border-t border-hairline pt-4">
              <div className="text-micro uppercase tracking-wider text-ink-muted">References</div>
              <ul className="mt-2 space-y-1 text-xs">
                {entry.references.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
