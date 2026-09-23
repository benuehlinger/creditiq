import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey, type Treatment } from '../lib/api'
import { Card, CardHead, Notice, QueryError, Skeleton, StatTile, StatusPill, ViewTabs } from '../components/ui'
import EChart from '../charts/EChart'
import { baseOption, barSeries, escapeHtml, gridFor, lineSeries, markTooltip, xName, yName } from '../charts/base'
import BinningEditor from '../components/BinningEditor'
import {
  DEFAULT_MAX_BINS, DEFAULT_N_KNOTS, columns, setVariable, toggleTerm, variable,
} from '../lib/spec'
import VariableViews from '../components/VariableViews'
import BinStability from '../components/BinStability'
import TreatmentControl from '../components/TreatmentControl'
import { useUi } from '../lib/store'
import { isDiscretised } from '../lib/api'
import { byUnit, num, pct, visibleLevel } from '../lib/format'
import { accent, diverging, ink, mode, status } from '../design/tokens'

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

  // The column ON ITS OWN, before any target. Binning and shape both assume
  // this question is already answered, and neither can answer it.
  const uni = useQuery({
    queryKey: ['univariate', portfolio, column],
    queryFn: () => api.univariate(portfolio, column),
    staleTime: Infinity,
  })
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

  if (binning.isError) return <QueryError what="This variable" error={binning.error} retry={() => binning.refetch()} />
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
              : 'Levels with similar risk share a bin. The bins are in the detail below, sorted by default rate, riskiest first.'}
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
                <CardinalityWarning b={binning.data} />
              )}
              <MonotonicityRow b={binning.data} />
              {/* The bin table lives WITH the chart it details. For a numeric
                  variable the two are paired by click: a bar selects its row,
                  a row its bar. A categorical has no chart — the table IS the
                  view — so its rows are not click targets for anything. */}
              <div className="border-t border-hairline">
                <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-1 pt-2.5">
                  <span className="text-xs font-medium text-ink">Bin detail</span>
                  <span className="text-micro text-ink-muted">
                    {binning.data.kind === 'numeric' && 'Click a bin above or a row here to pair them. '}
                    Bins under 2% of the population produce unstable weights.
                  </span>
                </div>
                <BinTable b={binning.data}
                  selected={binning.data.kind === 'numeric' ? selBin : null}
                  onSelect={binning.data.kind === 'numeric' ? setSelBin : undefined} />
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

        {/* The column on its own. BELOW the shape view, because the shape is
            what the treatment is chosen from and this is the reference a
            reader reaches for when the shape surprises them. Collapsed, so
            it never pushes that decision off the screen. */}
        {uni.data && <Distribution d={uni.data} />}

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
  b: any; selected: string | null; onSelect?: (label: string | null) => void
}) {
  const m = mode()
  const maxWoe = Math.max(...b.bins.map((x: any) => Math.abs(x.woe) || 0), 1e-9)
  // Numeric bins keep their interval order — the ranges only make sense in
  // sequence. Categorical bins have no sequence, so they rank by default
  // rate, riskiest first, with special bins (missing, unseen) at the bottom.
  const rows = b.kind === 'categorical'
    ? [...b.bins].sort((x: any, y: any) =>
        (x.is_special ? 1 : 0) - (y.is_special ? 1 : 0)
        || (y.event_rate || 0) - (x.event_rate || 0))
    : b.bins
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
          {rows.map((x: any) => (
            <tr key={x.label}
                ref={x.label === selected ? selRef : undefined}
                onClick={onSelect && (() => onSelect(selected === x.label ? null : x.label))}
                className={`border-b border-hairline ${onSelect ? 'cursor-pointer' : ''} ${
                  selected === x.label ? 'bg-accent-soft' : onSelect ? 'hover:bg-sunken' : ''}`}>
              <td className="whitespace-pre px-3 py-1 font-mono text-tiny text-ink"
                  title={x.levels?.length ? x.levels.map(visibleLevel).join(' · ') : undefined}>
                {visibleLevel(x.label)}
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


/** What this column looks like, before any relationship to default.
 *
 *  A histogram shows a shape; it does not put a number on it, and it hides a
 *  point mass by spreading it across a bar. The statistics here are the ones
 *  that change a modelling decision: how skewed, how heavy the tails, how
 *  much of the column sits on one value, and how much of it is missing. Each
 *  finding names the treatment that answers it. */
function Distribution({ d }: { d: import('../lib/api').Univariate }) {
  const [open, setOpen] = useState(false)
  const worst = d.findings.find((f) => f.severity === 'serious'
                                    || f.severity === 'critical')
  const fmt = (v: number | undefined) =>
    v == null ? '—'
      : Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3)
  const P = d.percentiles ?? {}
  if (!open) {
    return (
      <Card>
        <button onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken/40">
          <span className="text-sm font-medium text-ink">View univariate information</span>
          <span className="text-tiny text-ink-muted">
            {d.kind === 'numeric'
              ? `distribution, percentiles, repeated values · ${num(d.n)} values`
              : `level shares and concentration · ${d.n_unique} levels`}
          </span>
          {/* A serious finding is not worth hiding behind a closed panel. */}
          {worst && (
            <StatusPill severity={worst.severity}>{worst.label}</StatusPill>
          )}
          <span className="ml-auto text-tiny text-ink-muted">Show</span>
        </button>
      </Card>
    )
  }

  return (
    <Card>
      <CardHead title="Distribution"
        subtitle={d.kind === 'numeric'
          ? `${num(d.n)} values · ${num(d.n_unique)} distinct`
          : `${num(d.n)} values · ${d.n_unique} levels`}
        caption={d.kind === 'numeric'
          ? 'The marginal distribution, before any relationship to default. Percentiles characterise a skewed column where a mean and standard deviation do not.'
          : 'Level shares, and how much of the book sits in the long thin tail that binning has to collapse.'}
        right={<button onClick={() => setOpen(false)}
          className="rounded-ctl border border-hairline px-2.5 py-1 text-tiny text-ink-secondary hover:text-ink">
          Hide
        </button>} />

      {d.findings.length > 0 && (
        <div className="space-y-1.5 px-4 pb-3">
          {d.findings.map((f) => (
            <div key={f.label} className="flex gap-2 text-tiny">
              <StatusPill severity={f.severity}>{f.label}</StatusPill>
              <p className="leading-relaxed text-ink-secondary">{f.detail}</p>
            </div>
          ))}
        </div>
      )}

      {d.kind === 'numeric' ? (
        <>
          {d.histogram && <HistogramPair d={d} />}
          <div className="grid grid-cols-2 divide-x divide-hairline border-t border-hairline md:grid-cols-4">
            <StatTile label="Skew" value={fmt(d.skew)} explain={d.skew_note} />
            <StatTile label="Excess kurtosis" value={fmt(d.kurtosis_excess)}
              explain="Fourth standardised moment less 3. Zero is normal-tailed; large positive means extreme values are far more common than a normal distribution implies." />
            <StatTile label="Mean / median" value={`${fmt(d.mean)} / ${fmt(d.median)}`}
              explain="A mean far above the median is the signature of a right tail: the mean is being pulled by it, the median is not." />
            <StatTile label="Missing" value={`${(d.missing_pct ?? 0).toFixed(1)}%`}
              explain="Missing takes its own bin and its own weight of evidence. It is not imputed." />
          </div>
          <div className="grid grid-cols-2 divide-x divide-hairline border-t border-hairline md:grid-cols-4">
            <StatTile label="Std deviation" value={fmt(d.std)}
              explain="Root mean squared distance from the mean. On a skewed column it is inflated by the tail; the median absolute deviation beside it is not." />
            <StatTile label="Median abs deviation" value={fmt(d.mad)}
              explain="Median distance from the median. A robust spread: no single extreme value can move it." />
            <StatTile label="IQR" value={fmt(d.iqr)}
              explain="p75 less p25 — the width of the middle half of the column." />
            <StatTile label="p99 / median"
              value={d.p99_over_p50 == null ? '—' : `${d.p99_over_p50.toFixed(1)}x`}
              explain="How far the top of the column runs past its middle. Near 1 is a tight column; large means a long right tail." />
          </div>
          <div className="thin-scroll overflow-x-auto px-4 py-3">
            <table className="w-full text-left text-micro">
              <thead className="text-ink-muted">
                <tr>
                  {['min', 'p01', 'p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'p99', 'max']
                    .map((k) => <th key={k} className="py-1 pr-4 font-medium uppercase">{k}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-hairline">
                  {[d.min, P.p01, P.p05, P.p10, P.p25, P.p50, P.p75, P.p90, P.p95, P.p99, d.max]
                    .map((v, i) => (
                      <td key={i} className="py-1.5 pr-4 tnum text-ink-secondary">{fmt(v)}</td>
                    ))}
                </tr>
              </tbody>
            </table>
            {(d.top_values?.length ?? 0) > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-micro font-medium uppercase tracking-wide text-ink-muted"
                   title="The values this column repeats most. A histogram spreads a repeated value across a bar and a percentile table steps over it; a sentinel code for 'unknown' is only visible here.">
                  Most repeated values
                </p>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {d.top_values!.map((t) => (
                    <span key={t.value} className="text-micro tnum text-ink-secondary">
                      <span className="text-ink">{fmt(t.value)}</span>
                      {' '}· {num(t.count)} ({t.pct.toFixed(1)}%)
                    </span>
                  ))}
                </div>
              </div>
            )}
            <p className="mt-2 text-micro leading-relaxed text-ink-muted">
              {d.integral && <>Whole numbers only · </>}
              Range {fmt(d.range)} ·{' '}
              Most common value {fmt(d.mode)}, held by {(d.mode_share_pct ?? 0).toFixed(0)}% of rows
              {(d.zero_pct ?? 0) > 0 && <> · {(d.zero_pct ?? 0).toFixed(0)}% exactly zero</>}
              {(d.negative_pct ?? 0) > 0 && <> · {(d.negative_pct ?? 0).toFixed(1)}% negative</>}
              {' '}· {num(d.n_outliers ?? 0)} beyond the 3-IQR fence
              {d.cv != null && <> · coefficient of variation {fmt(d.cv)}</>}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 divide-x divide-hairline border-t border-hairline md:grid-cols-4">
            <StatTile label="Levels" value={String(d.n_unique)}
              explain="Distinct values. Above roughly twenty, weight of evidence on the thin ones fits noise and the binning collapses them." />
            <StatTile label="Largest level" value={`${(d.top_level_pct ?? 0).toFixed(0)}%`}
              explain="Share of the book in the single most common level." />
            <StatTile label="Concentration" value={fmt(d.concentration_hhi)}
              explain="Herfindahl index of the level shares: 1 means one level holds everything, 1/k means the levels are even." />
            <StatTile label="Missing" value={`${(d.missing_pct ?? 0).toFixed(1)}%`}
              explain="Missing takes its own level and its own weight." />
          </div>
          <div className="px-4 py-3">
            {(d.levels ?? []).map((l) => (
              <div key={l.level} className="flex items-center gap-2 py-0.5 text-micro">
                <span className="w-40 shrink-0 truncate text-ink-secondary" title={l.level}>{l.level}</span>
                <span className="h-2 rounded-sm bg-accent"
                      style={{ width: `${Math.max(l.pct, 0.4)}%`, minWidth: 2 }} />
                <span className="tnum text-ink-muted">{l.pct.toFixed(1)}%</span>
              </div>
            ))}
            {(d.n_levels_under_1pct ?? 0) > 0 && (
              <p className="mt-2 text-micro text-ink-muted">
                {d.n_levels_under_1pct} levels under 1% of the book, holding
                {' '}{(d.pct_in_thin_levels ?? 0).toFixed(1)}% between them.
              </p>
            )}
          </div>
        </>
      )}
    </Card>
  )
}


/** The shape, and the relationship read on the SAME axis.
 *
 *  Equal-width bars, because the quantile bins the model uses carry equal
 *  counts by construction and draw a flat rectangle. The full range is shown
 *  first: trimming to the 1st-99th percentile by default would hide the long
 *  tail, which is the one thing a reader opens a histogram to see. */
function HistogramPair({ d }: { d: import('../lib/api').Univariate }) {
  const [trimmed, setTrimmed] = useState(false)
  const theme = useUi((s) => s.theme)
  const h = (trimmed && d.histogram_trimmed) || d.histogram!
  const opt = useMemo(() => {
    const k = ink(mode())
    const centre = h.counts.map((_, i) => (h.edges[i] + h.edges[i + 1]) / 2)
    const hasRates = !!h.rates?.some((r) => r != null)
    const fmtX = (v: number) =>
      Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k`
        : Math.abs(v) >= 1 ? v.toFixed(0) : v.toPrecision(2)
    return {
      ...baseOption(),
      // Two stacked panels sharing an x. The rate panel had 84px for seven
      // labels and they collided; both now get real height, with a gap
      // between them so neither axis runs into the other's bars.
      grid: [
        gridFor({ left: 76, right: 20, top: 12, bottom: hasRates ? 224 : 44 }),
        ...(hasRates ? [gridFor({ left: 76, right: 20, top: 250, bottom: 50 })] : []),
      ],
      tooltip: markTooltip((p: any) => {
        const i = p.dataIndex ?? 0
        const rate = h.rates?.[i]
        return `<div style="font-size:11px;color:${k.muted}">`
          + `${escapeHtml(fmtX(h.edges[i]))} to ${escapeHtml(fmtX(h.edges[i + 1]))}</div>`
          + `<div><b>${num(h.counts[i])}</b> account-months</div>`
          + (rate == null
            ? (hasRates ? `<div style="color:${k.muted}">too few rows for a rate</div>` : '')
            : `<div>${(rate * 100).toFixed(2)}% default rate</div>`)
      }),
      xAxis: [
        { ...(baseOption().xAxis as object), type: 'category' as const,
          data: centre, gridIndex: 0, axisLabel: { show: false } },
        ...(hasRates ? [{ ...(baseOption().xAxis as object), type: 'category' as const,
          data: centre, gridIndex: 1, ...xName(d.column, 28),
          axisLabel: { color: k.muted, fontSize: 10, interval: 7,
                       formatter: (v: string) => fmtX(Number(v)) } }] : []),
      ],
      yAxis: [
        { ...(baseOption().yAxis as object), type: 'value' as const, gridIndex: 0,
          ...yName('Account-months', 62), splitNumber: 4,
          axisLabel: { color: k.muted, fontSize: 10,
                       formatter: (v: number) => byUnit(v, 'count') } },
        ...(hasRates ? [{ ...(baseOption().yAxis as object), type: 'value' as const,
          gridIndex: 1, ...yName('Default rate', 62), splitNumber: 3,
          axisLabel: { color: k.muted, fontSize: 10,
                       formatter: (v: number) => `${(v * 100).toFixed(1)}%` } }] : []),
      ],
      series: [
        { ...barSeries({ name: 'Account-months', data: h.counts, color: accent() }),
          xAxisIndex: 0, yAxisIndex: 0 },
        ...(hasRates ? [{
          ...lineSeries({ name: 'Default rate', color: status.serious,
            data: h.rates!.map((r, i) => [String(centre[i]), r] as [string, number | null]),
            showSymbol: false }),
          xAxisIndex: 1, yAxisIndex: 1, connectNulls: false }] : []),
      ],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h, theme, d.column])

  return (
    <div className="border-t border-hairline px-4 pb-2 pt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-tiny text-ink-muted">
          Equal-width bars over the {trimmed ? '1st to 99th percentile' : 'full range'}
          {h.above + h.below > 0 && (
            <> · {num(h.above + h.below)} rows outside the window, held in the end bars</>
          )}
        </span>
        {d.histogram_trimmed && (
          <ViewTabs value={trimmed ? 'trim' : 'full'}
            onChange={(v) => setTrimmed(v === 'trim')}
            tabs={[{ key: 'full', label: 'Full range' },
                   { key: 'trim', label: '1st to 99th' }]} />
        )}
      </div>
      <EChart option={opt} height={h.rates?.some((r) => r != null) ? 400 : 190}
        ariaLabel={`Distribution of ${d.column}`} />
    </div>
  )
}
