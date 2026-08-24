import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import { STATE_COLOUR, useProgress } from '../lib/progress'

/** A compact progress readout that opens the full stage list.
 *
 *  The stages were previously a permanent row of their own, which listed the
 *  same destinations as the navigation directly above it. The links were the
 *  duplication; the STATE was the part worth keeping. So the state moved onto
 *  the navigation as dots, and the detail — notes per stage, and what has
 *  changed since a saved model was opened — lives here, one click away. */
export default function ProgressChip() {
  const { portfolio } = useParams()
  const nav = useNavigate()
  const { stages, loaded, done, changed, mode, next } = useProgress(portfolio)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  useEffect(() => { setOpen(false) }, [portfolio])

  if (!portfolio || !stages.length) return null

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((v) => !v)}
        title="Progress through this book's model"
        className={`flex items-center gap-1.5 rounded-ctl border px-2 py-1 text-micro transition-colors ${
          open ? 'border-accent text-ink' : 'border-hairline text-ink-muted hover:text-ink'}`}>
        <span className="hidden items-center gap-[3px] 2xl:flex">
          {stages.map((s) => (
            <span key={s.to} className="h-1.5 w-1.5 rounded-full"
                  style={{ background: s.state === 'todo' ? 'var(--chrome-axis)'
                             : STATE_COLOUR[s.state] }} />
          ))}
        </span>
        <span className="tabular-nums">{done}/{stages.length}</span>
        {changed > 0 && (
          <span style={{ color: 'var(--status-serious)' }}>· unsaved</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-80 overflow-hidden rounded-card border border-hairline bg-raised py-1 shadow-lg">
          <p className="px-3 pb-1 pt-1.5 text-micro uppercase tracking-wide text-ink-muted">
            Model build
          </p>
          {stages.map((s) => (
            <NavLink key={s.to} to={`/${portfolio}/${s.to}`} onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-start gap-2 px-3 py-1.5 text-tiny transition-colors ${
                  isActive ? 'bg-accent-soft' : 'hover:bg-sunken'}`}>
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: s.state === 'todo' ? 'var(--chrome-axis)'
                               : STATE_COLOUR[s.state] }} />
              <span className="min-w-0 flex-1">
                <span className="text-ink">{s.label}</span>
                {s.optional && (
                  <span className="ml-1 text-micro text-ink-muted">optional</span>
                )}
                {s.note && (
                  <span className="block truncate text-micro text-ink-muted">{s.note}</span>
                )}
              </span>
              {s.state === 'changed' && (
                <span className="shrink-0 text-micro" style={{ color: 'var(--status-serious)' }}>
                  changed
                </span>
              )}
            </NavLink>
          ))}
          <div className="mt-1 border-t border-hairline px-3 py-2">
            {loaded && (
              <p className="text-micro leading-relaxed"
                 style={{ color: mode === 'edited' ? 'var(--status-serious)'
                   : mode === 'drifted' ? 'var(--status-critical)' : 'var(--ink-muted)' }}>
                {mode === 'edited'
                  ? `Edited from ${loaded.name} in ${changed} stage${changed === 1 ? '' : 's'}. Saving keeps ${loaded.name} and creates a new Model ID.`
                  : mode === 'drifted'
                    ? `Nothing edited, but replaying ${loaded.name} produced a different Model ID. The inputs have changed since it was saved.`
                    : `Unmodified from ${loaded.name}.`}
              </p>
            )}
            {/* One instruction. The dots say where things stand; this says what
                to do about it. */}
            <p className="mt-1 text-micro leading-relaxed text-ink-secondary">
              {next
                ? <>Next: <button onClick={() => { setOpen(false); nav(`/${portfolio}/${next.to}`) }}
                      className="font-medium text-accent underline">{next.label}</button></>
                : 'Nothing outstanding.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
