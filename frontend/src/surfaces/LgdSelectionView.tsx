import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, type LgdLeaderboardRow, type PortfolioKey,
} from '../lib/api'
import { NONE, useUi } from '../lib/store'
import { num, pct } from '../lib/format'
import { Card, CardHead, EmptyState, Field, Notice } from '../components/ui'
import { CoreConstruction, RunningCard } from './SelectionSurface'

/** The severity search: the LGD half of the Selection stage.
 *
 *  Same shape as the PD search — candidates and rules, a server-narrated run,
 *  a ranked board — with the severity yardsticks: out-of-time MAE in loss
 *  points as the headline, deviance R² and the refit backtest on finalists,
 *  and a stress check whose direction is severity UP. Rows are named from the
 *  LgdSpec hash, so a row's name IS the severity-half name a saved pairing
 *  will display. */
export default function LgdSelectionView({ pk }: { pk: PortfolioKey }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const shortlist = useUi((s) => s.macroShortlist[pk]?.lgd ?? (NONE as string[]))
  const run = useUi((s) => s.lgdSelectionRun[pk])
  const setRun = useUi((s) => s.setLgdSelectionRun)
  const editLgd = useUi((s) => s.editLgd)
  const fittedLgd = useUi((s) => s.fittedLgd[pk])

  // The severity SCREEN, not the raw column list: candidates arrive ranked
  // by their rank correlation with realised severity, and the proposed seed
  // is the book's documented default specification — never an alphabetical
  // accident.
  const defaults = useQuery({ queryKey: ['lgdscreen', pk, ''],
                              queryFn: () => api.lgdScreen(pk, []) })
  // Driver candidates are tape columns only: macro terms reach the search
  // through the Macro surface's LGD shortlist, never as level columns.
  const numeric = (defaults.data?.rows ?? [])
    .filter((c) => !c.macro && c.kind === 'numeric')
    .sort((a, b) => Math.abs(b.spearman ?? 0) - Math.abs(a.spearman ?? 0))

  // Seeded once: the book's current severity drivers, else the documented
  // default specification — a visible proposal, one click to change.
  const [picked, setPicked] = useState<string[] | null>(null)
  useEffect(() => {
    if (picked !== null || !defaults.data) return
    const have = new Set(numeric.map((c) => c.column))
    const current = (fittedLgd?.spec.drivers ?? [])
      .filter((d) => !d.includes('@') && have.has(d))
    const proposed = (defaults.data.default_spec.drivers ?? [])
      .filter((d) => !d.includes('@') && have.has(d))
    setPicked(current.length ? current
      : proposed.length ? proposed
        : numeric.slice(0, 5).map((c) => c.column))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.data])

  const [maxVif, setMaxVif] = useState(5)
  const [vifRule, setVifRule] = useState<'flag' | 'filter'>('flag')
  const [screenP, setScreenP] = useState(0.1)
  const [corrCap, setCorrCap] = useState(0.7)
  const [minMevs, setMinMevs] = useState(1)
  const [maxMevs, setMaxMevs] = useState(3)
  const [topN, setTopN] = useState(10)
  const [ootFrom, setOotFrom] = useState('2023-01-01')

  const config = () => ({
    candidates: picked ?? [],
    mev_terms: [...shortlist],
    rules: { max_vif: maxVif, vif_rule: vifRule, mev_screen_p: screenP,
             mev_corr_cap: corrCap, min_mevs: minMevs, max_mevs: maxMevs,
             top_n_full: topN },
    oot_from: ootFrom,
  })

  const status = useQuery({
    queryKey: ['lgdselstatus', pk],
    queryFn: () => api.lgdSelectionStatus(pk),
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 700 : false),
    refetchIntervalInBackground: true,
  })
  const st = status.data
  const running = st?.state === 'running'
  const prev = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prev.current === 'running' && st?.state === 'done' && st.config_hash) {
      qc.invalidateQueries({ queryKey: ['lgdselresults', pk, st.config_hash] })
      api.lgdSelectionResults(pk, st.config_hash).then((r) => {
        setRun(pk, { configHash: st.config_hash!, finishedAt: r.generated_at,
                     nModels: r.rows.filter((x) => !x.filtered).length })
      }).catch(() => { /* the board names the problem */ })
    }
    prev.current = st?.state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.state, st?.config_hash, pk])

  const start = useMutation({
    mutationFn: () => api.lgdSelectionRun(pk, config()),
    onSuccess: () => status.refetch(),
  })

  const results = useQuery({
    queryKey: ['lgdselresults', pk, run?.configHash],
    queryFn: () => api.lgdSelectionResults(pk, run!.configHash),
    enabled: !!run, staleTime: Infinity, retry: false,
  })
  const res = results.data
  const [selected, setSelected] = useState<string | null>(null)
  const detail = res?.rows.find((r) => r.hash === selected) ?? null

  const useAsDraft = (r: LgdLeaderboardRow) => {
    const spec = r.spec as Record<string, any>
    editLgd(pk, () => ({
      drivers: spec.drivers ?? [], categoricals: spec.categoricals ?? [],
      treatments: spec.treatments ?? {}, edges: spec.edges ?? {},
      knots: spec.knots ?? {}, n_knots: spec.n_knots, max_bins: spec.max_bins,
    }), 'the severity search selection',
    { drivers: [], categoricals: [] })
    nav(`/${pk}/lgd`)
  }

  const vifFlag = maxVif > 0 ? maxVif : 5

  return (
    <div className="space-y-3">
      {/* ── the run, narrated ─────────────────────────────────────────── */}
      {running && (
        <RunningCard st={st!} pk={pk}
                     onCancel={() => api.lgdSelectionCancel(pk)} />
      )}
      {st?.state === 'error' && (
        <Notice severity="critical" label="The severity search failed">
          {st.error}. The configuration is unchanged, so fix the cause and run
          it again.
        </Notice>
      )}

      {/* ── setup ─────────────────────────────────────────────────────── */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHead title="Severity driver candidates"
            subtitle={defaults.data
              ? `${num(defaults.data.n_defaults)} resolved defaults on this book · ranked by |Spearman| with realised severity`
              : undefined}
            caption="What the severity stepwise search may build the driver core from. Macro terms come from the Macro surface's LGD shortlist, never from this list." />
          {defaults.isError && (
            <p className="px-4 pb-3 text-xs" style={{ color: 'var(--status-critical)' }}>
              {String((defaults.error as Error).message)}
            </p>
          )}
          <div className="thin-scroll max-h-[420px] overflow-auto px-4 pb-4">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface text-tiny text-ink-muted">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Candidate</th>
                  <th className="py-1.5 pr-2 font-medium">Column</th>
                  <th className="py-1.5 text-right font-medium"
                      title="Rank correlation with realised severity on the defaulted population.">
                    Spearman
                  </th>
                  <th className="py-1.5 text-right font-medium"
                      title="Highest minus lowest bucket mean severity, percentage points.">
                    Spread
                  </th>
                  <th className="py-1.5 text-right font-medium"
                      title="Share of resolved defaults where the column is populated.">
                    Filled
                  </th>
                </tr>
              </thead>
              <tbody>
                {numeric.map((c) => {
                  const on = (picked ?? []).includes(c.column)
                  return (
                    <tr key={c.column}
                        onClick={() => setPicked((p) => on
                          ? (p ?? []).filter((x) => x !== c.column)
                          : [...(p ?? []), c.column])}
                        className="cursor-pointer border-b border-hairline hover:bg-sunken/60">
                      <td className="py-1.5 pr-2">
                        <input type="checkbox" readOnly checked={on} />
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-micro">{c.column}</td>
                      <td className="py-1.5 text-right tnum">
                        {c.spearman == null ? '—'
                          : (c.spearman >= 0 ? '+' : '') + c.spearman.toFixed(2)}
                      </td>
                      <td className="py-1.5 text-right tnum text-ink-secondary">
                        {(c.spread * 100).toFixed(0)}pt
                      </td>
                      <td className="py-1.5 text-right tnum text-ink-muted">
                        {pct(c.filled * 100, 0)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHead title="Search rules"
              caption="The same discipline as the PD search: the VIF cap applies to core entry, macro terms come 1 to 3 per model from the shortlist, and the headline is out-of-time MAE in loss points." />
            <div className="grid grid-cols-2 gap-3 px-4 pb-4">
              <Field label="Macro terms per model">
                <div className="flex items-center gap-1">
                  <select value={minMevs} onChange={(e) => setMinMevs(+e.target.value)}
                    className="rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs">
                    {[1, 2, 3].map((n) => <option key={n}>{n}</option>)}
                  </select>
                  <span className="text-tiny text-ink-muted">to</span>
                  <select value={maxMevs} onChange={(e) => setMaxMevs(+e.target.value)}
                    className="rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs">
                    {[1, 2, 3].map((n) => <option key={n}>{n}</option>)}
                  </select>
                </div>
              </Field>
              <Field label="Out of time from">
                <input type="date" value={ootFrom}
                  onChange={(e) => setOotFrom(e.target.value)}
                  className="w-full rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs" />
              </Field>
              <Field label="Macro screen p">
                <input type="number" step="0.01" value={screenP}
                  onChange={(e) => setScreenP(+e.target.value)}
                  className="w-full rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs" />
              </Field>
              <Field label="Macro pair correlation cap">
                <input type="number" step="0.05" value={corrCap}
                  onChange={(e) => setCorrCap(+e.target.value)}
                  className="w-full rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs" />
              </Field>
              <Field label="VIF rule">
                <div className="flex items-center gap-1">
                  <select value={vifRule}
                    onChange={(e) => setVifRule(e.target.value as 'flag' | 'filter')}
                    className="rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs">
                    <option value="flag">Flag</option>
                    <option value="filter">Filter</option>
                  </select>
                  <input type="number" step="1" min={2} value={maxVif}
                    onChange={(e) => setMaxVif(+e.target.value)}
                    className="w-16 rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs" />
                </div>
              </Field>
              <Field label="Finalists">
                <input type="number" step="1" min={1} max={12} value={topN}
                  onChange={(e) => setTopN(+e.target.value)}
                  className="w-full rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-xs" />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHead title="Macro terms, from your LGD shortlist" />
            <div className="px-4 pb-4">
              {shortlist.length === 0 ? (
                <p className="text-xs text-ink-secondary">
                  Nothing is shortlisted for LGD on the Macro surface yet. The
                  search needs at least one term there — open the Macro
                  surface, rank against LGD, and shortlist the terms that
                  should reach severity.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {shortlist.map((t) => (
                    <span key={t}
                      className="rounded-full border border-accent/60 px-2 py-0.5 font-mono text-micro text-ink-secondary">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button
                  disabled={running || !(picked?.length) || shortlist.length === 0}
                  onClick={() => start.mutate()}
                  title={shortlist.length === 0
                    ? 'The search needs at least one macro term from the LGD shortlist.'
                    : !(picked?.length)
                      ? 'Pick at least one severity driver candidate.'
                      : undefined}
                  className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
                  {running ? 'A search is running' : 'Run the severity search'}
                </button>
                {start.isError && (
                  <span className="text-tiny" style={{ color: 'var(--status-critical)' }}>
                    {String((start.error as Error).message)}
                  </span>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* ── the board ─────────────────────────────────────────────────── */}
      {run && (
        <div className={`grid gap-3 ${detail ? 'xl:grid-cols-[minmax(0,1fr)_420px]' : ''}`}>
          <Card>
            <CardHead title="Severity leaderboard"
              subtitle={res ? `${num(res.rows.filter((r) => !r.filtered).length)} models `
                + `from ${num(res.n_combos)} fitted combinations · `
                + `${num(res.n_train)} defaults in time, ${num(res.n_test)} out of time`
                : undefined}
              caption="Ranked by the stated composite: out-of-time MAE in loss points carries the discrimination slot, the VIF credit and stress direction are the validator checks, and the severe scenario must push severity up." />
            {results.isError && (
              <div className="px-4 pb-4">
                <EmptyState title="These results are no longer on this machine"
                  action={<button onClick={() => start.mutate()}
                    className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
                    Run the search again</button>}>
                  {String((results.error as Error).message)}
                </EmptyState>
              </div>
            )}
            {res && !res.current && (
              <Notice severity="warning" label="These results describe a superseded panel">
                Re-run the search to score the current data.
              </Notice>
            )}
            {res && res.cores.map((core) => (
              <div key={core.name}
                   className="border-t border-hairline bg-sunken/40 px-4 py-3">
                <p className="mb-2 text-tiny font-medium text-ink">
                  {core.name} severity core
                  <span className="ml-2 font-normal text-ink-muted">
                    {core.columns.length} driver{core.columns.length === 1 ? '' : 's'}
                  </span>
                </p>
                <CoreConstruction core={core} entryMetric="p_value"
                                  vifFlag={vifFlag} />
              </div>
            ))}
            {res && (
              <div className="thin-scroll max-h-[560px] overflow-auto">
                <table className="w-full min-w-[980px] table-fixed text-left text-xs">
                  <colgroup>
                    <col className="w-11" /><col className="w-48" /><col />
                    <col className="w-[4.6rem]" /><col className="w-16" />
                    <col className="w-16" /><col className="w-16" />
                    <col className="w-14" /><col className="w-12" />
                    <col className="w-20" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 border-y border-hairline bg-surface text-tiny text-ink-muted [&_th]:whitespace-nowrap">
                    <tr>
                      <th className="px-2 py-2 text-right font-medium">Rank</th>
                      <th className="px-2 py-2 font-medium">Model</th>
                      <th className="px-2 py-2 font-medium">Macro terms</th>
                      <th className="px-2 py-2 text-right font-medium"
                          title="Mean absolute error on realised severity for defaults resolved after the boundary, scored with the in-time fit. Loss points.">
                        MAE OOT
                      </th>
                      <th className="px-2 py-2 text-right font-medium"
                          title="Mean absolute error on the fitted rows.">MAE in</th>
                      <th className="px-2 py-2 text-right font-medium"
                          title="Quasi-likelihood analogue of pseudo R². Finalists only.">
                        Dev R²
                      </th>
                      <th className="px-2 py-2 text-right font-medium"
                          title="The least significant coefficient.">Max p</th>
                      <th className="px-2 py-2 text-right font-medium"
                          title="Worst design-column VIF.">VIF</th>
                      <th className="px-2 py-2 text-center font-medium"
                          title="Whether a driver coefficient flipped sign or shifted materially when the macro terms joined.">
                        Shift
                      </th>
                      <th className="px-2 py-2 text-center font-medium"
                          title="Peak severity must order by scenario severity — the severe path pushes loss severity UP.">
                        Stress ↑
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.rows.filter((r) => r.auto_rank != null)
                      .sort((a, b) => a.auto_rank! - b.auto_rank!)
                      .map((r) => {
                        const active = r.hash === selected
                        return (
                          <tr key={r.hash}
                              onClick={() => setSelected(active ? null : r.hash)}
                              className={`cursor-pointer border-b border-hairline [&>td]:truncate ${
                                active ? 'bg-accent-soft' : 'hover:bg-sunken/60'}`}>
                            <td className="px-2 py-1.5 text-right tnum text-ink-muted">
                              {r.auto_rank}
                            </td>
                            <td className="px-2 py-1.5"
                                title={`${r.name} — ${r.n_core} drivers${
                                  r.finalist ? '' : ' (no full panel yet)'}`}>
                              <span className="font-medium text-ink">{r.name}</span>
                              <span className="ml-1.5 text-micro text-ink-muted">
                                {r.lineage.map((l) => l.core).join(', ')} core
                              </span>
                            </td>
                            <td className="px-2 py-1.5 font-mono text-micro text-ink-secondary"
                                title={r.mevs.map((m) => m.label).join('\n')}>
                              {r.mevs.map((m) => m.label).join('  ')}
                            </td>
                            <td className="px-2 py-1.5 text-right tnum text-ink"
                                title={r.mae_oot == null
                                  ? 'Fewer than 20 defaults resolved after the boundary — too thin to report.'
                                  : undefined}>
                              {r.mae_oot == null ? '—' : r.mae_oot.toFixed(4)}
                            </td>
                            <td className="px-2 py-1.5 text-right tnum">
                              {r.mae_in.toFixed(4)}
                            </td>
                            <td className="px-2 py-1.5 text-right tnum text-ink-secondary">
                              {r.deviance_r2 == null ? '—' : r.deviance_r2.toFixed(3)}
                            </td>
                            <td className="px-2 py-1.5 text-right tnum"
                                style={{ color: r.all_significant ? undefined
                                  : 'var(--status-warning)' }}>
                              {r.max_p == null ? '—'
                                : r.max_p < 0.001 ? '<0.001' : r.max_p.toFixed(3)}
                            </td>
                            <td className="px-2 py-1.5 text-right tnum"
                                style={{ color: r.max_vif == null ? undefined
                                  : r.max_vif > 2 * vifFlag ? 'var(--status-critical)'
                                    : r.max_vif > vifFlag ? 'var(--status-warning)'
                                      : undefined }}>
                              {r.max_vif == null ? '—' : r.max_vif.toFixed(1)}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {r.core_shifted
                                ? <span style={{ color: 'var(--status-warning)' }}
                                    title={r.core_shifts.map((s) =>
                                      `${s.column}: ${s.before.toFixed(3)} to ${
                                        s.after.toFixed(3)}${s.flipped ? ' (sign flip)' : ''}`)
                                      .join('; ')}>●</span>
                                : <span className="text-ink-muted">—</span>}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {r.stress?.usable
                                ? <span style={{ color: r.stress.monotone
                                    ? 'var(--status-good)' : 'var(--status-critical)' }}
                                    title={`Peak stressed severity ${
                                      pct(100 * (r.stress.peak_stressed_severity ?? 0), 1)} against a mean of ${
                                      pct(100 * (r.stress.anchor_severity ?? 0), 1)}.`}>
                                    {r.stress.monotone ? 'Y' : 'N'}
                                  </span>
                                : <span className="text-ink-muted">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {detail && (
            <Card className="self-start">
              <CardHead title={detail.name}
                subtitle={`Severity model ${detail.hash} · ${
                  detail.lineage.map((l) => l.core).join(', ')} core`}
                right={<button onClick={() => setSelected(null)}
                  className="text-tiny text-ink-muted hover:text-ink">Close</button>} />
              <div className="space-y-3 px-4 pb-4">
                <div>
                  <h4 className="mb-1 text-tiny font-medium text-ink-muted">Coefficients</h4>
                  <table className="w-full text-left text-xs">
                    <thead className="text-tiny text-ink-muted">
                      <tr><th className="py-1 font-medium">Term</th>
                          <th className="py-1 text-right font-medium">Estimate</th>
                          <th className="py-1 text-right font-medium">p</th>
                          <th className="py-1 text-right font-medium">VIF</th></tr>
                    </thead>
                    <tbody>
                      {detail.coefficients.filter((c) => c.name !== 'intercept')
                        .map((c) => (
                        <tr key={c.name} className="border-t border-hairline">
                          <td className="py-1 pr-2 font-mono text-micro">{c.name}</td>
                          <td className="py-1 text-right tnum">{c.estimate.toFixed(4)}</td>
                          <td className="py-1 text-right tnum">
                            {c.p_value == null ? '—'
                              : c.p_value < 0.001 ? '<0.001' : c.p_value.toFixed(3)}
                          </td>
                          <td className="py-1 text-right tnum text-ink-muted">
                            {c.term_vif == null ? '—' : c.term_vif.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {detail.stress?.usable && (
                  <p className="text-tiny text-ink-secondary">
                    Stress behaviour: mean severity {pct(100 * (detail.stress.anchor_severity ?? 0), 1)},
                    severely adverse peak {pct(100 * (detail.stress.peak_stressed_severity ?? 0), 1)}.
                    {detail.stress.monotone
                      ? ' The response orders correctly by scenario severity.'
                      : ' The response DOES NOT order by scenario severity.'}
                  </p>
                )}
                {detail.finalist && detail.full && (
                  <p className="text-tiny text-ink-secondary">
                    Full panel: deviance R² {detail.full.deviance_r2?.toFixed(3) ?? '—'},
                    Spearman {detail.full.spearman?.toFixed(3) ?? '—'},
                    link test {detail.full.link_test_ok == null ? '—'
                      : detail.full.link_test_ok ? 'passes' : 'fails'}.
                  </p>
                )}
                {!detail.finalist && (
                  <p className="text-micro text-ink-muted">
                    Board statistics only. Finalists carry deviance R², the
                    link test and the refit backtest.
                  </p>
                )}
                <button onClick={() => useAsDraft(detail)}
                  className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
                  Use as the severity draft
                </button>
              </div>
            </Card>
          )}
        </div>
      )}

      {!run && !running && (
        <Card>
          <div className="px-4 py-6">
            <EmptyState title="No severity search has run on this book">
              Pick the driver candidates, check the LGD shortlist, and run the
              search. The board appears here.
            </EmptyState>
          </div>
        </Card>
      )}
    </div>
  )
}
