import { useEffect } from 'react'
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useUi } from '../lib/store'
import PortfolioSwitcher from './PortfolioSwitcher'
import { CreditIQLockup, KpmgMark } from './Brand'
import CommandPalette from './CommandPalette'
import MethodologyDrawer from './MethodologyDrawer'

const SURFACES = [
  { to: 'data', label: 'Data', key: '1' },
  { to: 'explore', label: 'Explore', key: '2' },
  { to: 'model', label: 'Model', key: '3' },
  { to: 'scenarios', label: 'Scenarios', key: '4' },
  { to: 'versions', label: 'Versions', key: '5' },
]

export default function AppShell() {
  const { portfolio } = useParams()
  const nav = useNavigate()
  const { theme, toggleTheme, setPaletteOpen } = useUi()
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
      if (s && portfolio) nav(`/${portfolio}/${s.to}`)
      if (e.key === '0') nav('/rollup')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [portfolio, nav, setPaletteOpen])

  return (
    <div className="flex h-full flex-col bg-page text-ink">
      {/* ── row 1: identity, the executive view, and global controls ── */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-hairline bg-raised px-4">
        {/* Two marks, side by side and separated by a rule: KPMG says who built
            it, CreditIQ says what it is. They are never fused into one graphic —
            that would be inventing a co-brand nobody approved. */}
        <KpmgMark height={21} />
        <span className="h-5 w-px bg-hairline" />
        <button onClick={() => nav('/rollup')} className="text-left"
                title="CreditIQ — go to the portfolio roll-up">
          <CreditIQLockup size={24} nameSize={16} />
        </button>

        <span className="h-4 w-px bg-hairline" />
        {/* Typographic treatment only — no fabricated client logo. */}
        <span className="text-xs text-ink-secondary">
          Prepared for <span className="font-medium text-ink">Apollo FIG</span>
        </span>

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

      {/* ── row 2: portfolio context and the five surfaces ── */}
      <div className="flex h-11 shrink-0 items-center gap-5 border-b border-hairline bg-surface px-4">
        <PortfolioSwitcher />
        {portfolio && (
          <nav className="flex items-center gap-0.5">
            {SURFACES.map((s) => (
              <NavLink
                key={s.to}
                to={`/${portfolio}/${s.to}`}
                className={({ isActive }) =>
                  `relative rounded-ctl px-3 py-1.5 text-xs font-medium transition-colors ${
                    isActive ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {s.label}
                    {isActive && (
                      <span className="absolute inset-x-2 -bottom-[9px] h-0.5 rounded-full bg-accent" />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-3 text-micro text-ink-muted">
          {health && (
            <span title={`FRED cache built ${health.mev_cache_built_at}. The app runs fully offline.`}>
              {health.mev_series_resolved} MEV series · offline
            </span>
          )}
          {/* Permanent, on every data-bearing view. Honesty is a feature, and it
              stops a screenshot being mistaken for a real book. */}
          <span className="flex items-center gap-1.5 rounded border border-hairline px-1.5 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Synthetic demonstration data
          </span>
        </div>
      </div>

      <main className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>

      <CommandPalette />
      <MethodologyDrawer />
    </div>
  )
}
