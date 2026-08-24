import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey, type ScreenRow } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill } from '../components/ui'
import BinningEditor from '../components/BinningEditor'
import VariableViews from '../components/VariableViews'
import SelectionTray from '../components/SelectionTray'
import CorrelationPanel from '../components/CorrelationPanel'
import BinStability from '../components/BinStability'
import TreatmentControl from '../components/TreatmentControl'
import { useUi, NONE, NO_MAP } from '../lib/store'
import { isDiscretised } from '../lib/api'
import { num, pct } from '../lib/format'
import { diverging, mode } from '../design/tokens'

type Tab = 'variables' | 'correlation'

export default function ExploreSurface() {
  const { portfolio = 'consumer' } = useParams()
  const treatments = useUi((s) => s.treatments[portfolio as PortfolioKey] ?? NO_MAP)
  const setTreatment = useUi((s) => s.setTreatment)
  const knots = useUi((s) => s.knots[portfolio as PortfolioKey] ?? NO_MAP)
  const picked = useUi((s) => s.selectedVariables[portfolio as PortfolioKey] ?? NONE) as string[]
  const toggleVariable = useUi((s) => s.toggleVariable)
  const setKnots = useUi((s) => s.setKnots)

  const [tab, setTab] = useState<Tab>('variables')
  const [column, setColumn] = useState<string | null>(null)
  const [edges, setEdges] = useState<number[] | undefined>(undefined)
  const [maxBins, setMaxBins] = useState(8)
  // Which of the two decisions this variable is currently on. Drives which
  // editor and which diagnostics the page shows.
  const treatment = (column ? treatments[column] : undefined) ?? 'woe'
  const [nKnots, setNKnots] = useState(4)

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
    queryKey: ['binning', portfolio, column, edges?.join(','), maxBins, nKnots],
    queryFn: () => api.binning(portfolio, column!, edges, maxBins, nKnots),
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
        <span className="mr-2 text-xs font-semibold text-ink">PD model — Explore</span>
        <span className="mr-3 text-tiny text-ink-muted">
          Candidate variables for the probability of default model, screened on
          account-months.
        </span>
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
                     picked={picked}
                     onToggle={(c) => toggleVariable(portfolio as PortfolioKey, c)}
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
                    title={isDiscretised(treatment)
                      ? `Binning — ${binning.data.column}`
                      : `Treatment — ${binning.data.column}`}
                    subtitle={isDiscretised(treatment)
                      ? `${binning.data.bins.length} bins · ${num(binning.data.n_total)} account-months · ${num(binning.data.n_events)} events`
                      : `${num(binning.data.n_total)} account-months · ${num(binning.data.n_events)} events`}
                    caption={isDiscretised(treatment)
                      ? "Bin height is the event rate; fill is the weight of evidence, blue for safer and magenta for riskier. The grey footer band is each bin's share of the population."
                      : undefined}
                    right={
                      <div className="flex items-center gap-3">
                        {/* The natural place to commit: look at the shape, then
                            add it. Previously only the tray's suggestion chips
                            could add a variable, so anything unsuggested was
                            unreachable. */}
                        <button
                          onClick={() => toggleVariable(portfolio as PortfolioKey,
                                                        binning.data!.column)}
                          className={`rounded-ctl px-2.5 py-1 text-micro font-medium ${
                            picked.includes(binning.data!.column)
                              ? 'border border-accent text-accent'
                              : 'bg-accent text-white'}`}>
                          {picked.includes(binning.data!.column)
                            ? '− Remove from specification' : '+ Add to specification'}
                        </button>
                        {/* Information value and the bin-count stepper describe a
                            discretisation. Shown beside a spline they invite a
                            comparison that does not exist. */}
                        {isDiscretised(treatment) && (
                          <div className="text-right">
                            <div className="text-micro text-ink-muted">Information value</div>
                            <div className="text-lg font-semibold tabular-nums text-accent">
                              {binning.data.iv.toFixed(4)}
                            </div>
                          </div>
                        )}
                        {isDiscretised(treatment) && (
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
                        )}
                      </div>
                    }
                  />
                  <TreatmentControl
                    value={treatment}
                    result={binning.data}
                    onChange={(t) => setTreatment(portfolio as PortfolioKey,
                                                  binning.data!.column, t)}
                    nKnots={nKnots} onKnots={setNKnots} />
                  {/* The editor follows the decision. A binning editor is an
                      editor for a decision a spline does not make, and leaving
                      it on screen for a continuous treatment was the single most
                      confusing thing on this page. */}
                  {isDiscretised(treatment) ? (
                    <>
                      {binning.data.kind === 'numeric' && binning.data.domain ? (
                        <BinningEditor result={binning.data} pending={binning.isFetching}
                                       onEdgesChange={(e) => setEdges(e)} />
                      ) : (
                        <CategoricalNote b={binning.data} />
                      )}
                      <MonotonicityRow b={binning.data} />
                    </>
                  ) : (
                    <p className="px-4 pb-2.5 text-micro text-ink-muted">
                      {treatment === 'continuous'
                        ? 'No binning and no information value — both are properties of a discretisation.'
                        : 'Knots are placed on the relationship panel below.'}
                    </p>
                  )}
                </Card>

                {/* The view that decides the treatment. It sits ABOVE stability
                    and the bin table because it answers the first question —
                    what shape is this — and those two answer later ones. */}
                <VariableViews
                  portfolio={portfolio}
                  column={binning.data.column}
                  treatment={treatment}
                  knots={knots[binning.data.column]}
                  nKnots={nKnots}
                  onKnots={(k) => setKnots(portfolio as PortfolioKey,
                                           binning.data!.column, k)}
                />

                {isDiscretised(treatment) && (
                  <BinStability portfolio={portfolio} column={binning.data.column}
                                edges={binning.data.edges ?? undefined} />
                )}

                {isDiscretised(treatment) && (
                <Card>
                  <CardHead title="Bin detail"
                    subtitle="Weight of evidence and information value contribution per bin"
                    caption="Weight of evidence and its contribution to information value, per bin. Bins holding under 2% of the population produce unstable weights." />
                  <BinTable b={binning.data} />
                </Card>
                )}
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
            {likely && ' CreditIQ does not block this variable — it flags it. The judgement is yours.'}
          </div>
        </div>
      </div>
    </div>
  )
}

