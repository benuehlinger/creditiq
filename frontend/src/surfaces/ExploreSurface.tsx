import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey, type ScreenRow } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill } from '../components/ui'
import BinningEditor from '../components/BinningEditor'
import SelectionTray from '../components/SelectionTray'
import CorrelationPanel from '../components/CorrelationPanel'
import BinStability from '../components/BinStability'
import TreatmentControl from '../components/TreatmentControl'
import { useUi } from '../lib/store'
import { num, pct } from '../lib/format'
import { diverging, mode } from '../design/tokens'

type Tab = 'variables' | 'correlation'

export default function ExploreSurface() {
  const { portfolio = 'consumer' } = useParams()
  const treatments = useUi((s) => s.treatments[portfolio as PortfolioKey] ?? {})
  const setTreatment = useUi((s) => s.setTreatment)
  const [tab, setTab] = useState<Tab>('variables')
  const [column, setColumn] = useState<string | null>(null)
  const [edges, setEdges] = useState<number[] | undefined>(undefined)
  const [maxBins, setMaxBins] = useState(8)

  const screen = useQuery({ queryKey: ['screen', portfolio], queryFn: () => api.screen(portfolio) })

  // Default to the strongest variable that is NOT leakage-shaped. Opening on a
  // contaminated variable would teach the wrong first lesson.
  useEffect(() => {
    if (!screen.data || column) return
    const first = screen.data.rows.find((r: ScreenRow) => r.leakage_risk !== 'likely' && !r.error)
    setColumn(first?.column ?? screen.data.rows[0]?.column ?? null)
  }, [screen.data, column])

  useEffect(() => { setEdges(undefined) }, [column, portfolio])

  const binning = useQuery({
    queryKey: ['binning', portfolio, column, edges?.join(','), maxBins],
    queryFn: () => api.binning(portfolio, column!, edges, maxBins),
    enabled: !!column,
    placeholderData: (prev) => prev,      // hold the previous render while refitting
  })

  if (screen.isLoading) {
    return <div className="grid gap-3 p-4 lg:grid-cols-[280px_minmax(0,1fr)_240px]">
      <Skeleton className="h-[600px]" /><Skeleton className="h-[600px]" /><Skeleton className="h-[600px]" />
    </div>
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-1">
        {(['variables', 'correlation'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-ctl px-3 py-1 text-xs font-medium capitalize transition-colors ${
              tab === t ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:text-ink-secondary'}`}>
            {t === 'correlation' ? 'Correlation & multicollinearity' : 'Variables & binning'}
          </button>
        ))}
        <span className="ml-auto text-micro text-ink-muted">{screen.data?.sample_note}</span>
      </div>

      {tab === 'correlation' ? (
        <CorrelationPanel portfolio={portfolio} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)_260px]">
          <IvRanking rows={screen.data!.rows} selected={column} onSelect={setColumn}
                     floors={screen.data!.floors} nullNote={screen.data!.null_note} />

          <div className="min-w-0 space-y-3">
            {binning.data && (
              <>
                {binning.data.leakage_risk !== 'none' && (
                  <LeakageBanner risk={binning.data.leakage_risk}
                                 reason={binning.data.leakage_reason}
                                 lift={binning.data.max_bin_lift}
                                 bin={binning.data.max_lift_bin} />
                )}
                <Card>
                  <CardHead
                    title={`Binning — ${binning.data.column}`}
                    subtitle={`${binning.data.bins.length} bins · ${num(binning.data.n_total)} account-months · ${num(binning.data.n_events)} events`}
                    caption="Bin height is the event rate; fill is the weight of evidence, blue for safer and magenta for riskier. The grey footer band is each bin's share of the population."
                    right={
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-micro text-ink-muted">Information value</div>
                          <div className="text-lg font-semibold tabular-nums text-accent">
                            {binning.data.iv.toFixed(4)}
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          <button onClick={() => { setEdges(undefined); setMaxBins(8) }}
                            className="rounded border border-hairline px-2 py-0.5 text-micro text-ink-secondary hover:text-ink">
                            Auto-bin
                          </button>
                          <div className="flex items-center gap-1">
                            <button onClick={() => { setEdges(undefined); setMaxBins((v) => Math.max(3, v - 1)) }}
                              className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-secondary hover:text-ink">−</button>
                            <span className="text-micro tabular-nums text-ink-muted">{maxBins}</span>
                            <button onClick={() => { setEdges(undefined); setMaxBins((v) => Math.min(15, v + 1)) }}
                              className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-secondary hover:text-ink">+</button>
                          </div>
                        </div>
                      </div>
                    }
                  />
                  <TreatmentControl
                    value={treatments[binning.data.column] ?? 'woe'}
                    result={binning.data}
                    onChange={(t) => setTreatment(portfolio as PortfolioKey,
                                                  binning.data!.column, t)} />
                  {binning.data.kind === 'numeric' && binning.data.domain ? (
                    <BinningEditor result={binning.data} pending={binning.isFetching}
                                   onEdgesChange={(e) => setEdges(e)} />
                  ) : (
                    <p className="px-4 py-6 text-center text-xs text-ink-muted">
                      Categorical variable — levels are grouped rather than cut, so there
                      are no edges to drag. Grouping is on the level table below.
                    </p>
                  )}
                  <MonotonicityRow b={binning.data} />
                </Card>

                <BinStability portfolio={portfolio} column={binning.data.column}
                              edges={binning.data.edges ?? undefined} />

                <Card>
                  <CardHead title="Bin detail"
                    subtitle="Weight of evidence and information value contribution per bin"
                    caption="A bin holding under 2% of the book gives an unstable weight — merge it into a neighbour." />
                  <BinTable b={binning.data} />
                </Card>
              </>
            )}
          </div>

          <SelectionTray portfolio={portfolio} rows={screen.data!.rows} />
        </div>
      )}
    </div>
  )
}

