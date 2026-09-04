import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey, type Treatment } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill, Notice } from '../components/ui'
import BinningEditor from '../components/BinningEditor'
import {
  DEFAULT_MAX_BINS, DEFAULT_N_KNOTS, columns, setVariable, toggleTerm, variable,
} from '../lib/spec'
import VariableViews from '../components/VariableViews'
import BinStability from '../components/BinStability'
import TreatmentControl from '../components/TreatmentControl'
import { useUi } from '../lib/store'
import { isDiscretised } from '../lib/api'
import { num, pct } from '../lib/format'
import { diverging, mode, sequential } from '../design/tokens'

/**
 * One variable, in full: its leakage check, its binning or treatment, its
 * shape against the target, its stability through time and its bin table.
 *
 * This was the right-hand column of a separate Explore stage. It is now the
 * right pane of the model workbench, opened by clicking a candidate or a
 * coefficient, because looking at a variable and fitting a model are not two
 * stages of anything: they are the two halves of one loop.
 *
 * Every control writes THE specification. There is no local copy: a local copy
 * is what let the editor show one binning while the model was estimated on
 * another.
 */
export default function VariableDetail({ portfolio, column }: {
  portfolio: string; column: string
}) {
  const spec = useUi((s) => s.pdSpec[portfolio as PortfolioKey])
  const editPd = useUi((s) => s.editPd)
  const picked = columns(spec)
  const current = variable(spec, column)
  const edges = current?.edges
  const maxBins = current?.maxBins ?? DEFAULT_MAX_BINS
  const nKnots = current?.nKnots ?? DEFAULT_N_KNOTS
  const treatment = current?.treatment ?? 'woe'

  // Editing the edges by hand IS a change of bin count, so it moves the count
  // with it. A new bin COUNT invalidates hand-set edges: they were a different
  // number of bins.
  const setEdges = (e: number[] | undefined) =>
    editPd(portfolio as PortfolioKey,
           (x) => setVariable(x, column, e ? { edges: e, maxBins: e.length + 1 }
                                           : { edges: undefined }),
           `${column} binning`)
  const setMaxBins = (n: number) =>
    editPd(portfolio as PortfolioKey,
           (x) => setVariable(x, column, { maxBins: n, edges: undefined }),
           `${column} to ${n} bins`)
  const setNKnots = (n: number) =>
    editPd(portfolio as PortfolioKey,
           (x) => setVariable(x, column, { nKnots: n, knots: undefined }),
           `${column} to ${n} knots`)
  const setKnots = (k: number[] | undefined) =>
    editPd(portfolio as PortfolioKey,
           (x) => setVariable(x, column, { knots: k }), `${column} knots`)
  const setTreatment = (t: Treatment) =>
    editPd(portfolio as PortfolioKey,
           (x) => setVariable(x, column, { treatment: t }), `${column} as ${t}`)

  const binning = useQuery({
    queryKey: ['binning', portfolio, column, edges?.join(','), maxBins, nKnots],
    queryFn: () => api.binning(portfolio, column, edges, maxBins, nKnots),
    placeholderData: (prev) => prev,
  })
  // Which bin is being read closely. Clicking a bar in the chart highlights
  // its row in the bin detail and scrolls it into view; clicking a row lights
  // its bar. Pure view state — it names a bin, never a decision.
  const [selBin, setSelBin] = useState<string | null>(null)
  useEffect(() => { setSelBin(null) }, [column])
  // How many bins are ON SCREEN. Everything that reports a bin count reads
  // this, so the header, the stepper and the chart cannot disagree.
  const shownBins = binning.data?.achieved_bins
    ?? (binning.data?.bins.filter((b) => !b.is_special).length || DEFAULT_MAX_BINS)

  if (!binning.data) return <Skeleton className="h-[600px]" />

  return (
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
              ? `Binning: ${binning.data.column}`
              : `Treatment: ${binning.data.column}`}
            subtitle={isDiscretised(treatment)
              ? `${shownBins} bins · ${num(binning.data.n_total)} account-months · ${num(binning.data.n_events)} events`
              : `${num(binning.data.n_total)} account-months · ${num(binning.data.n_events)} events`}
            caption={!isDiscretised(treatment) ? undefined
              : binning.data.kind === 'numeric'
              ? "Bin height is the default rate; fill is the weight of evidence, blue for safer and magenta for riskier. The grey footer band is each bin's share of the population."
              : 'Levels with similar risk share a bin. Each bin shows its default rate against the book average, and its log odds distance from the book as weight of evidence.'}
            right={
              <div className="flex items-center gap-3">
                {/* The natural place to commit: look at the shape, then
                    add it. Previously only the tray's suggestion chips
                    could add a variable, so anything unsuggested was
                    unreachable. */}
                <button
                  onClick={() => editPd(portfolio as PortfolioKey,
                    (x) => toggleTerm(x, binning.data!.column),
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
                    <button onClick={() => setMaxBins(DEFAULT_MAX_BINS)}
                      className="rounded border border-hairline px-2 py-0.5 text-micro text-ink-secondary hover:text-ink">
                      Auto-bin
                    </button>
                    {/* The stepper steps from the count that is DRAWN,
                        not from a remembered request. Stepping from a
                        request is what made the control appear inert:
                        after an edge was removed by hand the request
                        still held its old number, so the next press
                        asked for a count the chart was already on. */}
                    <div className="flex items-center gap-1">
                      <button disabled={shownBins <= 2}
                        onClick={() => setMaxBins(shownBins - 1)}
                        title="One fewer bin"
                        className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-secondary hover:text-ink disabled:opacity-30">−</button>
                      <span className="text-micro tabular-nums text-ink-muted">{shownBins}</span>
                      <button disabled={shownBins >= 15}
                        onClick={() => setMaxBins(shownBins + 1)}
                        title="One more bin"
                        className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-secondary hover:text-ink disabled:opacity-30">+</button>
                    </div>
                    {/* The count asked for is not always available: a
                        monotonic trend may not survive the extra
                        split. Say so, rather than showing a number the
                        binning does not have. */}
                    {!edges && shownBins !== maxBins && (
                      <span className="text-micro" style={{ color: 'var(--status-warning)' }}
                            title={`${maxBins} bins were requested. The binning returned ${shownBins}: at that count it could not hold a monotonic trend, or the data does not support a split that fine.`}>
                        {shownBins} of {maxBins} requested
                      </span>
                    )}
                  </div>
                )}
              </div>
            }
          />
          <TreatmentControl
            value={treatment}
            result={binning.data}
            onChange={setTreatment}
            nKnots={nKnots} onKnots={setNKnots} />
          {/* The editor follows the decision. A binning editor is an
              editor for a decision a spline does not make, and leaving
              it on screen for a continuous treatment was the single most
              confusing thing on this page. */}
          {isDiscretised(treatment) ? (
            <>
              {binning.data.kind === 'numeric' && binning.data.domain ? (
                <BinningEditor result={binning.data} pending={binning.isFetching}
                               onEdgesChange={(e) => setEdges(e)}
                               selected={selBin} onSelect={setSelBin} />
              ) : (
                <>
                  <CardinalityWarning b={binning.data} />
                  <CategoricalBins b={binning.data} selected={selBin} onSelect={setSelBin} />
                </>
              )}
              <MonotonicityRow b={binning.data} />
              {/* The bin table lives WITH the chart it details, and the two
                  are paired by click: a bar selects its row, a row its bar.
                  As a separate card at the foot of the page it was a scroll
                  away from the thing it explained. */}
              <div className="border-t border-hairline">
                <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-1 pt-2.5">
                  <span className="text-xs font-medium text-ink">Bin detail</span>
                  <span className="text-micro text-ink-muted">
                    Click a bin above or a row here to pair them.
                    Bins under 2% of the population produce unstable weights.
                  </span>
                </div>
                <BinTable b={binning.data} selected={selBin} onSelect={setSelBin} />
              </div>
            </>
          ) : (
            <p className="px-4 pb-2.5 text-micro text-ink-muted">
              {treatment === 'continuous'
                ? 'No binning and no information value. Both are properties of a discretisation.'
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
          knots={current?.knots}
          nKnots={nKnots}
          onKnots={setKnots}
        />

        {isDiscretised(treatment) && (
          <BinStability portfolio={portfolio} column={binning.data.column}
                        edges={binning.data.edges ?? undefined} />
        )}

      </>
    )}
    </div>
  )
}

