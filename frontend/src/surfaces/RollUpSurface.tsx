import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, HeroFigure, Skeleton, StatTile } from '../components/ui'
import { num, pct } from '../lib/format'
import { tokens } from '../design/tokens'

/** The executive view. Fully built in slice 9 — what is here now is the real
 *  consolidated position from the generated books, so the screen is honest at
 *  every commit rather than a mock. */
export default function RollUpSurface() {
  const nav = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['portfolios'], queryFn: api.portfolios })

  if (isLoading || !data) {
    return <div className="space-y-3 p-4"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>
  }

  const accounts = data.reduce((a, p) => a + p.n_accounts, 0)
  const rows = data.reduce((a, p) => a + p.n_rows, 0)
  const defaults = data.reduce((a, p) => a + p.n_defaults, 0)
  const blended = (defaults / rows) * 1200

  return (
    <div className="space-y-3 p-4">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <HeroFigure
            label="Blended annualized default rate"
            value={blended.toFixed(2)}
            unit="% / yr"
            sub={`Across ${data.length} portfolios · ${num(accounts)} accounts · ${num(rows)} account-months`}
          />
          <div className="flex divide-x divide-hairline">
            <StatTile label="Portfolios" value={String(data.length)} />
            <StatTile label="Accounts" value={num(accounts)} />
            <StatTile label="Defaults observed" value={num(defaults)} />
          </div>
        </div>
      </Card>

      <Card>
        <CardHead
          title="Position by portfolio"
          caption="Each book carries its own accent colour throughout the workspace. Select one to open it."
        />
        <div className="grid gap-px bg-hairline sm:grid-cols-3">
          {data.map((p) => {
            const c = tokens.portfolios[p.key]
            return (
              <button
                key={p.key}
                onClick={() => nav(`/${p.key}/data`)}
                className="group bg-surface p-4 text-left transition-colors hover:bg-sunken"
              >
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full"
                        style={{ background: `var(--series-${c.slot})` }} />
                  <span className="text-sm font-medium text-ink">{p.label}</span>
                </div>
                <div className="mt-3 text-3xl font-semibold tracking-tight"
                     style={{ color: `var(--series-${c.slot})` }}>
                  {pct(p.annual_default_rate_pct)}
                </div>
                <div className="mt-0.5 text-tiny text-ink-muted">annualized default rate</div>
                <dl className="mt-3 space-y-1 text-tiny">
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Accounts</dt>
                    <dd className="tnum text-ink-secondary">{num(p.n_accounts)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Target</dt>
                    <dd className="text-ink-secondary">{p.target.label}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">EAD method</dt>
                    <dd className="text-ink-secondary">
                      {p.ead_method === 'ccf' ? 'CCF / LEQ' : 'Amortizing'}
                    </dd>
                  </div>
                </dl>
              </button>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
