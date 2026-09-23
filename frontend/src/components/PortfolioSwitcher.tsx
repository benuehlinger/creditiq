import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, type PortfolioInfo } from '../lib/api'
import { portfolioToken } from '../design/tokens'
import { useBookStates } from '../lib/progress'

/** Portfolio as top-level context.
 *
 *  Up to three books the switcher is a row of pills: one click to change book,
 *  and the whole demo is visible at once. Beyond three — tapes can be ingested
 *  without limit — the row cannot hold a pill per book without pushing the
 *  stage navigation and the model bar off the screen, so it collapses to a
 *  single control naming the current book, with the full list one click away.
 *
 *  Each book carries its own accent colour, used consistently across every
 *  chart and badge, so the user always knows where they are without reading. */
const SHORT: Record<string, string> = {
  consumer: 'Consumer', mortgage: 'Mortgage', cre: 'CRE',
}

const PILL_LIMIT = 3

function StateDot({ book }: { book?: { state: string; note: string } }) {
  if (!book || book.state === 'empty') return null
  return (
    <span aria-label={book.note}
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            book.state === 'draft' ? 'border' : ''}`}
          style={book.state === 'draft'
            ? { borderColor: 'var(--status-serious)' }
            : { background: book.state === 'open'
                ? 'var(--accent)' : 'var(--status-good)' }} />
  )
}

export default function PortfolioSwitcher() {
  const { portfolio } = useParams()
  const nav = useNavigate()
  const loc = useLocation()
  const { data, isError, refetch } = useQuery({ queryKey: ['portfolios'], queryFn: api.portfolios })
  const books = useBookStates()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const surface = loc.pathname.split('/')[2] ?? 'panel'

  // Close on click-outside and Escape — standard menu behaviour, no library.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A failed request must say so; a skeleton that never resolves reads as a
  // broken app. With staleTime Infinity nothing retries on its own, so the
  // retry is offered here.
  if (isError) {
    return (
      <button onClick={() => refetch()}
        className="shrink-0 rounded-ctl border border-hairline px-2.5 py-1 text-xs text-ink-secondary hover:text-ink"
        title="The book list could not be loaded from the server.">
        Books unavailable · retry
      </button>
    )
  }
  if (!data) {
    return <div className="skeleton h-7 w-48" />
  }

  const go = (key: string) => { setOpen(false); nav(`/${key}/${surface}`) }
  const bookState = (key: string) => books[key as keyof typeof books]

  if (data.length <= PILL_LIMIT) {
    return (
      <div
        role="tablist"
        aria-label="Portfolio"
        className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-ctl bg-sunken p-0.5"
      >
        {data.map((p) => {
          const active = p.key === portfolio
          const dot = portfolioToken(p.key)
          const book = bookState(p.key)
          return (
            <button
              key={p.key}
              role="tab"
              aria-selected={active}
              onClick={() => go(p.key)}
              title={`${p.label}. ${p.n_accounts.toLocaleString()} accounts, ${p.annual_default_rate_pct}% annualised default rate.`
                     + `\n\n${book?.note ?? ''}`}
              className={`flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors ${
                active ? 'bg-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink-secondary'
              }`}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: `var(--series-${dot.slot})` }}
              />
              {/* The short form always. Three full labels cost 551px of a
                  1440px strip, which is what squeezed the model identity and
                  its call to action at the right into an unreadable stub. The
                  full label is on the hover, with the book's statistics. */}
              <span className="max-w-[130px] truncate">{SHORT[p.key] ?? p.label}</span>
              <StateDot book={book} />
            </button>
          )
        })}
        <TapeButton active={loc.pathname === '/tapes'} onClick={() => nav('/tapes')} />
      </div>
    )
  }

  // Collapsed form: the current book on the button, every book in the menu.
  const current: PortfolioInfo | undefined = data.find((p) => p.key === portfolio)
  const dot = current ? portfolioToken(current.key) : null

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={current
          ? `${current.label}. ${current.n_accounts.toLocaleString()} accounts, ${current.annual_default_rate_pct}% annualised default rate.`
          : `${data.length} books loaded`}
        className="flex items-center gap-2 whitespace-nowrap rounded-ctl bg-sunken py-1 pl-2.5 pr-2 text-xs font-medium text-ink"
      >
        {current && dot ? (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: `var(--series-${dot.slot})` }} />
            <span className="max-w-[220px] truncate">{current.label}</span>
            <StateDot book={bookState(current.key)} />
          </>
        ) : (
          <span className="text-ink-secondary">{data.length} books</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden
             className="text-ink-muted">
          <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor"
                strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div role="listbox" aria-label="Portfolio"
             className="absolute left-0 top-full z-40 mt-1.5 min-w-[260px] rounded-card border border-hairline bg-raised py-1 shadow-lg">
          {data.map((p) => {
            const active = p.key === portfolio
            const d = portfolioToken(p.key)
            const book = bookState(p.key)
            return (
              <button
                key={p.key}
                role="option"
                aria-selected={active}
                onClick={() => go(p.key)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  active ? 'bg-accent-soft text-ink' : 'text-ink-secondary hover:bg-sunken hover:text-ink'
                }`}
              >
                <span className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: `var(--series-${d.slot})` }} />
                <span className="min-w-0 flex-1 truncate font-medium">{p.label}</span>
                <span className="shrink-0 font-mono text-micro text-ink-muted">
                  {p.n_accounts.toLocaleString()}
                </span>
                <StateDot book={book} />
              </button>
            )
          })}
          <div className="my-1 border-t border-hairline" />
          <button
            onClick={() => { setOpen(false); nav('/tapes') }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-secondary transition-colors hover:bg-sunken hover:text-ink"
          >
            <span className="flex h-2 w-2 shrink-0 items-center justify-center text-ink-muted">+</span>
            Load a loan tape
          </button>
        </div>
      )}
    </div>
  )
}

function TapeButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Load a loan tape: map a CSV or parquet panel onto the canonical schema and add it as a book."
      aria-label="Load a loan tape"
      className={`rounded-[5px] px-2 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink-secondary'
      }`}
    >
      +
    </button>
  )
}