function LeakageBanner({ risk, reason, lift, bin }: {
  risk: string; reason: string; lift: number; bin: string
}) {
  const likely = risk === 'likely'
  return (
    <Notice severity={likely ? 'critical' : 'warning'}
            label={likely ? 'Leakage likely' : 'Review'}
            detail={<>Strongest bin “{bin}” · {lift.toFixed(1)}x event-capture lift.</>}>
      {reason}
    </Notice>
  )
}

/** What was done to a wide categorical, and why — stated rather than asked.
 *
 *  A mortgage tape carries a few hundred metros, most holding a fraction of a
 *  percent of the book. Left alone, weight of evidence hands a metro with a
 *  handful of loans a weight of its own, and the information value comes out
 *  nearly ten times its honest value. The app collapses the tail and shrinks thin
 *  cells automatically, then says so — the analyst should not have to know to
 *  ask. Renders nothing when neither step applied. */
function CardinalityWarning({ b }: { b: any }) {
  const collapsed = b.n_levels_raw > b.bins.length
  const shrunk = (b.shrinkage ?? 0) > 0
  if (!collapsed && !shrunk) return null
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill severity="warning">High cardinality</StatusPill>
        <span className="text-xs text-ink">
          {b.n_levels_raw} levels, reduced to {b.bins.length} bins
        </span>
      </div>
      <ul className="max-w-[88ch] space-y-1.5 text-tiny leading-relaxed text-ink-secondary">
        {(b.warnings ?? []).map((w: string) => <li key={w}>· {w}</li>)}
      </ul>
      <p className="max-w-[88ch] border-t border-hairline pt-2 text-micro leading-relaxed text-ink-muted">
        Both steps apply automatically and both lower the information value,
        because most of the apparent signal in a wide categorical is the tail
        carrying weights it has not earned. Compare the value above against the
        null floor before selecting this variable.
      </p>
    </div>
  )
}

