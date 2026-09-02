import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useUi } from '../lib/store'
import { STATE_COLOUR, rollUpSummary, useProgress } from '../lib/progress'
import PortfolioSwitcher from './PortfolioSwitcher'
import { CoBrand, type CoBrandVariant } from './Brand'
import ForkDialog from './ForkDialog'
import CommandPalette from './CommandPalette'
import MethodologyDrawer from './MethodologyDrawer'
import ModelBar from './ModelBar'

/** Five destinations. Two of them have stages, which appear in the row below
 *  rather than inline here — nesting them in one row put seven links, two group
 *  labels, three portfolio pills and two status chips in a single 44px strip. */
interface Surface { to: string; label: string; key: string; stages?: { to: string; label: string }[] }

const SURFACES: Surface[] = [
  { to: 'data', label: 'Data', key: '1' },
  { to: 'macro', label: 'Macro', key: '2' },
  { to: 'pd', label: 'PD model', key: '3' },
  { to: 'lgd', label: 'LGD model', key: '4' },
  { to: 'scenarios', label: 'Scenarios', key: '5' },
  { to: 'versions', label: 'Versions', key: '6' },
]

export default function AppShell() {
  const { portfolio } = useParams()
  const { pathname } = useLocation()
  // Stage state rides on the navigation that already exists rather than on a row
  // of its own: a second row listing the same destinations was duplication, and
  // the state was the only part of it that was not.
  const { stages: progressStages } = useProgress(portfolio)
  const nav = useNavigate()
  const { theme, toggleTheme, setPaletteOpen } = useUi()
  const brandVariant = useUi((s) => s.brandVariant) as CoBrandVariant
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health })

  // The portfolio accent is set on <html>, so every chart, badge and focus ring
  // in the workspace follows the book being worked on without threading a prop.
  useEffect(() => {
    const el = document.documentElement
    if (portfolio) el.setAttribute('data-portfolio', portfolio)
    else el.removeAttribute('data-portfolio')
  }, [portfolio])

  // Keyboard navigation throughout — live-demo insurance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return
      const s = SURFACES.find((x) => x.key === e.key)
      if (s && portfolio) nav(`/${portfolio}/${s.stages ? s.stages[0].to : s.to}`)
      if (e.key === '0') nav('/rollup')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [portfolio, nav, setPaletteOpen])

  return (
    <div className="flex h-full flex-col bg-page text-ink">
      {/* ── row 1: identity, the executive view, and global controls ── */}
      <header className="flex h-16 shrink-0 items-center gap-5 border-b border-hairline bg-raised px-5">
        {/* Two marks, side by side and separated by a rule: KPMG says who built
            it, CreditIQ says what it is. Never fused into one graphic — that
            would be inventing a co-brand nobody approved. Both are driven from
            one scale so they cannot drift apart. */}
        <button onClick={() => nav('/rollup')} className="text-left"
                title="CreditIQ: go to the portfolio roll-up">
          <CoBrand scale={1} variant={brandVariant} />
        </button>

        <span className="h-6 w-px bg-hairline" />
        {/* Typographic treatment only — no fabricated client logo. The label
            speaks in the same voice as the product descriptor: tracked
            capitals over the name, so the header reads as one set piece
            rather than three unrelated text styles. */}
        <span className="flex flex-col gap-1">
          <span className="font-medium uppercase text-ink-muted"
                style={{ fontSize: 7.5, letterSpacing: '0.18em', lineHeight: 1 }}>
            Prepared for
          </span>
          <span className="text-sm font-medium leading-none text-ink">Apollo FIG</span>
        </span>

        {/* Global status. Neither of these is portfolio navigation, and the row
            below was running out of room while this one had space to spare. */}
        <div className="ml-6 hidden items-center gap-3 whitespace-nowrap text-micro text-ink-muted lg:flex">
          {health && (
            <span title={`FRED cache built ${health.mev_cache_built_at}. The app runs fully offline.`}>
              {health.mev_series_resolved} MEV series · offline
            </span>
          )}
          {/* Permanent, on every data-bearing view: it stops a screenshot being
              mistaken for a real book. */}
          <span className="flex items-center gap-1.5 rounded border border-hairline px-1.5 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Synthetic demonstration data
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <NavLink
            to="/rollup"
            className={({ isActive }) =>
              `rounded-ctl px-2.5 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-accent-soft text-ink'
                  : 'text-ink-secondary hover:bg-sunken hover:text-ink'
              }`
            }
            title="Portfolio roll-up (0)"
          >
            Portfolio Roll-Up
          </NavLink>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-1.5 rounded-ctl border border-hairline px-2 py-1 text-tiny text-ink-muted hover:text-ink"
            title="Command palette"
          >
            <span>Jump to</span>
            <kbd className="rounded bg-sunken px-1 font-mono text-micro">⌘K</kbd>
          </button>
          <button
            onClick={toggleTheme}
            className="rounded-ctl border border-hairline px-2 py-1 text-tiny text-ink-secondary hover:text-ink"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      {/* ── row 2: portfolio context and the six surfaces ── */}
      <div className="flex h-11 shrink-0 items-center gap-4 border-b border-hairline bg-surface px-4">
        <PortfolioSwitcher />
        {portfolio && (
          <nav className="flex shrink-0 items-center gap-0.5">
            {/* The dots carry stage state and nothing else. Numbered steps,
                connector dashes and a next-step accent ring were each tried
                here and rejected as clutter; the call to action at the right
                of this row is what names the next step. */}
            {SURFACES.map((s) => {
              const on = s.stages
                ? pathname.startsWith(`/${portfolio}/${s.to}/`)
                : pathname === `/${portfolio}/${s.to}`
              const summary = rollUpSummary(progressStages, s.to)
              const state = summary?.state ?? null
              return (
                <NavLink
                  key={s.to}
                  to={`/${portfolio}/${s.stages ? s.stages[0].to : s.to}`}
                  title={summary?.note ?? (state === 'done' ? 'Complete' : 'Not started')}
                  className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ctl px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    on ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary'}`}
                >
                  {state && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full ring-1"
                          style={{ background: STATE_COLOUR[state],
                                   // a hollow ring reads as "not started" without
                                   // spending a colour on the absence of work.
                                   // An accent ring marking the NEXT stage was
                                   // tried and read as an unexplained third
                                   // state; the call to action already names
                                   // the next step, so the dots carry state
                                   // alone.
                                   ['--tw-ring-color' as string]: state === 'todo'
                                     ? 'var(--chrome-axis)' : 'transparent' }} />
                  )}
                  {s.label}
                  {on && (
                    <span className="absolute inset-x-2 -bottom-[9px] h-0.5 rounded-full bg-accent" />
                  )}
                </NavLink>
              )
            })}
          </nav>
        )}

        {/* Which model these screens are showing, and the one thing to do next.
            This was a third row of chrome; with the stages folded into the
            workbenches it is one line, and it belongs beside the navigation
            whose dots already carry the detail. */}
        {portfolio && (
          <div className="ml-auto flex min-w-0 shrink items-center whitespace-nowrap">
            <ModelBar />
          </div>
        )}
      </div>


      <ForkDialog />

      {/* A workspace does not get better by being wider. Past roughly this
          point the columns stop gaining anything and the eye has to travel the
          whole window to pair a label with its value, so the content is capped
          and centred rather than stretched to fill. */}
      <main className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1560px]">
          <Outlet />
        </div>
      </main>

      <CommandPalette />
      <MethodologyDrawer />
    </div>
  )
}