/** What was done to a wide categorical, and why — stated rather than asked.
 *
 *  A mortgage tape carries a few hundred metros, most holding a fraction of a
 *  percent of the book. Left alone, weight of evidence hands a metro with a
 *  handful of loans a weight of its own, and the information value comes out
 *  nearly ten times its honest value. The app collapses the tail and shrinks thin
 *  cells automatically, then says so — the analyst should not have to know to
 *  ask. */
function CategoricalNote({ b }: { b: any }) {
  const collapsed = b.n_levels_raw > b.bins.length
  const shrunk = (b.shrinkage ?? 0) > 0
  if (!collapsed && !shrunk) {
    return (
      <p className="px-4 py-6 text-center text-xs text-ink-muted">
        Categorical with {b.n_levels_raw} levels — grouped rather than cut, so there
        are no edges to drag. The grouping is in the table below.
      </p>
    )
  }
  return (
    <div className="space-y-2 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill severity="warning">High cardinality</StatusPill>
        <span className="text-xs text-ink">
          {b.n_levels_raw} levels, reduced to {b.bins.length} bins
        </span>
      </div>
      <ul className="space-y-1.5 text-tiny leading-relaxed text-ink-secondary">
        {(b.warnings ?? []).map((w: string) => <li key={w}>· {w}</li>)}
      </ul>
      <p className="border-t border-hairline pt-2 text-micro leading-relaxed text-ink-muted">
        Both steps are applied automatically and both LOWER the information value.
        That is the point: most of the apparent signal in a wide categorical is the
        tail being handed weights it has not earned. Compare the value above with
        the null floor in the left-hand panel before selecting it.
      </p>
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

function IvRanking({ rows, selected, onSelect, floors, nullNote, picked, onToggle }: {
  rows: ScreenRow[]; selected: string | null; onSelect: (c: string) => void
  floors: Record<string, number>; nullNote: string
  /** Columns currently in the specification, and the control to change that.
   *  Clicking a row opens it for inspection; adding it is a separate action, so
   *  a variable can be examined without being committed to. Every row carries
   *  the control — the suggestion chips in the tray used to be the only way in,
   *  which meant anything not suggested could not be selected at all. */
  picked: string[]; onToggle: (c: string) => void
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
                  <span
                    role="checkbox"
                    aria-checked={picked.includes(r.column)}
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); onToggle(r.column) }}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault(); e.stopPropagation(); onToggle(r.column)
                      }
                    }}
                    title={picked.includes(r.column)
                      ? 'Remove from the specification'
                      : 'Add to the specification'}
                    className={`h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm border ${
                      picked.includes(r.column)
                        ? 'border-accent bg-accent' : 'border-hairline hover:border-accent'}`} />
                  <span className={`min-w-0 flex-1 truncate font-mono text-tiny ${active ? 'text-ink' : 'text-ink-secondary'}`}>
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
                    <span title="Information value is at or below the value a variable with no relationship to the target scores on a sample of this size.">
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