/** A categorical variable, read the way a numeric one is: default rate and
 *  log odds per bin. There are no edges to drag — levels are grouped, not
 *  cut — so the view is a ranked read-out rather than an editor. Sorted by
 *  default rate, riskiest first; special bins (missing) sit at the bottom. */
function CategoricalBins({ b, selected, onSelect }: {
  b: any; selected: string | null; onSelect: (label: string | null) => void
}) {
  const m = mode()
  const bins = [...b.bins].sort((x: any, y: any) =>
    (x.is_special ? 1 : 0) - (y.is_special ? 1 : 0)
    || (y.event_rate || 0) - (x.event_rate || 0))
  const maxRate = Math.max(...bins.map((x: any) => x.event_rate || 0), 1e-9)
  const maxWoe = Math.max(...bins.map((x: any) => Math.abs(x.woe) || 0), 1e-9)
  const bookRate = b.n_total ? b.n_events / b.n_total : 0
  const grid = 'grid grid-cols-[minmax(0,1.1fr)_56px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3'
  return (
    <div className="px-4 pb-3 pt-1">
      <div className={`${grid} border-b border-hairline pb-1 text-micro text-ink-muted`}>
        <span>Bin · grouped levels</span>
        <span className="text-right">Share</span>
        <span>Default rate · book average {pct(bookRate * 100, 2)} marked</span>
        <span>Log odds vs book (weight of evidence)</span>
      </div>
      {bins.map((x: any) => (
        <button key={x.label}
          onClick={() => onSelect(selected === x.label ? null : x.label)}
          title={x.levels?.length ? x.levels.join(', ') : x.label}
          className={`${grid} w-full rounded px-0 py-1.5 text-left ${
            selected === x.label ? 'bg-accent-soft' : 'hover:bg-sunken'}`}>
          <span className="truncate font-mono text-tiny text-ink">
            {x.label}
            {x.is_special && <span className="ml-1 text-micro text-ink-muted">special</span>}
          </span>
          <span className="text-right tnum text-tiny text-ink-muted">
            {(x.pct_of_total * 100).toFixed(1)}%
          </span>
          <span className="flex items-center gap-2">
            <span className="relative h-2.5 flex-1 rounded-sm bg-sunken">
              <span className="absolute inset-y-0 left-0 rounded-sm"
                style={{ width: `${((x.event_rate || 0) / maxRate) * 100}%`,
                         background: sequential(0.6, m) }} />
              {/* the book average, so a bin reads as above or below it at a glance */}
              <span className="absolute inset-y-0 w-px bg-ink-muted"
                style={{ left: `${Math.min((bookRate / maxRate) * 100, 100)}%` }} />
            </span>
            <span className="w-14 text-right tnum text-tiny text-ink-secondary">
              {pct((x.event_rate || 0) * 100, 2)}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="relative h-2.5 flex-1 rounded-sm bg-sunken">
              <span className="absolute inset-y-0 rounded-sm"
                style={{
                  left: x.woe < 0 ? `${50 - Math.min(Math.abs(x.woe) / maxWoe, 1) * 50}%` : '50%',
                  width: `${Math.min(Math.abs(x.woe) / maxWoe, 1) * 50}%`,
                  background: diverging((x.woe || 0) / maxWoe, m),
                }} />
              <span className="absolute inset-y-0 left-1/2 w-px bg-axis" />
            </span>
            <span className="w-14 text-right tnum text-tiny text-ink-secondary">
              {(x.woe || 0).toFixed(3)}
            </span>
          </span>
        </button>
      ))}
      <p className="pt-1.5 text-micro text-ink-muted">
        Weight of evidence is the distance of a bin's log odds from the book
        average: blue safer than the book, magenta riskier.
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
          <span className="text-ink-muted">not applicable, nominal</span>
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
    </div>
  )
}

