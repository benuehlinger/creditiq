import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, errorText, type LeaderboardRow, type PortfolioKey,
  type SelectionResults, type SelectionReview, type SelectionStatus,
} from '../lib/api'
import { useUi } from '../lib/store'
import { fromRequest } from '../lib/spec'
import { num, pct } from '../lib/format'
import { Card, CardHead, EmptyState, Field, Notice, Skeleton, ViewTabs } from '../components/ui'

/**
 * The Selection surface: configure an automated variable search, watch it run
 * with the server narrating every fit, then review the leaderboard.
 *
 * State discipline, because this surface is where it would slip first:
 *  - the setup draft lives in the store (survives navigation and reloads)
 *  - the job lives on the SERVER; this component only polls its status, so
 *    leaving mid-run and coming back resumes for free
 *  - results live in the server's identity-keyed cache behind the query cache;
 *    revisiting the leaderboard is a lookup, never a computation
 *  - review state (user rank, status, justifications) lives on the server in
 *    versions/selection, never in this component
 */

const STAGE_LABELS = ['Cores', 'Macro screen', 'Combinations', 'Finalists']

const REASON_LABELS: Record<string, string> = {
  counterintuitive_mev_sign: 'Counterintuitive MEV sign',
  mev_not_intuitive_for_portfolio: 'MEV not intuitive for this portfolio',
  unstable_coefficients: 'Unstable coefficients',
  weak_stress_response: 'Weak stress response',
  business_judgment: 'Business judgment',
  other: 'Other',
}

function reviewerName(): string {
  try { return localStorage.getItem('creditiq-reviewer') ?? '' } catch { return '' }
}
function rememberReviewer(name: string) {
  try { localStorage.setItem('creditiq-reviewer', name) } catch { /* fine */ }
}

const fmtP = (p: number | null | undefined) =>
  p == null ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3)

/** `key@transform@lag` in the words the Macro surface uses. */
const TF_LABEL: Record<string, string> = {
  level: '', diff: ' 1m chg', yoy: ' YoY', log_diff: ' log-diff',
  qoq_annualized: ' QoQ ann.', z_score: ' z', four_quarter_change: ' 12m chg',
  ma3: ' 3m avg', ma6: ' 6m avg', ma12: ' 12m avg',
  yoy_ma3: ' YoY 3m avg', diff_ma3: ' 1m chg 3m avg',
}
function termLabel(t: string): string {
  const [key, tf, lag] = t.split('@')
  return `${key}${TF_LABEL[tf ?? 'level'] ?? ` ${tf}`}${Number(lag) ? ` (lag ${lag}m)` : ''}`
}

export default function SelectionSurface() {
  const { portfolio } = useParams()
  const pk = portfolio as PortfolioKey
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const run = useUi((s) => s.selectionRun[pk])
  const setRun = useUi((s) => s.setSelectionRun)

  // The job is server state. Poll fast while it runs, not at all otherwise.
  const status = useQuery({
    queryKey: ['selstatus', pk],
    queryFn: () => api.selectionStatus(pk),
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 700 : false),
    refetchIntervalInBackground: true,
  })
  const st = status.data
  const running = st?.state === 'running'

  // When a run completes, record the pointer and open the board.
  const prevState = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prevState.current === 'running' && st?.state === 'done' && st.config_hash) {
      qc.invalidateQueries({ queryKey: ['selresults', pk, st.config_hash] })
      api.selectionResults(pk, st.config_hash).then((r) => {
        setRun(pk, { configHash: st.config_hash!, finishedAt: r.generated_at,
                     nModels: r.rows.filter((x) => !x.filtered).length })
        setParams({ view: 'leaderboard' }, { replace: true })
      }).catch(() => { /* the results card will name the problem */ })
    }
    prevState.current = st?.state
  }, [st?.state, st?.config_hash, pk])

  const view = params.get('view')
    ?? (run ? 'leaderboard' : 'setup')

  return (
    <div className="mx-auto max-w-[1500px] space-y-3 px-4 py-4">
      <div className="flex items-center justify-between">
        <ViewTabs
          value={view as 'setup' | 'leaderboard'}
          onChange={(v) => setParams(v === 'setup' ? { view: 'setup' }
                                                   : { view: 'leaderboard' })}
          tabs={[{ key: 'setup', label: 'Setup' },
                 { key: 'leaderboard', label: 'Leaderboard' }]} />
        {run && view === 'setup' && (
          <span className="text-tiny text-ink-muted">
            Last run: {num(run.nModels)} models on the board
          </span>
        )}
      </div>

      {running && <RunningCard st={st!} pk={pk} />}
      {st?.state === 'error' && (
        <Notice severity="critical" label="The search failed">
          {st.error}. The configuration is unchanged, so fix the cause and run
          it again.
        </Notice>
      )}
      {st?.state === 'cancelled' && (
        <Notice severity="warning" label="The search was cancelled">
          Nothing was recorded. Run it again when ready.
        </Notice>
      )}

      {view === 'setup'
        ? <SetupView pk={pk} running={!!running}
                     onStarted={() => status.refetch()} />
        : <LeaderboardView pk={pk} running={!!running}
                           goSetup={() => setParams({ view: 'setup' })} />}
    </div>
  )
}