function LeakageBanner({ risk, reason, lift, bin }: {
  risk: string; reason: string; lift: number; bin: string
}) {
  const likely = risk === 'likely'
  return (
    <div className="rounded-card border px-4 py-3"
         style={{
           borderColor: `var(--status-${likely ? 'critical' : 'warning'})`,
           background: `color-mix(in srgb, var(--status-${likely ? 'critical' : 'warning'}) 10%, transparent)`,
         }}>
      <div className="flex items-start gap-2">
        <StatusPill severity={likely ? 'critical' : 'warning'}>
          {likely ? 'Leakage likely' : 'Review'}
        </StatusPill>
        <div className="min-w-0 text-xs leading-relaxed text-ink">
          {reason}
          <div className="mt-1 text-tiny text-ink-secondary">
            Strongest bin “{bin}” · {lift.toFixed(1)}x event-capture lift.
            {likely && ' Helios does not block this variable — it flags it. The judgement is yours.'}
          </div>
        </div>
      </div>
    </div>
  )
}

function MonotonicityRow({ b }: { b: NonNullable<ReturnType<typeof useQuery>['data']> & any }) {
  const signMismatch = b.expected_sign != null && b.observed_sign != null
    && b.expected_sign !== b.observed_sign
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-hairline px-4 py-2 text-tiny">
      <span className="flex items-center gap-1.5">
        <span className="text-ink-muted">Monotonic</span>
        {b.kind === 'categorical' ? (
          <span className="text-ink-muted">n/a — nominal</span>
        ) : (
          <StatusPill severity={b.monotone ? 'good' : 'warning'}>{b.monotone_direction}</StatusPill>
        )}
      </span>
      {b.expected_sign != null && (
        <span className="flex items-center gap-1.5">
          <span className="text-ink-muted">Economic sign</span>
          <StatusPill severity={signMismatch ? 'critical' : 'good'}>
            {signMismatch ? 'flipped vs prior' : 'matches prior'}
          </StatusPill>
        </span>
      )}
      {b.warnings?.map((w: string) => (
        <span key={w} className="text-ink-secondary">· {w}</span>
      ))}
    </div>
  )
}