function BinTable({ b, selected, onSelect }: {
  b: any; selected: string | null; onSelect: (label: string | null) => void
}) {
  const m = mode()
  const maxWoe = Math.max(...b.bins.map((x: any) => Math.abs(x.woe) || 0), 1e-9)
  // A bar clicked in the chart selects a row that may be below the fold of
  // this scroller; bring it into view so the pairing is visible, not implied.
  const selRef = useRef<HTMLTableRowElement | null>(null)
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div className="thin-scroll max-h-[280px] overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-hairline text-tiny text-ink-muted">
            <th className="px-3 py-1.5 font-medium">Bin</th>
            <th className="px-3 py-1.5 text-right font-medium">Rows</th>
            <th className="px-3 py-1.5 text-right font-medium">%</th>
            <th className="px-3 py-1.5 text-right font-medium">Defaults</th>
            <th className="px-3 py-1.5 text-right font-medium">Default rate</th>
            <th className="px-3 py-1.5 text-right font-medium">WoE</th>
            <th className="px-3 py-1.5 font-medium">IV contribution</th>
          </tr>
        </thead>
        <tbody>
          {b.bins.map((x: any) => (
            <tr key={x.label}
                ref={x.label === selected ? selRef : undefined}
                onClick={() => onSelect(selected === x.label ? null : x.label)}
                className={`cursor-pointer border-b border-hairline ${
                  selected === x.label ? 'bg-accent-soft' : 'hover:bg-sunken'}`}>
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
