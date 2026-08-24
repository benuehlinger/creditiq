import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { tokens } from '../design/tokens'

/** Portfolio as top-level context, not a dropdown on the data page.
 *
 *  Each book carries its own accent colour, used consistently across every chart
 *  and badge, so the user always knows where they are without reading. The three
 *  colours are palette slots 1-3, which are the three that clear the harder
 *  all-pairs gate — they appear together on the roll-up. */
const SHORT: Record<string, string> = {
  consumer: 'Consumer', mortgage: 'Mortgage', cre: 'CRE',
}

export default function PortfolioSwitcher() {
  const { portfolio } = useParams()
  const nav = useNavigate()
  const loc = useLocation()
  const { data } = useQuery({ queryKey: ['portfolios'], queryFn: api.portfolios })

  const surface = loc.pathname.split('/')[2] ?? 'data'

  if (!data) {
    return <div className="skeleton h-7 w-64" />
  }

  return (
    <div
      role="tablist"
      aria-label="Portfolio"
      className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-ctl bg-sunken p-0.5"
    >
      {data.map((p) => {
        const active = p.key === portfolio
        const dot = tokens.portfolios[p.key]
        return (
          <button
            key={p.key}
            role="tab"
            aria-selected={active}
            onClick={() => nav(`/${p.key}/${surface}`)}
            title={`${p.label} — ${p.n_accounts.toLocaleString()} accounts, ${p.annual_default_rate_pct}% annualized default rate`}
            className={`flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors ${
              active ? 'bg-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink-secondary'
            }`}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: `var(--series-${dot.slot})` }}
            />
            {/* The full label needs 180px for three books and the row has other
                work to do. Below xl the short form carries the same meaning. */}
            <span className="hidden xl:inline">{p.label}</span>
            <span className="xl:hidden">{SHORT[p.key] ?? p.label}</span>
          </button>
        )
      })}
    </div>
  )
}
