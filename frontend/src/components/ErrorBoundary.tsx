import { Component, type ReactNode } from 'react'

/** The floor under every render error.
 *
 *  A null reaching a `.toFixed` used to unmount the whole tree — a white
 *  screen, which reads as "the app is destroyed" when the actual damage is
 *  one cell of one table. React only offers class components for this. The
 *  boundary keeps the chrome alive, names the error, and offers the two
 *  honest exits; every specific crash it catches should still be fixed at
 *  its source, and the message is written to make that reportable.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode }, { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        <div className="rounded-card border border-hairline bg-raised px-5 py-4">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full"
                  style={{ background: 'var(--status-critical)' }} />
            <span className="text-tiny font-semibold uppercase tracking-wider text-ink">
              This view hit an error
            </span>
          </div>
          <p className="mt-2 max-w-[70ch] text-xs leading-relaxed text-ink-secondary">
            The rest of the application is unaffected. The error, for reporting:
          </p>
          <pre className="thin-scroll mt-2 overflow-x-auto rounded bg-sunken px-3 py-2 font-mono text-micro text-ink-secondary">
            {String(this.state.error)}
          </pre>
          <div className="mt-3 flex gap-2">
            <button onClick={() => this.setState({ error: null })}
              className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
              Try again
            </button>
            <button onClick={() => window.location.reload()}
              className="rounded-ctl border border-hairline px-3 py-1.5 text-xs text-ink-secondary hover:text-ink">
              Reload the app
            </button>
          </div>
        </div>
      </div>
    )
  }
}
