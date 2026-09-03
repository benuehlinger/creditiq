import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, HeroFigure, Skeleton, StatTile, StatusPill, ViewTabs } from '../components/ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import FitProgress, { ROLLUP_PHASES } from '../components/FitProgress'
import { MevLegend, MevPathRows } from '../components/StressedMevs'
import { baseOption, barSeries, crosshairTooltip, escapeHtml, lineSeries, markTooltip, xName, yName, gridFor } from '../charts/base'
import { diverging, ink, mode, ordinal, portfolioColor } from '../design/tokens'
import { useUi } from '../lib/store'
import { month, num, pct, usd } from '../lib/format'

const SCEN_LABEL: Record<string, string> = {
  baseline: 'Baseline', adverse: 'Adverse', severely_adverse: 'Severely adverse',
}

/**
 * The executive view. This is the screen that closes the room, so it is designed
 * as the hero: one number first, then where the number comes from.
 *
 * Colour discipline matters more here than anywhere else, because all three books
 * appear together. Portfolios take palette slots 1 to 3 — the three that clear
 * the harder all-pairs gate — and scenario severity takes an ORDINAL ramp,
 * because baseline to severely adverse is an order, not three identities.
 */
export default function RollUpSurface() {
  const nav = useNavigate()
  const theme = useUi((s) => s.theme)
  const m = mode()
  const k = ink(m)
  // Which saved model each book is reported on, held in the URL so a comparison
  // is linkable and survives a reload. Empty means the champion, or the
  // documented default where no champion has been promoted.
  const [params, setParams] = useSearchParams()
  const selection = useMemo(() => Object.fromEntries(
    (params.get('select') ?? '').split(',').filter((x) => x.includes(':'))
      .map((x) => x.split(':', 2) as [string, string])), [params])
  const setSelection = (next: Record<string, string>) => {
    const q = Object.entries(next).filter(([, v]) => v)
      .map(([k, v]) => `${k}:${v}`).sort().join(',')
    setParams(q ? { select: q } : {}, { replace: true })
  }
  const selKey = Object.entries(selection).filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`).sort().join(',')

  // Whether anything has ever been saved. On a fresh install this gates
  // everything below: the roll-up otherwise fits three books' documented
  // default specifications on arrival, so the first thing a new user ever saw
  // was several minutes of computation producing a loss number they had no
  // hand in. With nothing saved, the landing is a welcome that lays out the
  // workflow instead; it disappears for good once the first version exists.
  const saved = useQuery({ queryKey: ['versions', ''], queryFn: () => api.versions() })
  const firstOpen = saved.data != null && saved.data.length === 0
  const [welcomeSkipped, setWelcomeSkipped] = useState(false)
  const showWelcome = firstOpen && !welcomeSkipped
  const ready = saved.data != null && !showWelcome

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['rollup', selKey],
    queryFn: () => api.rollup(selection),
    staleTime: Infinity, placeholderData: (prev) => prev,
    enabled: ready,
  })
  // The adopted position, always available for comparison. Cached server-side,
  // so this costs nothing once it has been run.
  const adopted = useQuery({
    queryKey: ['rollup', ''], queryFn: () => api.rollup({}), staleTime: Infinity,
    enabled: ready,
  })

  // Keep the progress card for a moment after the response, so the bar is
  // seen to complete rather than vanishing at 92%.
  const [justRan, setJustRan] = useState(false)
  // Cumulative answers "how much"; the monthly flow answers "when": under
  // stress it separates from the run-rate as losses emerge, then contracts as
  // the stressed cohorts resolve. Both shapes of the same series.
  const [emergence, setEmergence] = useState<'cumulative' | 'monthly'>('cumulative')
  useEffect(() => {
    if (isFetching) { setJustRan(true); return }
    if (!justRan) return
    const t = setTimeout(() => setJustRan(false), 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFetching])

  const contribution = useMemo(() => {
    if (!data) return null
    const scen = data.scenarios
    return {
      ...baseOption(),
      grid: gridFor({ left: 78, right: 18, top: 14, bottom: 46 }),
      tooltip: markTooltip((p: any) =>
        `<div style="font-size:11px;color:${k.muted}">${escapeHtml(p.name)}</div>` +
        `<div><span style="font-weight:600">${usd(p.value)}</span> ` +
        `<span style="color:${k.muted}">${escapeHtml(p.seriesName)}</span></div>`),
      xAxis: { ...(baseOption().xAxis as object), type: 'category' as const,
               data: scen.map((s) => SCEN_LABEL[s] ?? s),
               ...xName('Supervisory scenario', 28),
               axisLabel: { color: k.muted, fontSize: 11 } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName('Lifetime ECL (USD)', 60),
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) } },
      series: data.portfolios.map((p) => barSeries({
        name: p.label, stack: 'ecl', maxWidth: 64,
        color: portfolioColor(p.portfolio, m),
        data: scen.map((s) => p.by_scenario[s]?.ecl ?? 0),
      })),
    }
  }, [data, theme])

  const projection = useMemo(() => {
    if (!data) return null
    const rows = data.monthly.filter((r) => r.scenario === 'severely_adverse')
    if (!rows.length) return null
    const cum = emergence === 'cumulative'
    // The service reports the running total; the flow is its first difference.
    const flow = (pf: string, i: number) =>
      Number(rows[i][pf] ?? 0) - (i ? Number(rows[i - 1][pf] ?? 0) : 0)
    return {
      ...baseOption(),
      grid: gridFor({ left: 78, right: 18, top: 14, bottom: 46 }),
      tooltip: crosshairTooltip((v) => usd(v), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               ...xName('Projection month', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName(cum ? 'Cumulative ECL (USD)' : 'ECL per month (USD)', 60),
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => usd(v) } },
      series: data.portfolios.map((p) => ({
        ...lineSeries({ name: p.label, color: portfolioColor(p.portfolio, m), area: true,
          data: rows.map((r, i) => [r.month,
            cum ? Number(r[p.portfolio] ?? 0) : flow(p.portfolio, i)] as [string, number]) }),
        stack: 'total',
        areaStyle: { color: portfolioColor(p.portfolio, m), opacity: 0.18 },
      })),
    }
  }, [data, theme, emergence])

  // Every macro term across the reported models, deduplicated. The tags say
  // which books carry each one — a shared term renders once with several dots
  // rather than once per book, which is both the honest reading (one factor)
  // and what keeps the grid dense instead of one sparse row per book.
  const SHORT: Record<string, string> = {
    consumer: 'Consumer', mortgage: 'Mortgage', cre: 'CRE',
  }
  const mevUnion = useMemo(() => {
    const membership: Record<string, string[]> = {}
    const terms: string[] = []
    for (const p of data?.portfolios ?? []) {
      for (const t of p.mev_terms ?? []) {
        if (!membership[t]) { membership[t] = []; terms.push(t) }
        membership[t].push(p.portfolio)
      }
    }
    const books = (data?.portfolios ?? []).map((p) => ({
      key: p.portfolio, short: SHORT[p.portfolio] ?? p.portfolio,
      label: p.label, color: portfolioColor(p.portfolio, m),
    }))
    return { terms, membership, books }
  }, [data, theme])

  const tornado = useMemo(() => {
    if (!data?.tornado.length) return null
    const rows = [...data.tornado].sort((a, b) => a.delta_pct - b.delta_pct)
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.delta_pct)), 1)
    return {
      ...baseOption(),
      grid: gridFor({ left: 190, right: 40, top: 10, bottom: 46 }),
      tooltip: markTooltip((p: any) => {
        const r = rows[p.dataIndex]
        return `<div style="font-size:11px;color:${k.muted}">${escapeHtml(r.portfolio)} · ${escapeHtml(r.mev)}</div>` +
          `<div style="font-weight:600">${r.delta_pct >= 0 ? '+' : ''}${r.delta_pct.toFixed(1)}% of ECL</div>` +
          `<div style="font-size:11px;color:${k.secondary}">One standard deviation ${escapeHtml(r.direction)}, holding the rest of the scenario fixed. ${usd(r.delta_ecl)}.</div>`
      }),
      xAxis: { ...(baseOption().xAxis as object), type: 'value' as const,
               ...xName('Change in lifetime ECL (%)', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => `${v}%` },
               splitLine: { lineStyle: { color: 'var(--chrome-grid)', width: 1, type: 'solid' as const } } },
      yAxis: { ...(baseOption().yAxis as object), type: 'category' as const,
               data: rows.map((r) => `${r.portfolio} · ${r.mev}`),
               ...yName('Variable', 178),
               axisLabel: { color: k.muted, fontSize: 10 }, splitLine: { show: false } },
      series: [barSeries({
        name: 'ECL sensitivity', horizontal: true, maxWidth: 16, color: '',
        // Diverging: this is a SIGNED quantity around zero, so it takes the
        // diverging ramp rather than a categorical hue.
        data: rows.map((r) => ({ value: r.delta_pct,
          itemStyle: { color: diverging(r.delta_pct / maxAbs, m),
                       borderRadius: r.delta_pct >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] } })) as any,
      })],
    }
  }, [data, theme])

  if (showWelcome) {
    return <Welcome onSkip={() => setWelcomeSkipped(true)} />
  }
  if (isLoading || saved.data == null) {
    return <div className="space-y-3 p-4">
      <Skeleton className="h-32" /><Skeleton className="h-64" /><Skeleton className="h-64" />
    </div>
  }
  if (isError || !data) {
    return <div className="p-4"><Card>
      <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--status-critical)' }}>
        {String(error ?? 'Roll-up unavailable')}
      </div>
    </Card></div>
  }

  const base = data.totals.baseline
  const sa = data.totals.severely_adverse
  const anyDefault = data.portfolios.some((p) => p.source === 'default')
  // How much of the number the analyst's own work actually produced. A book
  // that was never fitted still contributes ECL, from the documented default
  // specification — so a roll-up with one model fitted is a real number, but it
  // is mostly not this analyst's model, and the page has to say which.
  const nFitted = data.portfolios.filter((p) => p.source !== 'default').length
  const nBooks = data.portfolios.length
  const adoptedTotal = adopted.data?.totals?.severely_adverse?.ecl
  const shownTotal = data.totals?.severely_adverse?.ecl
  const delta = !data.is_adopted && adoptedTotal && shownTotal
    ? shownTotal - adoptedTotal : null

  return (
    <div className="space-y-3 p-4">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <HeroFigure
            label="Total expected credit loss: severely adverse"
            value={usd(sa.ecl)}
            sub={`${usd(sa.exposure)} exposure across ${data.portfolios.length} portfolios · `
              + `${sa.ecl_bps.toFixed(0)} basis points · ${(sa.ecl / base.ecl).toFixed(1)}x baseline`}
          />
          <div className="flex flex-wrap divide-x divide-hairline">
            <StatTile label="Baseline ECL" value={usd(base.ecl)}
              explain={`${base.ecl_bps.toFixed(0)} basis points of exposure.`} />
            <StatTile label="Increase under stress" value={usd(sa.ecl - base.ecl)}
              explain="Severely adverse less baseline." />
            <StatTile label="Weighted 12-month PD" value={pct(sa.weighted_pd_12m * 100)}
              explain="Cumulative probability of default over the first twelve months, exposure-weighted across all three books, under severely adverse. It covers a quarter of the horizon. The supervisory path troughs in quarters six to eight, so this understates the stress in the ECL figure." />
            <StatTile label="Weighted LGD, first 12 months" value={sa.weighted_lgd.toFixed(3)}
              explain="Mean predicted severity over the first twelve months, exposure-weighted, under severely adverse. A 12-month figure against a 39-month ECL, so it does not multiply out to the stress multiple." />
          </div>
        </div>
        {/* Which models produced the number above — folded into the hero,
            because it qualifies every figure on the page and does not deserve
            a card of its own. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline px-4 py-2.5">
          {!data.is_adopted ? (
            <StatusPill severity="warning">Selected set, not the adopted position</StatusPill>
          ) : anyDefault ? (
            <StatusPill severity="warning">
              {nFitted} of {nBooks} books on a fitted model
            </StatusPill>
          ) : (
            <StatusPill severity="good">Adopted models</StatusPill>
          )}
          <span className="max-w-[88ch] min-w-0 flex-1 text-tiny leading-relaxed text-ink-secondary">
            {!data.is_adopted
              ? 'One or more books are reported on a model that is not their champion. This is a comparison, not the position the firm holds.'
              : anyDefault
              ? `${nBooks - nFitted} book${nBooks - nFitted === 1 ? ' uses' : 's use'}`
                + ' the documented default specification: computed, not assumed, but'
                + ' not a model anyone here has fitted or reviewed. Fit and promote a'
                + ' model on each book to replace them.'
              : 'Each book is reported on its promoted champion.'}
          </span>
          {delta != null && (
            <span className="text-tiny text-ink-secondary">
              Severely adverse{' '}
              <span className="tnum font-medium text-ink">
                {delta > 0 ? '+' : '−'}{usd(Math.abs(delta))}
              </span>{' '}
              against the adopted set ({usd(adoptedTotal!)})
            </span>
          )}
          {!data.is_adopted && (
            <button onClick={() => setSelection({})}
              className="rounded-ctl border border-hairline px-2 py-1 text-tiny text-ink-secondary hover:text-ink">
              Reset to adopted
            </button>
          )}
        </div>
        {(isFetching || justRan) && (
          <div className="border-t border-hairline p-3">
            <FitProgress done={!isFetching} doneLabel="Projected"
              phases={ROLLUP_PHASES(data.portfolios.map((p) => ({ key: p.portfolio, label: p.label })),
                                    data.timings)} />
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="Position by portfolio"
          caption="Each book, the model it is reported on, and its stressed figure. The picker swaps the model this book is projected with; the book's name opens its workspace." />
        <div className="grid gap-px bg-hairline sm:grid-cols-3">
          {data.portfolios.map((p) => {
            const s = p.by_scenario.severely_adverse
            const b = p.by_scenario.baseline
            const champ = data.champions[p.portfolio]
            const options = data.available[p.portfolio] ?? []
            return (
              // The whole card opens the book's workspace — a target this
              // size should not demand a hit on the six-word title. The model
              // picker inside stops the click from bubbling, so choosing a
              // model never navigates.
              <div key={p.portfolio} role="link" tabIndex={0}
                onClick={() => nav(champ ? `/${p.portfolio}/versions` : `/${p.portfolio}/data`)}
                onKeyDown={(e) => { if (e.key === 'Enter') nav(champ ? `/${p.portfolio}/versions` : `/${p.portfolio}/data`) }}
                title={`Open the ${p.label} workspace`}
                className="flex cursor-pointer flex-col bg-surface p-4 transition-colors hover:bg-sunken">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full"
                          style={{ background: portfolioColor(p.portfolio, m) }} />
                    <span className="text-sm font-medium text-ink">{p.label}</span>
                  </span>
                  <StatusPill severity={p.source === 'champion' ? 'good'
                    : p.source === 'selected' ? 'serious' : 'warning'}>
                    {p.source === 'champion' ? 'champion'
                      : p.source === 'selected' ? 'selected' : 'default spec'}
                  </StatusPill>
                </div>
                <div className="mt-3 text-2xl font-semibold tracking-tight"
                     style={{ color: portfolioColor(p.portfolio, m) }}>
                  {usd(s.ecl)}
                </div>
                <div className="mt-0.5 text-tiny text-ink-muted">
                  severely adverse · {s.ecl_bps.toFixed(0)} bps · {(s.ecl / b.ecl).toFixed(1)}x baseline
                </div>
                <dl className="mb-3 mt-3 space-y-1 text-tiny">
                  <Row k="Exposure" v={usd(p.exposure)} />
                  <Row k="Accounts" v={num(p.n_accounts)} />
                  <Row k="EAD method" v={p.ead_method === 'ccf'
                    ? `CCF ${p.ead_ccf ? (p.ead_ccf * 100).toFixed(0) + '%' : ''}` : 'Amortizing'} />
                </dl>
                {(p.extrapolation_flags.length > 0 || p.sign_flips.length > 0 || !p.data_is_current) && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {p.extrapolation_flags.length > 0 && (
                      <StatusPill severity="warning">
                        {p.extrapolation_flags.length} variable{p.extrapolation_flags.length === 1 ? '' : 's'} out of range
                      </StatusPill>
                    )}
                    {p.sign_flips.length > 0 && (
                      <span title={`${p.sign_flips.map((f) => f.replace('mev:', '')).join(', ')} fits against its economic prior in this specification.`}>
                        <StatusPill severity="critical">sign flip</StatusPill>
                      </span>
                    )}
                    {!p.data_is_current && (
                      <span title="This version was fitted on a panel that no longer exists. The specification replays against the current data, so these figures are current; the metrics stored with the version are not.">
                        <StatusPill severity="warning">stale data</StatusPill>
                      </span>
                    )}
                  </div>
                )}
                {/* The model this book is reported on — the knob lives on the
                    object it changes, not in a separate control strip. Pinned
                    to the card's bottom edge so the three pickers align
                    whatever each card carries above them. */}
                <div className="mt-auto border-t border-hairline pt-2.5"
                     onClick={(e) => e.stopPropagation()}>
                  <select
                    value={p.version_hash ?? ''}
                    onChange={(e) => setSelection({ ...selection, [p.portfolio]: e.target.value })}
                    className="w-full rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink"
                    aria-label={`Model to report ${p.label} on`}>
                    <option value="">
                      {p.champion_hash
                        ? `Champion: ${p.champion_name}`
                        : 'Documented default specification'}
                    </option>
                    {options.map((v) => (
                      <option key={v.hash} value={v.hash}>
                        {v.name}{v.status === 'champion' ? ' · champion' : ''}
                        {v.data_is_current ? '' : ' · stale data'}
                        {v.auc_test ? ` · AUC ${v.auc_test.toFixed(3)}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 font-mono text-micro text-ink-muted">{p.model_hash}</p>
                </div>
              </div>
            )
          })}
        </div>
        {!data.is_adopted && (
          <p className="max-w-[88ch] border-t border-hairline px-4 py-2 text-micro leading-relaxed text-ink-muted">
            A selected set answers "what would the allowance be under this model".
            It is not the allowance. Promote a version on its book's Versions
            surface to make it the adopted model.
          </p>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title="Where the loss comes from"
            subtitle="ECL by portfolio, under each scenario" />
          <Legend kind="rect"
            items={data.portfolios.map((p) => ({ name: p.label, color: portfolioColor(p.portfolio, m) }))} />
          {contribution && (
            <EChart option={contribution} height={230} ariaLabel="ECL by portfolio and scenario" externalLegend
              table={{ columns: ['Scenario', ...data.portfolios.map((p) => p.label), 'Total'],
                       rows: data.scenarios.map((s) => [SCEN_LABEL[s] ?? s,
                         ...data.portfolios.map((p) => Math.round(p.by_scenario[s]?.ecl ?? 0)),
                         Math.round(data.totals[s]?.ecl ?? 0)]) }} />
          )}
        </Card>

        <Card>
          <CardHead title="Loss emergence under severely adverse"
            subtitle={emergence === 'cumulative' ? 'Cumulative, stacked by portfolio'
              : 'Per month, stacked by portfolio: losses build, peak, then run off as the stressed cohorts resolve'}
            caption="The timing of expected loss across the horizon, survival-adjusted and discounted at the effective interest rate."
            right={<ViewTabs value={emergence} onChange={setEmergence} tabs={[
              { key: 'cumulative' as const, label: 'Cumulative' },
              { key: 'monthly' as const, label: 'Monthly',
                title: 'The loss flow per month, not the running total' },
            ]} />} />
          <Legend items={data.portfolios.map((p) => ({ name: p.label, color: portfolioColor(p.portfolio, m) }))} />
          {projection && (
            <EChart option={projection} height={230} ariaLabel="Cumulative ECL by portfolio over the horizon" externalLegend
              table={{ columns: ['Month', ...data.portfolios.map((p) => p.label)],
                       rows: data.monthly.filter((r) => r.scenario === 'severely_adverse')
                         .map((r) => [String(r.month),
                           ...data.portfolios.map((p) => Math.round(Number(r[p.portfolio] ?? 0)))]) }} />
          )}
        </Card>
      </div>

      <Card>
        <CardHead title="What the models respond to"
          caption="One row per macro term. The dot columns say which book's model carries it: a factor shared across books is one exposure however many models load on it, and the gaps say what a book is NOT exposed to. The path is history to the projection date, then the two Federal Reserve branches; the figures are the break-off."
          right={<MevLegend />} />
        <MevPathRows terms={mevUnion.terms} books={mevUnion.books}
                     membership={mevUnion.membership} />
      </Card>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card>
          <CardHead title="Sensitivity: which variable moves total ECL most"
            subtitle="One standard deviation in the adverse direction, holding the rest of the scenario fixed"
            caption="Each macro variable moved one standard deviation with all others held. In an actual downturn these variables move together, so this is a sensitivity ranking rather than a scenario." />
          {tornado && (
            <EChart option={tornado} height={Math.max(180, data.tornado.length * 34)}
              ariaLabel="ECL sensitivity tornado"
              table={{ columns: ['Portfolio', 'Variable', 'Shock', 'ECL change', 'ECL change (%)'],
                       rows: data.tornado.map((t) => [t.portfolio, t.mev, `1 sd ${t.direction}`,
                         Math.round(t.delta_ecl), Number(t.delta_pct.toFixed(2))]) }} />
          )}
        </Card>

        <Card>
          <CardHead title="Risk parameters under stress"
            subtitle="12-month PD and LGD per book, baseline against severely adverse"
            caption="The two halves of every loss number, shown as the distance stress moves them. PD is the exposure-weighted 12-month default probability; LGD is the mean predicted severity over the same window. The books whose dumbbells stretch furthest are where the stress number comes from."
            right={<Legend items={[
              { name: 'Supervisory Baseline', color: ordinal(0, 2) },
              { name: 'Supervisory Severely Adverse', color: ordinal(1, 2) },
            ]} />} />
          <div className="space-y-5 px-4 py-4">
            {([['12-month PD', 'pd_12m', (v: number) => `${(v * 100).toFixed(1)}%`],
               ['LGD, first 12 months', 'lgd', (v: number) => (v as number).toFixed(2)]] as const)
              .map(([label, key, fmt]) => {
                const hi = Math.max(...data.portfolios.map(
                  (b) => Number(b.by_scenario.severely_adverse?.[key] ?? 0)), 1e-9) * 1.15
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <span className="text-tiny font-medium uppercase tracking-wider text-ink-muted">{label}</span>
                      <span className="tnum text-micro text-ink-muted">0 — {fmt(hi)}</span>
                    </div>
                    <div className="space-y-2.5">
                      {data.portfolios.map((b) => {
                        const lo = Number(b.by_scenario.baseline?.[key] ?? 0)
                        const sv = Number(b.by_scenario.severely_adverse?.[key] ?? 0)
                        const x = (v: number) => `${(v / hi) * 100}%`
                        return (
                          <div key={b.portfolio} className="flex items-center gap-3"
                               title={`${b.label}: ${fmt(lo)} baseline, ${fmt(sv)} severely adverse`}>
                            <span className="flex w-24 shrink-0 items-center gap-1.5 text-tiny text-ink-secondary">
                              <span className="h-1.5 w-1.5 rounded-full"
                                    style={{ background: portfolioColor(b.portfolio, m) }} />
                              {SHORT[b.portfolio] ?? b.portfolio}
                            </span>
                            <div className="relative h-4 flex-1">
                              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hairline" />
                              <div className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full"
                                   style={{ left: x(Math.min(lo, sv)), width: x(Math.abs(sv - lo)),
                                            background: 'var(--chrome-axis)' }} />
                              <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                                    style={{ left: x(lo), background: ordinal(0, 2) }} />
                              <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                                    style={{ left: x(sv), background: ordinal(1, 2) }} />
                            </div>
                            <span className="w-11 shrink-0 text-right tnum text-micro text-ink-secondary">{fmt(lo)}</span>
                            <span className="w-11 shrink-0 text-right tnum text-micro font-medium text-ink">{fmt(sv)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="Concentration"
            subtitle="Share of each book's drawn balance, at the latest performance date"
            caption="Each book is cut along the dimension its committee actually watches: origination FICO for consumer, current LTV for mortgage, property type for commercial. Bar length is the band's share of that book's balance; the figure is the balance itself. A property of the book, not of a model — changing the adopted model above moves nothing here." />
          <div className="grid gap-x-8 gap-y-4 px-4 py-3"
               style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            {Object.entries(data.concentration).map(([p, bands]) => {
              const maxShare = Math.max(...bands.map((b) => b.share), 0.01)
              const DIM: Record<string, string> = {
                consumer: 'by origination FICO', mortgage: 'by current LTV',
                cre: 'by property type',
              }
              return (
                <div key={p}>
                  <div className="flex items-baseline gap-2 text-tiny">
                    <span className="h-2 w-2 self-center rounded-full"
                          style={{ background: portfolioColor(p as any, m) }} />
                    <span className="font-medium text-ink">
                      {data.portfolios.find((x) => x.portfolio === p)?.label ?? p}
                    </span>
                    <span className="text-micro text-ink-muted">{DIM[p] ?? ''}</span>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {bands.map((b) => (
                      <div key={b.band} className="flex items-center gap-2"
                           title={`${b.band}: ${usd(b.exposure)} drawn, ${(b.share * 100).toFixed(1)}% of the book`}>
                        <span className="w-20 shrink-0 text-right font-mono text-micro text-ink-muted">
                          {b.band}
                        </span>
                        <div className="h-3 flex-1 rounded-sm bg-sunken">
                          <div className="h-3 rounded-sm"
                               style={{ width: `${(b.share / maxShare) * 100}%`,
                                        background: portfolioColor(p as any, m),
                                        opacity: 0.85 }} />
                        </div>
                        <span className="w-9 shrink-0 text-right tnum text-micro text-ink-secondary">
                          {(b.share * 100).toFixed(0)}%
                        </span>
                        <span className="w-14 shrink-0 text-right tnum text-micro text-ink-muted">
                          {usd(b.exposure)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="truncate text-ink-secondary">{v}</dd>
    </div>
  )
}

/** The first-open landing.
 *
 *  Shown only while the app holds no saved versions at all — the one moment
 *  the roll-up has nothing real to report. It is a single screen, not a
 *  step-by-step tour: it lays out the workflow once, offers each book as a
 *  starting point, and never returns after the first model is saved. Every
 *  other affordance stays live behind it — the navigation works, so it is
 *  skippable by construction.
 */
function Welcome({ onSkip }: { onSkip: () => void }) {
  const nav = useNavigate()
  const books = useQuery({ queryKey: ['portfolios'], queryFn: api.portfolios })
  const steps: [string, string][] = [
    ['Data', 'Review the book: composition, default history, data health.'],
    ['Macro', 'Screen macroeconomic series and build transformed candidates.'],
    ['PD model', 'Select variables, choose treatments, fit the default model.'],
    ['LGD model', 'Select severity drivers and fit the loss-given-default model.'],
    ['Scenarios', 'Project expected credit loss on the supervisory scenarios.'],
    ['Versions', 'Save the model, compare challengers, promote a champion.'],
  ]
  return (
    <div className="mx-auto max-w-4xl px-6 py-14">
      <p className="text-tiny uppercase tracking-wider text-ink-muted">Getting started</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
        From loan tape to loss number
      </h1>
      <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-ink-secondary">
        CreditIQ develops credit risk models on three synthetic demonstration
        portfolios: a probability-of-default model and a loss-given-default model
        per book, stressed on the Federal Reserve supervisory scenarios and saved
        as named, comparable versions. Nothing here is Apollo FIG data.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {(books.data ?? []).map((p) => (
          <button key={p.key} onClick={() => nav(`/${p.key}/data`)}
            className="rounded-card border border-hairline bg-raised px-4 py-4 text-left transition-colors hover:border-accent">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink">
              <span aria-hidden className="h-2 w-2 rounded-full"
                    style={{ background: portfolioColor(p.key) }} />
              {p.label}
            </span>
            <span className="mt-1.5 block text-xs text-ink-secondary">
              {p.n_accounts.toLocaleString()} accounts · {p.annual_default_rate_pct}%
              annualised default rate
            </span>
            <span className="mt-3 inline-block text-xs font-medium text-accent">
              Start here
            </span>
          </button>
        ))}
      </div>

      <div className="mt-10">
        <h2 className="text-tiny uppercase tracking-wider text-ink-muted">The workflow</h2>
        <dl className="mt-3 space-y-2.5">
          {steps.map(([name, what]) => (
            <div key={name} className="flex items-baseline gap-4 text-sm">
              <dt className="w-28 shrink-0 font-medium text-ink">{name}</dt>
              <dd className="text-ink-secondary">{what}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 max-w-[70ch] text-xs leading-relaxed text-ink-muted">
          The same six stages sit in the bar above, in this order, with a dot per
          stage showing its state. Once a model has been saved, this page becomes
          the portfolio roll-up: the loss position across all three books.
        </p>
      </div>

      <div className="mt-10 border-t border-hairline pt-4">
        <button onClick={onSkip}
          className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline">
          Skip this and run the roll-up on documented default specifications
        </button>
        <p className="mt-1 text-micro text-ink-muted">
          Fits and projects all three books on their documented defaults. The
          first run computes in full and takes a few minutes.
        </p>
      </div>
    </div>
  )
}