function BinTable({ b }: { b: any }) {
  const m = mode()
  const maxWoe = Math.max(...b.bins.map((x: any) => Math.abs(x.woe) || 0), 1e-9)
  return (
    <div className="thin-scroll max-h-[280px] overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-hairline text-tiny text-ink-muted">
            <th className="px-3 py-1.5 font-medium">Bin</th>
            <th className="px-3 py-1.5 text-right font-medium">Rows</th>
            <th className="px-3 py-1.5 text-right font-medium">%</th>
            <th className="px-3 py-1.5 text-right font-medium">Events</th>
            <th className="px-3 py-1.5 text-right font-medium">Event rate</th>
            <th className="px-3 py-1.5 text-right font-medium">WoE</th>
            <th className="px-3 py-1.5 font-medium">IV contribution</th>
          </tr>
        </thead>
        <tbody>
          {b.bins.map((x: any) => (
            <tr key={x.label} className="border-b border-hairline/40">
              <td className="px-3 py-1 font-mono text-tiny text-ink">
                {x.label}
                {x.is_special && <span className="ml-1 text-micro text-ink-muted">special</span>}
              </td>
              <td className="px-3 py-1 text-right tnum text-ink-secondary">{num(x.count)}</td>
              <td className="px-3 py-1 text-right tnum text-ink-muted">
                {(x.pct_of_total * 100).toFixed(1)}
              </td>
              <td className="px-3 py-1 text-right tnum text-ink-secondary">{num(x.events)}</td>
              <td className="px-3 py-1 text-right tnum text-ink-secondary">
                {pct(x.event_rate * 100, 3)}
              </td>
              <td className="px-3 py-1 text-right tnum" style={{ color: 'var(--ink-primary)' }}>
                {x.woe.toFixed(4)}
              </td>
              <td className="px-3 py-1">
                {/* a diverging bar keyed to the same ramp as the editor above, so
                    the two read as one system */}
                <div className="flex items-center gap-2">
                  <div className="relative h-2 w-24 rounded-sm bg-sunken">
                    <div className="absolute inset-y-0 rounded-sm"
                         style={{
                           left: x.woe < 0 ? `${50 - Math.min(Math.abs(x.woe) / maxWoe, 1) * 50}%` : '50%',
                           width: `${Math.min(Math.abs(x.woe) / maxWoe, 1) * 50}%`,
                           background: diverging(x.woe / maxWoe, m),
                         }} />
                    <div className="absolute inset-y-0 left-1/2 w-px bg-axis" />
                  </div>
                  <span className="tnum text-tiny text-ink-muted">
                    {x.iv_contribution.toFixed(4)}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IvRanking({ rows, selected, onSelect, floors, nullNote }: {
  rows: ScreenRow[]; selected: string | null; onSelect: (c: string) => void
  floors: Record<string, number>; nullNote: string
}) {
  const [q, setQ] = useState('')
  const [hideLeak, setHideLeak] = useState(false)
  const shown = useMemo(() => rows.filter((r) =>
    (!hideLeak || r.leakage_risk !== 'likely') &&
    (!q || r.column.toLowerCase().includes(q.toLowerCase()))), [rows, q, hideLeak])
  const maxIv = Math.max(...shown.map((r) => Math.min(r.iv || 0, 1.2)), 0.1)

  return (
    <Card className="flex h-fit max-h-[calc(100vh-190px)] flex-col">
      <CardHead title="Variable screen"
        subtitle={`${rows.length} candidates, ranked by information value`}
        caption="Bands: <0.02 not predictive · 0.02–0.1 weak · 0.1–0.3 medium · 0.3–0.5 strong · >0.5 check for leakage." />
      <div className="border-b border-hairline px-3 py-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…"
          className="w-full rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-muted" />
        <label className="mt-2 flex items-center gap-1.5 text-micro text-ink-muted">
          <input type="checkbox" checked={hideLeak} onChange={(e) => setHideLeak(e.target.checked)} />
          Hide leakage-shaped variables
        </label>
        <p className="mt-2 border-t border-hairline pt-2 text-micro leading-snug text-ink-muted">
          Null floor on this sample: <span className="tnum text-ink-secondary">{floors.numeric?.toFixed(3)}</span> numeric ·{' '}
          <span className="tnum text-ink-secondary">{floors.categorical?.toFixed(3)}</span> categorical.
          <span className="ml-1 cursor-help" title={nullNote}>ⓘ</span>
        </p>
      </div>
      <ul className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {shown.map((r) => {
          const active = r.column === selected
          const belowNull = !r.above_null
          return (
            <li key={r.column}>
              <button onClick={() => onSelect(r.column)}
                className={`w-full border-b border-hairline/40 px-3 py-2 text-left transition-colors ${
                  active ? 'bg-accent-soft' : 'hover:bg-sunken/60'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate font-mono text-tiny ${active ? 'text-ink' : 'text-ink-secondary'}`}>
                    {r.column}
                  </span>
                  <span className="shrink-0 tnum text-tiny text-ink">
                    {r.iv > 9 ? r.iv.toFixed(0) : r.iv.toFixed(3)}
                  </span>
                </div>
                <div className="mt-1 h-1 w-full rounded-full bg-sunken">
                  <div className="h-1 rounded-full"
                       style={{
                         width: `${Math.min((r.iv || 0) / maxIv, 1) * 100}%`,
                         background: r.leakage_risk === 'likely' ? 'var(--status-critical)'
                           : belowNull ? 'var(--deemphasis)' : 'var(--accent)',
                       }} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-ink-muted">
                  {r.leakage_risk === 'likely' && <StatusPill severity="critical">leakage</StatusPill>}
                  {r.leakage_risk === 'review' && <StatusPill severity="warning">review</StatusPill>}
                  {belowNull && r.leakage_risk === 'none' && (
                    <span title="Information value is at or below what a variable with no signal would score on this sample.">
                      below null
                    </span>
                  )}
                  {r.sign_ok === false && <StatusPill severity="critical">sign flip</StatusPill>}
                  {r.missing_pct > 15 && <span>{r.missing_pct.toFixed(0)}% missing</span>}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