// ── the run, narrated by the server ─────────────────────────────────────────
function RunningCard({ st, pk }: { st: SelectionStatus; pk: PortfolioKey }) {
  const stageNo = st.stage_no ?? 1
  const frac = st.total ? Math.min((st.step ?? 0) / st.total, 1) : 0
  return (
    <Card>
      <div className="px-5 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="text-sm font-medium text-ink">
            Stage {stageNo} of {st.n_stages ?? 4}: {STAGE_LABELS[stageNo - 1]}
            <span className="ml-1 inline-block w-4 text-left text-ink-muted animate-[dots_1.2s_steps(4,end)_infinite]" />
          </div>
          <div className="tnum text-tiny text-ink-muted">
            {st.total ? `${num(st.step ?? 0)} of ${num(st.total)} · ` : ''}
            {(st.elapsed_s ?? 0).toFixed(0)}s
          </div>
        </div>
        <div className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300 ease-out"
               style={{ width: `${Math.max(frac * 100, 2)}%` }}>
            <div className="absolute inset-0 animate-[sheen_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/30 to-transparent" />
          </div>
        </div>
        {/* the verbose part: the server names the exact fit in flight */}
        <p className="mt-2 min-h-4 text-tiny text-ink-secondary">{st.label}</p>
        <div className="mt-3 flex items-center justify-between">
          <ol className="flex gap-2">
            {STAGE_LABELS.map((l, i) => (
              <li key={l}
                  className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-micro ${
                    i + 1 < stageNo ? 'border-hairline text-ink-muted'
                    : i + 1 === stageNo ? 'border-accent text-ink'
                    : 'border-hairline text-ink-muted opacity-50'}`}>
                {i + 1 < stageNo
                  ? <span style={{ color: 'var(--status-good)' }}>·</span>
                  : i + 1 === stageNo
                    ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                    : <span className="h-1.5 w-1.5 rounded-full bg-sunken" />}
                {l}
              </li>
            ))}
          </ol>
          <button onClick={() => api.selectionCancel(pk)}
                  className="rounded-ctl border border-hairline px-2.5 py-1 text-tiny text-ink-secondary hover:text-ink">
            Cancel
          </button>
        </div>
      </div>
    </Card>
  )
}

// ── setup ───────────────────────────────────────────────────────────────────
function SetupView({ pk, running, onStarted }: {
  pk: PortfolioKey; running: boolean; onStarted: () => void
}) {
  const draft = useUi((s) => s.selectionDraft[pk])
  const setDraft = useUi((s) => s.setSelectionDraft)
  const shortlist = useUi((s) => s.macroShortlist[pk].pd)
  const nav = useNavigate()
  const defaults = useQuery({ queryKey: ['seldefaults', pk],
                              queryFn: () => api.selectionDefaults(pk),
                              staleTime: Infinity })
  const d = defaults.data

  // Seed the draft once from the screened candidate list. Everything is
  // OFFERED, but the default inclusion is deliberate: leakage-shaped columns
  // and columns whose information value never cleared the null floor start
  // excluded. A 'review' verdict alone does not exclude — the leakage check
  // deliberately asks a human to look at strong-but-honest drivers like FICO
  // — but review PLUS an information value no real driver reaches is the
  // planted near-target column, and an automated search must not start with
  // it. Excluded is visible and one click to reverse, never silently dropped.
  // Numeric candidates default to CONTINUOUS; categoricals to WoE.
  // The macro terms are the Macro surface's shortlist, verbatim.
  useEffect(() => {
    if ((draft && draft.mev_terms) || !d) return
    setDraft(pk, {
      candidates: d.candidates.map((c) => ({
        column: c.column,
        role: c.leakage_risk === 'likely'
              || (c.leakage_risk === 'review' && (c.iv ?? 0) > 1.5)
              || c.above_null === false ? 'excluded' : 'candidate',
        treatment: c.kind === 'categorical' ? 'woe' : 'continuous',
      })),
      cores: ['stepwise', 'strong'],
      expert_core: null,
      mev_terms: [...shortlist],
      rules: {},
      oot_from: '2023-01-01',
    })
  }, [draft, d, pk, shortlist])

  const preview = useQuery({
    queryKey: ['selpreview', pk, JSON.stringify(draft)],
    queryFn: () => api.selectionPreview(pk, draft!),
    enabled: !!draft,
    staleTime: Infinity,
  })

  const start = useMutation({
    mutationFn: () => api.selectionRun(pk, draft!),
    onSuccess: onStarted,
  })

  const savedConfigs = useQuery({ queryKey: ['selconfigs', pk],
                                  queryFn: () => api.selectionConfigs(pk) })
  const [saveName, setSaveName] = useState('')
  const qc = useQueryClient()
  const saveAndRun = useMutation({
    mutationFn: () => api.selectionRun(pk, draft!, saveName || undefined),
    onSuccess: () => { onStarted(); qc.invalidateQueries({ queryKey: ['selconfigs', pk] }) },
  })

  if (!d || !draft) return <Skeleton className="h-64" />

  const rules = draft.rules ?? {}
  const setRule = (k: string, v: unknown) =>
    setDraft(pk, { ...draft, rules: { ...rules, [k]: v } })
  const nCand = draft.candidates.filter((c) => c.role !== 'excluded').length
  const terms = draft.mev_terms ?? []
  // The union of the live shortlist and the draft, so a term shortlisted
  // after the draft was seeded is offered here without a reset.
  const offered = [...new Set([...shortlist, ...terms])]

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card>
        <CardHead title="Candidate variables"
          subtitle="What the stepwise search may build the borrower core from"
          caption="Each variable enters with the treatment chosen here. A spline or a set of bin indicators enters and leaves the model as one block. Columns the leakage check flagged, and columns below the information-value null floor, arrive excluded; include one only deliberately."
          right={<button onClick={() => setDraft(pk, null)}
            title="Discard this setup and reseed it from the variable screen."
            className="rounded-ctl border border-hairline px-2 py-0.5 text-tiny text-ink-secondary hover:text-ink">
            Reset to defaults
          </button>} />
        <div className="thin-scroll max-h-[480px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 border-y border-hairline bg-surface text-tiny text-ink-muted">
              <tr>
                <th className="px-2 py-2 font-medium">Candidate</th>
                <th className="px-2 py-2 font-medium">Variable</th>
                <th className="px-2 py-2 text-right font-medium"
                    title="Information value on the screening sample.">IV</th>
                <th className="px-2 py-2 font-medium">Treatment</th>
                <th className="px-2 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {draft.candidates.map((c, i) => {
                const meta = d.candidates.find((x) => x.column === c.column)
                const included = c.role !== 'excluded'
                return (
                  <tr key={c.column} className="border-b border-hairline">
                    <td className="px-2 py-1.5 text-center"
                        onClick={() => {
                          const next = [...draft.candidates]
                          next[i] = { ...c, role: included ? 'excluded' : 'candidate' }
                          setDraft(pk, { ...draft, candidates: next })
                        }}>
                      <span className={`inline-block h-3 w-3 cursor-pointer rounded-sm border ${
                        included ? 'border-accent bg-accent' : 'border-hairline'}`} />
                    </td>
                    <td className={`px-2 py-1.5 font-mono text-tiny ${
                      included ? 'text-ink' : 'text-ink-muted'}`}>{c.column}</td>
                    <td className="px-2 py-1.5 text-right tnum text-ink-secondary">
                      {meta?.iv == null ? '—' : meta.iv.toFixed(3)}
                    </td>
                    <td className="px-2 py-1.5">
                      <select value={c.treatment ?? 'woe'} disabled={!included}
                        onChange={(e) => {
                          const next = [...draft.candidates]
                          next[i] = { ...c, treatment: e.target.value }
                          setDraft(pk, { ...draft, candidates: next })
                        }}
                        className="rounded-ctl border border-hairline bg-surface px-1.5 py-0.5 text-tiny">
                        {meta?.kind === 'categorical'
                          ? <><option value="woe">WoE</option>
                              <option value="bins">Dummies</option></>
                          : <><option value="woe">WoE</option>
                              <option value="bins">Dummies</option>
                              <option value="continuous">Continuous</option>
                              <option value="spline">Spline</option></>}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-micro text-ink-muted">
                      {meta?.leakage_risk === 'likely' && (
                        <span className="mr-2" style={{ color: 'var(--status-critical)' }}>
                          leakage shaped
                        </span>)}
                      {meta?.leakage_risk === 'review' && (
                        <span className="mr-2" title="The leakage check wants a human look at this column before it enters a model."
                              style={{ color: 'var(--status-warning)' }}>
                          leakage review
                        </span>)}
                      {meta?.above_null === false && (
                        <span className="mr-2" title="Information value below the null floor: a variable with no relationship to the target scores this much by chance.">
                          below null floor
                        </span>)}
                      {meta?.cyclical && (
                        <span title="Moves with the cycle. It can absorb the macro signal, weakening or flipping the scenario terms."
                              style={{ color: 'var(--status-warning)' }}>
                          cyclical
                        </span>)}
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
            subtitle="Entry, exit and the macro constraints" />
          <div className="grid grid-cols-2 gap-3 px-4 pb-4">
            <Field label="Entry and exit rule"
                   hint="BIC uses the event count, the rare-event convention. The p-value rule is available for reviewers who ask for one.">
              <select value={rules.entry_metric ?? 'bic'}
                onChange={(e) => setRule('entry_metric', e.target.value)}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs">
                <option value="bic">BIC, on events</option>
                <option value="aic">AIC</option>
                <option value="p_value">p-value</option>
              </select>
            </Field>
            <Field label="Macro terms per model"
                   hint="Every model carries at least one macro term, or the scenario engine cannot reach it. Three is the ceiling.">
              <div className="flex items-center gap-1 text-xs">
                <select value={rules.min_mevs ?? 1}
                  onChange={(e) => setRule('min_mevs', Number(e.target.value))}
                  className="rounded-ctl border border-hairline bg-surface px-2 py-1">
                  {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <span className="text-ink-muted">to</span>
                <select value={rules.max_mevs ?? 3}
                  onChange={(e) => setRule('max_mevs', Number(e.target.value))}
                  className="rounded-ctl border border-hairline bg-surface px-2 py-1">
                  {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </Field>
            <Field label="Macro screen p"
                   hint="A loose cut for single-term screening. Its job is to shrink hundreds of variants to dozens, not to pick the model.">
              <input type="number" step="0.01" min="0.01" max="0.5"
                value={rules.mev_screen_p ?? 0.10}
                onChange={(e) => setRule('mev_screen_p', Number(e.target.value))}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs tnum" />
            </Field>
            <Field label="Macro pair correlation cap"
                   hint="Two macro terms more correlated than this never enter one model together.">
              <input type="number" step="0.05" min="0.1" max="0.95"
                value={rules.mev_corr_cap ?? 0.7}
                onChange={(e) => setRule('mev_corr_cap', Number(e.target.value))}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs tnum" />
            </Field>
            <Field label="p-value rule" hint="Filter drops a model whose worst p exceeds the cutoff; flag keeps it on the board with the flag set.">
              <select value={rules.p_rule ?? 'flag'}
                onChange={(e) => setRule('p_rule', e.target.value)}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs">
                <option value="flag">Flag</option>
                <option value="filter">Filter</option>
              </select>
            </Field>
            <Field label="VIF rule" hint="Same choice for the collinearity ceiling.">
              <div className="flex gap-1">
                <select value={rules.vif_rule ?? 'flag'}
                  onChange={(e) => setRule('vif_rule', e.target.value)}
                  className="rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs">
                  <option value="flag">Flag</option>
                  <option value="filter">Filter</option>
                </select>
                <input type="number" step="1" min="2" value={rules.max_vif ?? 5}
                  onChange={(e) => setRule('max_vif', Number(e.target.value))}
                  className="w-16 rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs tnum" />
              </div>
            </Field>
            <Field label="Max core variables" hint="A ceiling on the stepwise core's size. Blank means the entry rule decides.">
              <input type="number" min="1" value={rules.max_predictors ?? ''}
                onChange={(e) => setRule('max_predictors',
                  e.target.value ? Number(e.target.value) : null)}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs tnum" />
            </Field>
            <Field label="Finalists" hint="How many top models get the full fit, backtest and error decomposition. The rest carry lean statistics until promoted.">
              <input type="number" min="1" max="12" value={rules.top_n_full ?? 10}
                onChange={(e) => setRule('top_n_full', Number(e.target.value))}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs tnum" />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHead title="Cores and macro families" />
          <div className="space-y-3 px-4 pb-4">
            <div className="flex flex-wrap gap-2">
              {[['stepwise', 'Stepwise core'], ['strong', 'Strongest drivers'],
                ['expert', 'Expert core']].map(([k, l]) => (
                <button key={k}
                  onClick={() => {
                    const cores = draft.cores ?? ['stepwise', 'strong']
                    setDraft(pk, { ...draft, cores: cores.includes(k)
                      ? cores.filter((c) => c !== k) : [...cores, k] })
                  }}
                  className={`rounded-full border px-2.5 py-1 text-tiny ${
                    (draft.cores ?? []).includes(k)
                      ? 'border-accent bg-accent-soft text-ink'
                      : 'border-hairline text-ink-muted'}`}>
                  {l}
                </button>
              ))}
            </div>
            {(draft.cores ?? []).includes('expert') && (
              <Field label="Expert core" hint="Your own variable list, fitted verbatim beside the searched cores. Comma separated column names.">
                <input value={(draft.expert_core ?? []).join(', ')}
                  onChange={(e) => setDraft(pk, { ...draft,
                    expert_core: e.target.value.split(',')
                      .map((s) => s.trim()).filter(Boolean) })}
                  placeholder="fico_orig, dti"
                  className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 font-mono text-tiny" />
              </Field>
            )}
            <div>
              <span className="text-tiny text-ink-muted"
                    title="The search enumerates combinations of one to three from exactly these terms, one per underlying series. It never sweeps the transformation library; that sweep is the Macro surface's job.">
                Macro terms in the search, from your Macro shortlist
              </span>
              {offered.length === 0 ? (
                <div className="mt-1.5 rounded-ctl bg-sunken px-3 py-2 text-tiny text-ink-secondary">
                  Nothing is shortlisted for PD on the Macro surface yet.
                  The search needs at least one term there.
                  <button onClick={() => nav(`/${pk}/macro`)}
                    className="ml-2 underline decoration-hairline hover:text-ink">
                    Open the Macro surface
                  </button>
                </div>
              ) : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {offered.map((t) => {
                    const on = terms.includes(t)
                    return (
                      <button key={t}
                        title={shortlist.includes(t)
                          ? 'On the Macro shortlist. Click to leave it out of this search.'
                          : 'No longer on the Macro shortlist; kept from this setup. Click to drop it.'}
                        onClick={() => setDraft(pk, { ...draft,
                          mev_terms: on ? terms.filter((k) => k !== t)
                                        : [...terms, t] })}
                        className={`rounded-full border px-2 py-0.5 font-mono text-micro ${
                          on ? 'border-accent bg-accent-soft text-ink'
                             : 'border-hairline text-ink-muted'}`}>
                        {termLabel(t)}
                      </button>
                    )
                  })}
                </div>
              )}
              <p className="mt-1.5 text-micro text-ink-muted">
                Shortlist more terms on the
                {' '}<button onClick={() => nav(`/${pk}/macro`)}
                  className="underline decoration-hairline hover:text-ink">Macro surface</button>;
                a base variable and its derived forms count as one family, and
                at most one term per family enters a model.
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="Run" />
          <div className="space-y-3 px-4 pb-4">
            {preview.data && terms.length > 0 && (
              <div className="rounded-ctl bg-sunken px-3 py-2 text-tiny text-ink-secondary">
                {num(nCand)} candidate variables over {preview.data.n_cores} cores;
                {' '}{num(preview.data.n_mev_terms)} shortlisted terms in
                {' '}{num(preview.data.n_families)} families, giving at most
                {' '}{num(preview.data.combo_bound)} combinations of
                {' '}{rules.min_mevs ?? 1} to {rules.max_mevs ?? 3} per core
                before the screen and the correlation rule.
                {preview.data.warning && (
                  <p className="mt-1" style={{ color: 'var(--status-warning)' }}>
                    {preview.data.warning}
                  </p>
                )}
              </div>
            )}
            {start.error && (
              <p className="text-tiny" style={{ color: 'var(--status-critical)' }}>
                {String((start.error as Error).message)}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button disabled={running || !nCand || terms.length === 0}
                title={terms.length === 0
                  ? 'The search needs at least one macro term from the shortlist.'
                  : undefined}
                onClick={() => start.mutate()}
                className="rounded-ctl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {running ? 'A search is running' : 'Run the search'}
              </button>
              <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
                placeholder="Save configuration as…"
                className="w-44 rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-tiny" />
              <button disabled={running || !nCand || terms.length === 0 || !saveName}
                onClick={() => saveAndRun.mutate()}
                title="Store this configuration for reuse, then run it"
                className="rounded-ctl border border-hairline px-3 py-1.5 text-tiny text-ink-secondary hover:text-ink disabled:opacity-40">
                Save and run
              </button>
            </div>
            {(savedConfigs.data?.configs.length ?? 0) > 0 && (
              <div className="text-tiny text-ink-muted">
                Saved:{' '}
                {savedConfigs.data!.configs.map((c) => (
                  <button key={c.id} className="mr-2 underline decoration-hairline hover:text-ink"
                    onClick={() => api.selectionConfig(pk, c.id)
                      .then((r) => setDraft(pk, r.config))}>
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

// ── the leaderboard ─────────────────────────────────────────────────────────
type SortKey = 'auto' | 'user' | 'auc_oot' | 'max_p' | 'peak' | 'rmse'

function LeaderboardView({ pk, running, goSetup }: {
  pk: PortfolioKey; running: boolean; goSetup: () => void
}) {
  const run = useUi((s) => s.selectionRun[pk])
  const [params, setParams] = useSearchParams()
  const results = useQuery({
    queryKey: ['selresults', pk, run?.configHash],
    queryFn: () => api.selectionResults(pk, run!.configHash),
    enabled: !!run,
    staleTime: Infinity,
    retry: false,
  })
  const review = useQuery({
    queryKey: ['selreview', pk, run?.configHash],
    queryFn: () => api.selectionReview(pk, run!.configHash),
    enabled: !!run && !!results.data,
  })

  if (!run) {
    return (
      <Card>
        <EmptyState title="No search has been run on this book"
          action={<button onClick={goSetup}
            className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
            Configure a search</button>}>
          {running
            ? 'A search is running now; the board opens when it completes.'
            : 'Configure the candidates and rules, then run the search. The leaderboard appears here.'}
        </EmptyState>
      </Card>
    )
  }
  if (results.isLoading) return <Skeleton className="h-64" />
  if (results.error) {
    return (
      <Card>
        <EmptyState title="These results are no longer on this machine"
          action={<button onClick={goSetup}
            className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
            Run the search again</button>}>
          {errorText(null, String((results.error as Error).message))}
        </EmptyState>
      </Card>
    )
  }
  const res = results.data!
  return (
    <>
      {!res.current && (
        <Notice severity="warning" label="These results describe a superseded panel">
          The data was rebuilt after this search ran. The board is shown for
          reference; re-run the search to score the current panel.
        </Notice>
      )}
      <Board pk={pk} res={res} review={review.data}
             selected={params.get('model')}
             onSelect={(h) => setParams(h
               ? { view: 'leaderboard', model: h }
               : { view: 'leaderboard' })} />
    </>
  )
}

function Board({ pk, res, review, selected, onSelect }: {
  pk: PortfolioKey; res: SelectionResults; review?: SelectionReview
  selected: string | null; onSelect: (h: string | null) => void
}) {
  const qc = useQueryClient()
  const [sortKey, setSortKey] = useState<SortKey>('auto')
  const [reviewer, setReviewer] = useState(reviewerName())
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  const [orderJust, setOrderJust] = useState<Record<string, string>>({})
  const [orderError, setOrderError] = useState<string | null>(null)
  const dragFrom = useRef<string | null>(null)

  const live = useMemo(() => res.rows.filter((r) => !r.filtered), [res.rows])
  const byHash = useMemo(() => new Map(live.map((r) => [r.hash, r])), [live])
  const rrows = review?.rows ?? {}

  const ordered = useMemo(() => {
    if (pendingOrder) return pendingOrder.map((h) => byHash.get(h)!).filter(Boolean)
    const rows = [...live]
    const val = (r: LeaderboardRow): number => {
      switch (sortKey) {
        case 'user': return rrows[r.hash]?.user_rank ?? r.auto_rank ?? 999
        case 'auc_oot': return -(r.auc_oot ?? r.auc_in)
        case 'max_p': return r.max_p ?? 1
        case 'peak': return -(r.stress?.peak_stressed_pd ?? 0)
        case 'rmse': return r.full?.errors_oot?.rmse_pp ?? 999
        default: return r.auto_rank ?? 999
      }
    }
    rows.sort((a, b) => val(a) - val(b))
    return rows
  }, [live, sortKey, rrows, pendingOrder, byHash])

  const saveOrder = useMutation({
    mutationFn: () => api.selectionReviewOrder(pk, res.config_hash, {
      reviewer, order: pendingOrder!, justifications: orderJust }),
    onSuccess: (r) => {
      qc.setQueryData(['selreview', pk, res.config_hash], r)
      setPendingOrder(null); setOrderJust({}); setOrderError(null)
      setSortKey('user')
    },
    onError: (e) => setOrderError(String((e as Error).message)),
  })

  const needsJust = (pendingOrder ?? [])
    .map((h, i) => ({ h, rank: i + 1 }))
    .filter(({ h, rank }) => {
      const auto = byHash.get(h)?.auto_rank
      return auto != null && rank !== auto
        && !(orderJust[h] ?? rrows[h]?.justification ?? '').trim()
    })

  const detail = selected ? byHash.get(selected) ?? null : null

  return (
    <div className={`grid gap-3 ${detail ? 'xl:grid-cols-[minmax(0,1fr)_440px]' : ''}`}>
      <Card>
        <CardHead title="Leaderboard"
          subtitle={`${num(live.length)} models from ${num(res.n_combos)} fitted combinations`}
          caption="Two rankings, kept side by side: the automated rank from the stated composite, and yours. Drag a row (or use the arrows) to set the user rank; moving a model away from its automated rank requires a justification, which the audit trail records."
          methodology="selection-composite"
          right={
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-tiny text-ink-muted">
                Sort
                <select value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="rounded-ctl border border-hairline bg-surface px-1.5 py-0.5 text-tiny">
                  <option value="auto">Automated rank</option>
                  <option value="user">User rank</option>
                  <option value="auc_oot">AUC out of time</option>
                  <option value="max_p">Worst p-value</option>
                  <option value="peak">Peak stressed PD</option>
                  <option value="rmse">Backtest RMSE</option>
                </select>
              </label>
              <a href={api.selectionReviewExportUrl(pk, res.config_hash)}
                 className="rounded-ctl border border-hairline px-2 py-0.5 text-tiny text-ink-secondary hover:text-ink"
                 title="The review audit trail as CSV, for the validation binder.">
                Export audit CSV
              </a>
            </div>
          } />
        {res.n_filtered > 0 && (
          <p className="px-4 pb-1 text-micro text-ink-muted">
            {num(res.n_filtered)} models were removed by the filter rules and
            are not shown.
          </p>
        )}
        {(res.screened_out?.length ?? 0) > 0 && (
          <p className="px-4 pb-1 text-micro text-ink-muted"
             title={res.screened_out.map((o) =>
               `${o.label} (${o.core} core): ${o.reason}`).join('\n')}>
            {num(res.screened_out.length)} shortlisted term
            {res.screened_out.length === 1 ? ' was' : 's were'} screened out
            beside a core. Hover for each reason.
          </p>
        )}
        <div className="thin-scroll max-h-[620px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 border-y border-hairline bg-surface text-tiny text-ink-muted">
              <tr>
                <th className="px-2 py-2 text-right font-medium" title="The composite rank. Never changed by review.">Auto</th>
                <th className="px-2 py-2 text-right font-medium" title="Your rank. Drag rows or use the arrows.">User</th>
                <th className="px-2 py-2 font-medium">Model</th>
                <th className="px-2 py-2 font-medium">Macro terms</th>
                <th className="px-2 py-2 text-right font-medium" title="Core plus macro terms.">Terms</th>
                <th className="px-2 py-2 text-right font-medium">AUC in</th>
                <th className="px-2 py-2 text-right font-medium" title="On months after the out-of-time boundary, which the search never fitted on.">AUC OOT</th>
                <th className="px-2 py-2 text-right font-medium" title="The least significant coefficient outside the age baseline.">Max p</th>
                <th className="px-2 py-2 text-right font-medium" title="Worst term-level generalised VIF.">VIF</th>
                <th className="px-2 py-2 text-center font-medium" title="Whether a core coefficient flipped sign or shifted materially when the macro terms joined.">Shift</th>
                <th className="px-2 py-2 text-center font-medium" title="Peak PD ordered baseline then severe, and the severe peak, from the fitted macro response.">Stress</th>
                <th className="px-2 py-2 text-right font-medium" title="Backtest error on the annualised default rate, out of time, percentage points. Finalists only; promote a model to compute it.">RMSE</th>
                <th className="px-2 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {ordered.slice(0, 150).map((r, idx) => {
                const rv = rrows[r.hash] ?? {}
                const active = r.hash === selected
                const userRank = pendingOrder ? idx + 1 : rv.user_rank
                return (
                  <tr key={r.hash} draggable
                      onDragStart={() => { dragFrom.current = r.hash }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        const from = dragFrom.current
                        if (!from || from === r.hash) return
                        const base = pendingOrder ?? ordered.map((x) => x.hash)
                        const next = base.filter((h) => h !== from)
                        next.splice(next.indexOf(r.hash) < 0 ? idx
                          : next.indexOf(r.hash), 0, from)
                        setPendingOrder(next)
                      }}
                      onClick={() => onSelect(active ? null : r.hash)}
                      className={`cursor-pointer border-b border-hairline ${
                        active ? 'bg-accent-soft' : 'hover:bg-sunken/60'} ${
                        rv.status === 'rejected' ? 'opacity-50' : ''}`}>
                    <td className="px-2 py-1.5 text-right tnum text-ink-muted">{r.auto_rank}</td>
                    <td className="px-2 py-1.5 text-right">
                      <span className="tnum text-ink">{userRank ?? '—'}</span>
                      <span className="ml-1 inline-flex flex-col align-middle"
                            onClick={(e) => e.stopPropagation()}>
                        <button title="Move up" className="text-micro leading-none text-ink-muted hover:text-ink"
                          onClick={() => {
                            const base = pendingOrder ?? ordered.map((x) => x.hash)
                            const i = base.indexOf(r.hash)
                            if (i > 0) {
                              const next = [...base]
                              ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                              setPendingOrder(next)
                            }
                          }}>▲</button>
                        <button title="Move down" className="text-micro leading-none text-ink-muted hover:text-ink"
                          onClick={() => {
                            const base = pendingOrder ?? ordered.map((x) => x.hash)
                            const i = base.indexOf(r.hash)
                            if (i >= 0 && i < base.length - 1) {
                              const next = [...base]
                              ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
                              setPendingOrder(next)
                            }
                          }}>▼</button>
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="font-medium text-ink">{r.name}</span>
                      <span className="ml-1.5 text-micro text-ink-muted">
                        {r.lineage.map((l) => l.core).join(', ')} core
                        {r.finalist ? '' : ' · lean'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      {r.mevs.map((m) => {
                        const sc = r.sign_checks.find((s) => s.term === `mev:${m.label}`)
                        return (
                          <span key={m.label} className="mr-1.5 whitespace-nowrap font-mono text-micro text-ink-secondary">
                            {m.label}
                            {sc?.ok === false && (
                              <span title="The fitted sign contradicts the economic prior."
                                    style={{ color: 'var(--status-critical)' }}> ✗</span>)}
                            {sc?.ok === true && (
                              <span title="The fitted sign agrees with the economic prior."
                                    style={{ color: 'var(--status-good)' }}> ✓</span>)}
                          </span>
                        )
                      })}
                    </td>
                    <td className="px-2 py-1.5 text-right tnum text-ink-secondary">{r.n_predictors}</td>
                    <td className="px-2 py-1.5 text-right tnum">{r.auc_in.toFixed(3)}</td>
                    <td className="px-2 py-1.5 text-right tnum text-ink">
                      {r.auc_oot == null ? '—' : r.auc_oot.toFixed(3)}
                    </td>
                    <td className="px-2 py-1.5 text-right tnum"
                        style={{ color: r.all_significant ? undefined : 'var(--status-warning)' }}>
                      {fmtP(r.max_p)}
                    </td>
                    <td className="px-2 py-1.5 text-right tnum"
                        title={r.max_vif != null && r.max_vif > 5
                          ? 'The worst term-level VIF exceeds 5: two terms carry much of the same information. Open the model to see which.'
                          : undefined}
                        style={{ color: r.max_vif != null && r.max_vif > 5
                          ? 'var(--status-warning)' : undefined }}>
                      {r.max_vif == null ? '—' : r.max_vif.toFixed(1)}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {r.core_shifted
                        ? <span title={r.core_shifts.map((s) =>
                            `${s.column}: ${s.before.toFixed(3)} to ${s.after.toFixed(3)}${
                              s.flipped ? ' (sign flip)' : ''}`).join('; ')}
                            style={{ color: 'var(--status-warning)' }}>●</span>
                        : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {r.stress?.usable
                        ? <span title={`Peak stressed PD ${pct(r.stress.peak_stressed_pd, 2)} monthly against an anchor of ${pct(r.stress.anchor_pd, 2)}.`}
                                style={{ color: r.stress.monotone ? 'var(--status-good)'
                                                                  : 'var(--status-critical)' }}>
                            {r.stress.monotone ? 'Y' : 'N'}
                            <span className="ml-1 tnum text-micro text-ink-muted">
                              {pct(r.stress.peak_stressed_pd, 1)}
                            </span>
                          </span>
                        : <span className="text-ink-muted" title="No usable scenario path for this macro set.">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tnum text-ink-secondary">
                      {r.full?.errors_oot?.rmse_pp == null ? '—'
                        : r.full.errors_oot.rmse_pp.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5">
                      {rv.status
                        ? <span className={`rounded-full border px-1.5 py-0.5 text-micro ${
                            rv.status === 'champion' ? 'border-accent text-ink' : 'border-hairline text-ink-muted'}`}>
                            {rv.status}
                          </span>
                        : <span className="text-micro text-ink-muted">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {ordered.length > 150 && (
            <p className="px-3 py-2 text-micro text-ink-muted">
              Showing the top 150 of {num(ordered.length)} by the current sort.
              Every model is still in the results and the export.
            </p>
          )}
        </div>

        {pendingOrder && (
          <div className="border-t border-hairline bg-sunken/50 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-tiny font-medium text-ink">Unsaved ranking</span>
              <input value={reviewer}
                onChange={(e) => { setReviewer(e.target.value); rememberReviewer(e.target.value) }}
                placeholder="Reviewer name"
                className="w-36 rounded-ctl border border-hairline bg-surface px-2 py-1 text-tiny" />
              <button onClick={() => saveOrder.mutate()}
                disabled={!reviewer || needsJust.length > 0}
                className="rounded-ctl bg-accent px-3 py-1 text-tiny font-semibold text-white disabled:opacity-40">
                Save order
              </button>
              <button onClick={() => { setPendingOrder(null); setOrderJust({}); setOrderError(null) }}
                className="rounded-ctl border border-hairline px-2.5 py-1 text-tiny text-ink-secondary">
                Discard
              </button>
              {orderError && (
                <span className="text-tiny" style={{ color: 'var(--status-critical)' }}>{orderError}</span>
              )}
            </div>
            {needsJust.length > 0 && (
              <div className="mt-2 space-y-1.5">
                <p className="text-micro text-ink-muted">
                  These models moved away from their automated rank, so each
                  needs a justification before the order can be saved:
                </p>
                {needsJust.map(({ h, rank }) => (
                  <div key={h} className="flex items-center gap-2">
                    <span className="w-52 shrink-0 truncate font-mono text-micro text-ink-secondary">
                      {byHash.get(h)?.name} (auto {byHash.get(h)?.auto_rank}, now {rank})
                    </span>
                    <input value={orderJust[h] ?? ''}
                      onChange={(e) => setOrderJust({ ...orderJust, [h]: e.target.value })}
                      placeholder="Why this model moved"
                      className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-tiny" />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {detail && (
        <DetailPane pk={pk} row={detail} res={res}
                    review={rrows[detail.hash] ?? {}}
                    reviewer={reviewer} setReviewer={setReviewer}
                    onClose={() => onSelect(null)} />
      )}
    </div>
  )
}

// ── drill-in ────────────────────────────────────────────────────────────────
function DetailPane({ pk, row, res, review, reviewer, setReviewer, onClose }: {
  pk: PortfolioKey; row: LeaderboardRow; res: SelectionResults
  review: { status?: string | null; reason_code?: string | null
            justification?: string | null; user_rank?: number | null }
  reviewer: string; setReviewer: (s: string) => void; onClose: () => void
}) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const stashDraft = useUi((s) => s.stashDraft)
  const setPdSpec = useUi((s) => s.setPdSpec)

  const [status, setStatus] = useState(review.status ?? '')
  const [reason, setReason] = useState(review.reason_code ?? '')
  const [just, setJust] = useState(review.justification ?? '')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setStatus(review.status ?? ''); setReason(review.reason_code ?? '')
    setJust(review.justification ?? ''); setErr(null)
  }, [row.hash])

  const save = useMutation({
    mutationFn: () => api.selectionReviewRow(pk, res.config_hash, row.hash, {
      reviewer,
      status: status || null,
      reason_code: reason || null,
      justification: just || null,
    }),
    onSuccess: (r) => { qc.setQueryData(['selreview', pk, res.config_hash], r); setErr(null) },
    onError: (e) => setErr(String((e as Error).message)),
  })

  const openAsDraft = () => {
    const spec = row.spec as Record<string, any>
    // The row's spec, reshaped to the request form the workbench restores
    // from. This is a DRAFT, deliberately not a loaded version: setPdSpec is
    // the unguarded door restores use, and the current draft is stashed first
    // so nothing is lost.
    const req = {
      variables: spec.variables, mevs: spec.mevs, estimator: spec.estimator,
      oot_from: spec.sample?.oot_from, seasoning_spline: spec.seasoning_spline,
      downsample_rows: spec.sample?.downsample_rows ?? null,
    }
    stashDraft(pk)
    setPdSpec(pk, fromRequest(req, pk))
    nav(`/${pk}/pd`)
  }

  return (
    <Card className="self-start">
      <CardHead title={row.name}
        subtitle={`Model ${row.hash} · ${row.lineage.map((l) => l.core).join(', ')} core`}
        right={<button onClick={onClose}
          className="text-tiny text-ink-muted hover:text-ink">Close</button>} />
      <div className="space-y-4 px-4 pb-4">
        {row.core_warnings.length > 0 && (
          <Notice severity="warning" label="Cyclical driver in the core">
            {row.core_warnings[0]}
          </Notice>
        )}
        {row.separation_warning && (
          <Notice severity="critical" label="Fit warning">{row.separation_warning}</Notice>
        )}

        <div>
          <h4 className="mb-1 text-tiny font-medium text-ink-muted">Coefficients</h4>
          <table className="w-full text-left text-tiny">
            <thead className="text-micro text-ink-muted">
              <tr><th className="py-1 pr-2 font-medium">Term</th>
                  <th className="py-1 pr-2 text-right font-medium">Estimate</th>
                  <th className="py-1 pr-2 text-right font-medium">p</th>
                  <th className="py-1 text-right font-medium">VIF</th></tr>
            </thead>
            <tbody>
              {row.coefficients.filter((c) => c.name !== 'intercept'
                  && c.term !== 'seasoning').map((c) => (
                <tr key={c.name} className="border-t border-hairline">
                  <td className="py-1 pr-2 font-mono text-micro text-ink-secondary">{c.name}</td>
                  <td className="py-1 pr-2 text-right tnum">{c.estimate.toFixed(4)}</td>
                  <td className="py-1 pr-2 text-right tnum"
                      style={{ color: c.p_value >= 0.05 ? 'var(--status-warning)' : undefined }}>
                    {fmtP(c.p_value)}
                  </td>
                  <td className="py-1 text-right tnum text-ink-muted">
                    {c.term_vif == null ? '—' : c.term_vif.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {row.core_shifts.length > 0 && (
          <div>
            <h4 className="mb-1 text-tiny font-medium text-ink-muted">
              Core coefficients moved when the macro terms joined
            </h4>
            {row.core_shifts.map((s) => (
              <p key={s.column} className="font-mono text-micro text-ink-secondary">
                {s.column}: {s.before.toFixed(3)} to {s.after.toFixed(3)}
                {s.flipped
                  ? <span style={{ color: 'var(--status-critical)' }}> sign flip</span>
                  : ` (${s.shift_pct.toFixed(0)}% shift)`}
              </p>
            ))}
          </div>
        )}

        {row.stress?.usable && row.stress.peak_pd && (
          <div>
            <h4 className="mb-1 text-tiny font-medium text-ink-muted">Stress behaviour</h4>
            <p className="text-tiny text-ink-secondary">
              Anchor {pct(row.stress.anchor_pd, 2)} monthly;{' '}
              {res.scenarios.map((s) => `${s.replace('_', ' ')} peak ${
                pct(row.stress!.peak_pd![s], 2)}`).join(', ')}.
              {' '}{row.stress.monotone
                ? 'The response orders correctly by scenario severity.'
                : 'The response does not order by scenario severity.'}
            </p>
          </div>
        )}

        {row.finalist && row.full && (
          <div>
            <h4 className="mb-1 text-tiny font-medium text-ink-muted">Full backtest</h4>
            <p className="text-tiny text-ink-secondary">
              Out of time: AUC {row.full.auc_oot?.toFixed(3) ?? '—'},
              RMSE {row.full.errors_oot?.rmse_pp?.toFixed(2) ?? '—'} pp,
              bias {row.full.errors_oot?.bias_pp?.toFixed(2) ?? '—'} pp.
              Top decile captures {row.full.top_decile_capture_pct?.toFixed(0) ?? '—'}%
              of defaults ({row.full.top_decile_lift?.toFixed(1) ?? '—'}x lift).
            </p>
          </div>
        )}
        {!row.finalist && (
          <p className="text-micro text-ink-muted">
            Lean statistics only. Open this model as a draft and fit it to get
            the full backtest and error decomposition.
          </p>
        )}

        <div className="flex gap-2">
          <button onClick={openAsDraft}
            className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
            Open as draft in the PD workbench
          </button>
        </div>

        <div className="border-t border-hairline pt-3">
          <h4 className="mb-2 text-tiny font-medium text-ink-muted">Review</h4>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs">
                <option value="">Not set</option>
                <option value="champion">Champion</option>
                <option value="challenger">Challenger</option>
                <option value="rejected">Rejected</option>
              </select>
            </Field>
            <Field label="Reason code">
              <select value={reason} onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs">
                <option value="">None</option>
                {Object.entries(REASON_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Justification"
                 hint="Required to reject a model or rank it away from the automated order. Exported with the audit trail.">
            <textarea value={just} onChange={(e) => setJust(e.target.value)}
              rows={2}
              className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1 text-xs" />
          </Field>
          <div className="mt-2 flex items-center gap-2">
            <input value={reviewer}
              onChange={(e) => { setReviewer(e.target.value); rememberReviewer(e.target.value) }}
              placeholder="Reviewer name"
              className="w-36 rounded-ctl border border-hairline bg-surface px-2 py-1 text-tiny" />
            <button onClick={() => save.mutate()} disabled={!reviewer}
              className="rounded-ctl border border-hairline px-3 py-1 text-tiny text-ink-secondary hover:text-ink disabled:opacity-40">
              Save review
            </button>
          </div>
          {err && (
            <p className="mt-1 text-tiny" style={{ color: 'var(--status-critical)' }}>{err}</p>
          )}
        </div>
      </div>
    </Card>
  )
}
