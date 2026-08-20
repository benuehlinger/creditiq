/** API client. One origin — Vite proxies /api to the backend — so there is no
 *  CORS step on a machine that has never run this before. */

const base = '/api'

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const q = params
    ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : ''
  const r = await fetch(`${base}${path}${q}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`)
  return r.json() as Promise<T>
}

export type PortfolioKey = 'consumer' | 'mortgage' | 'cre'

export interface PortfolioInfo {
  key: PortfolioKey
  label: string
  accent_slot: number
  n_accounts: number
  n_rows: number
  n_defaults: number
  annual_default_rate_pct: number
  window: [string, string]
  target: { column: string; label: string; description: string }
  ead_method: 'amortizing' | 'ccf'
  ead_note: string
  mev_keys: string[]
  drivers: string[]
  categorical_drivers: string[]
  expected_signs: Record<string, number>
}

export interface IntegrityIssue {
  check: string
  severity: 'critical' | 'serious' | 'warning' | 'good'
  passed: boolean
  detail: string
  n_affected: number
}

export interface ColumnProfile {
  name: string
  dtype: string
  role: 'identifier' | 'date' | 'target' | 'driver' | 'candidate' | 'outcome' | 'other'
  unit: 'identifier' | 'currency' | 'percent' | 'count' | 'score' | 'decimal_rate' | 'number'
  missing_pct: number
  n_unique: number
  is_constant: boolean
  mean?: number; std?: number; min?: number; max?: number
  p01?: number; p25?: number; p50?: number; p75?: number; p99?: number
  n_outliers?: number
  top_levels?: { level: string; count: number; pct: number }[]
  note?: string | null
}

export interface DataHealth {
  portfolio: string
  n_rows: number
  n_accounts: number
  n_columns: number
  score: number
  issues: IntegrityIssue[]
  columns: ColumnProfile[]
}

export interface TimeseriesPoint {
  performance_date: string
  series?: string
  observations: number
  defaults: number
  balance: number
  annual_default_rate_pct: number
}

export interface MevVariable {
  key: string; label: string; series_id: string; resolved_series_id: string
  native: string; kind: string; measure: string; agg: string; unit: string
  group: 'domestic' | 'international'; rebase: boolean; note: string | null
  substituted: boolean; first: string | null; last: string | null; status: string
}

export interface ScenarioInfo {
  key: string; label: string; published: boolean; source: string
  note: string; horizon_quarters: number; variables: string[]
  start: string; end: string
}

export interface SplicedSeries {
  splice_date: string
  rule: 'ratio' | 'none'
  shift: number
  last_actual: number
  scenario_raw_first: number
  points: { date: string; value: number; projected: boolean }[]
}


// ── explore ──────────────────────────────────────────────────────────────────
export interface ScreenRow {
  column: string
  kind: 'numeric' | 'categorical'
  iv: number
  iv_band: string
  iv_null_floor: number
  above_null: boolean
  max_bin_lift: number
  leakage_risk: 'none' | 'review' | 'likely'
  leakage_reason: string
  monotone: boolean
  monotone_direction: string
  missing_pct: number
  n_unique: number
  expected_sign: number | null
  observed_sign: number | null
  sign_ok: boolean | null
  warnings: string[]
  error?: string
}

export interface BinRow {
  index: number
  label: string
  lo: number | null
  hi: number | null
  levels: string[] | null
  count: number
  events: number
  non_events: number
  event_rate: number
  woe: number
  iv_contribution: number
  pct_of_total: number
  is_special: boolean
}

export interface BinningResult {
  column: string
  kind: 'numeric' | 'categorical'
  iv: number
  edges: number[] | null
  groups: string[][] | null
  monotone: boolean
  monotone_direction: string
  n_total: number
  n_events: number
  warnings: string[]
  bins: BinRow[]
  sampled: boolean
  max_bin_lift: number
  max_lift_bin: string
  leakage_risk: 'none' | 'review' | 'likely'
  leakage_reason: string
  expected_sign: number | null
  observed_sign: number | null
  domain: [number, number] | null
  histogram: { bounds: number[]; counts: number[] } | null
}

export interface CorrelationResult {
  columns: string[]
  matrix: number[][]
  method: string
  high_pairs: { a: string; b: string; corr: number }[]
  clusters: { cluster: number; members: string[]; recommended: string }[]
}


export interface Coefficient {
  name: string; estimate: number; std_error: number; z_stat: number
  p_value: number; vif: number; contribution: number
}

export interface Cohort {
  period: string; n: number; events: number
  actual: number; predicted: number
  actual_annual: number; predicted_annual: number
  actual_lo_annual: number; actual_hi_annual: number
  calibrated: boolean; auc: number; ks: number; gini: number
}

export interface FitResponse {
  hash: string; name: string; created_at: string; portfolio: string
  spec: Record<string, unknown>
  converged: boolean; iterations: number; separation_warning: string | null
  n_train: number; n_events_train: number
  slices: Record<string, number>; n_full: number; downsampled: boolean
  timings: Record<string, number>
  coefficients: Coefficient[]
  diagnostics: {
    train?: SliceMetrics; test?: SliceMetrics; oot?: SliceMetrics
    roc: { fpr: number; tpr: number }[]
    ks_curve: { score: number; cum_bad: number; cum_good: number; sep: number }[]
    calibration: {
      bins: { bin: number; n: number; predicted: number; observed: number
              predicted_annual: number; observed_annual: number; events: number }[]
      hl_statistic: number; hl_p_value: number; hl_dof: number; hl_note: string
    }
    gains: { decile: number; n: number; events: number; event_rate_annual: number
             mean_predicted: number; capture_pct: number
             cumulative_capture_pct: number; lift: number }[]
    mcfadden_r2: number; reference_slice: string
  }
  backtest: {
    cohorts: Cohort[]
    rank_order: { deciles: number; periods: number; breaks: number
                  share_monotone: number
                  rows: { period: string; monotone: boolean; rates_annual: (number|null)[] }[] }
    score_psi: { period: string; psi: number; n: number }[]
    vintages: { vintage: number; points: { mob: number; cumulative_default_pct: number; n: number }[] }[]
    oot_from: string
    segment_column: string | null
    segments: { segment: string; n: number; events: number; auc: number
                auc_delta: number; actual_annual: number; predicted_annual: number
                calibrated: boolean; bias_pct: number }[]
  }
  scorecard: { base_score: number; base_odds: number; pdo: number
               factor: number; offset: number
               points: { variable: string; bin: string; woe: number; points: number }[] }
  target: { column: string; label: string; description: string }
  ead: { method: string; note: string }
  expected_signs: Record<string, number>
  sign_checks: { term: string; mev: string; expected_sign: number
                 observed_sign: number; coefficient: number; z_stat: number
                 ok: boolean; significant: boolean; message: string }[]
  woe_maps: Record<string, { kind: string; edges?: number[]; woe?: number[]
                             labels?: string[]; iv: number; missing_woe: number }>
  performance_note: string
}

export interface SliceMetrics {
  n: number; events: number; auc: number; gini: number; ks: number
  ks_at_score: number; brier: number; log_loss: number
  actual_annual: number; predicted_annual: number
}

export interface FitRequest {
  portfolio: string
  variables: { column: string; transform?: string; edges?: number[] | null }[]
  mevs: { key: string; transform?: string; lag_months?: number }[]
  estimator?: string
  regularization?: number
  seasoning_spline?: boolean
  vintage_effect?: boolean
  test_fraction?: number
  oot_from?: string
  downsample_rows?: number | null
  label?: string | null
  parent_hash?: string | null
}

export interface EclScenario {
  key: string; label: string; published: boolean; source: string; note: string
  n_accounts: number; exposure: number; ecl: number; ecl_bps: number
  weighted_pd_12m: number; weighted_lgd: number
  monthly: { month: string; marginal_pd: number; survival: number; lgd: number
             exposure: number; loss: number; cumulative_loss: number }[]
  by_segment: { segment: string; n: number; exposure: number; ecl: number; ecl_bps: number }[]
  ifrs9: { trigger: string; total_ecl: number
           stages: { stage: number; n: number; exposure: number; ecl: number; basis: string }[] }
  uncapped_ecl: number | null
}

export interface EclResponse {
  portfolio: string; model_hash: string; as_of: string
  horizon_months: number; timings: Record<string, number>; capped: boolean
  scenarios: EclScenario[]
  weights: Record<string, number>; weighted_ecl: number
  bridge: { label: string; value: number; running: number; kind: string; note: string }[]
  bridge_reconciles: { ok: boolean; residual: number }
  shapley: Record<string, number>
  extrapolation: { key: string; fitted_min: number; fitted_max: number
                   scenario_min: number; scenario_max: number; beyond_sd: number
                   outside: boolean; note: string }[]
  ead: { method: string; plain_english: string; parameters: Record<string, unknown>
         estimated_ccf: number | null; ccf_sample: number; ccf_note: string }
  lgd: { n_defaults: number; mean_lgd: number; zero_loss_share: number
         mean_severity_given_loss: number; mean_workout_months: number
         calibration: { cohort: number; n: number; predicted: number
                        actual: number; zero_loss_share: number }[]
         note: string; drivers: string[] }
}

export interface EclRequest extends FitRequest {
  scenarios?: string[]
  weights?: Record<string, number>
  custom?: Record<string, Record<string, number>>
  fixed_ccf?: number | null
  cpr?: number
  cap_to_fitted_range?: boolean
}

export interface VersionRecord {
  hash: string; name: string; portfolio: string; created_at: string
  spec: Record<string, any>; metrics: Record<string, any>; ecl: Record<string, any>
  status: 'champion' | 'challenger' | 'archived'
  starred: boolean; tags: string[]; notes: string
  parent_hash: string | null; author: string
}

export interface CompareResult {
  versions: VersionRecord[]
  metrics: { key: string; label: string; better: 'up' | 'down'; values: (number | null)[] }[]
  variables: {
    all: string[]; shared: string[]
    per_version: Record<string, string[]>
    added: Record<string, string[]>; missing: Record<string, string[]>
  }
  coefficients: { variable: string; values: (number | null)[]; sign_flip: boolean }[]
}

export interface RollUpResponse {
  scenarios: string[]
  portfolios: {
    portfolio: PortfolioKey; label: string; accent_slot: number
    model_name: string; model_hash: string; from_champion: boolean
    ead_method: string; ead_ccf: number | null
    n_accounts: number; exposure: number
    by_scenario: Record<string, { ecl: number; ecl_bps: number; pd_12m: number; lgd: number }>
    capped: boolean; extrapolation_flags: string[]
  }[]
  totals: Record<string, { ecl: number; exposure: number; ecl_bps: number
                           weighted_pd_12m: number; weighted_lgd: number }>
  monthly: Record<string, any>[]
  tornado: { portfolio: string; mev: string; prior: number; direction: string
             base_ecl: number; shocked_ecl: number; delta_ecl: number; delta_pct: number }[]
  concentration: Record<string, { band: string; exposure: number; share: number }[]>
  champions: Record<string, VersionRecord | null>
  timings: Record<string, number>
  note: string
}

export const api = {
  health: () => get<{ status: string; portfolios: PortfolioKey[]; mev_series_resolved: number
                      mev_series_failed: number; mev_cache_built_at: string }>('/health'),
  portfolios: () => get<PortfolioInfo[]>('/portfolios'),
  dataHealth: (k: string) => get<DataHealth>(`/portfolios/${k}/health`),
  timeseries: (k: string, by?: string) => get<TimeseriesPoint[]>(`/portfolios/${k}/timeseries`, { by }),
  sample: (k: string, limit = 200, offset = 0) =>
    get<{ total: number; columns: string[]; rows: Record<string, unknown>[] }>(
      `/portfolios/${k}/sample`, { limit, offset }),
  mevCatalog: () => get<{ why_restricted: string; built_at: string
                          variables: MevVariable[]; by_portfolio: Record<string, string[]> }>('/mev/catalog'),
  mevSeries: (keys: string[], start?: string, end?: string) =>
    get<{ keys: string[]; rows: Record<string, number | string | null>[] }>(
      '/mev/series', { keys: keys.join(','), start, end }),
  scenarios: () => get<{ warnings: string[]; scenarios: ScenarioInfo[] }>('/scenarios'),
  spliced: (name: string, keys: string[], historyFrom = '2015-01-01') =>
    get<{ scenario: string; published: boolean; series: Record<string, SplicedSeries> }>(
      `/scenarios/${name}/spliced`, { keys: keys.join(','), history_from: historyFrom }),
  screen: (k: string) =>
    get<{
      sampled: boolean; n_rows: number; rows: ScreenRow[]
      floors: Record<string, number>; sample_note: string; null_note: string
      bands: { upto: number | null; label: string }[]
    }>(`/portfolios/${k}/screen`),
  binning: (k: string, col: string, edges?: number[], maxBins = 8) =>
    get<BinningResult>(`/portfolios/${k}/binning/${encodeURIComponent(col)}`, {
      max_bins: maxBins, edges: edges?.length ? edges.join(',') : undefined,
    }),
  bivariate: (k: string, col: string, edges?: number[]) =>
    get<{
      column: string; bins: string[]
      points: { period: string; bin: string; n: number; sum: number; rate: number }[]
    }>(`/portfolios/${k}/bivariate/${encodeURIComponent(col)}`, {
      edges: edges?.length ? edges.join(',') : undefined,
    }),
  psi: (k: string, col: string) =>
    get<{ column: string; points: { period: string; psi: number; n: number }[] }>(
      `/portfolios/${k}/psi/${encodeURIComponent(col)}`),
  correlation: (k: string) => get<CorrelationResult>(`/portfolios/${k}/correlation`),
  vif: (k: string, cols: string[]) =>
    get<{ vif: { column: string; vif: number }[]; skipped: string[] }>(
      `/portfolios/${k}/vif`, { columns: cols.join(',') }),
  fit: async (req: FitRequest): Promise<FitResponse> => {
    const r = await fetch('/api/fit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
    return r.json()
  },
  segmentBacktest: (portfolio: string, hash: string, column: string) =>
    fetch(`/api/segment-backtest?portfolio=${portfolio}&hash_=${hash}&column=${column}`,
          { method: 'POST' }).then((r) => r.json()) as Promise<{
      column: string
      segments: FitResponse['backtest']['segments']
    }>,
  ecl: async (req: EclRequest): Promise<EclResponse> => {
    const r = await fetch('/api/ecl', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
    return r.json()
  },
  editableScenario: (name: string, keys: string[]) =>
    fetch(`/api/scenarios/${name}/editable?keys=${keys.join(',')}`).then((r) => r.json()) as
      Promise<{ scenario: string; published: boolean; note: string
                series: Record<string, { quarter: string; value: number }[]> }>,
  versions: (portfolio?: string) =>
    get<VersionRecord[]>('/versions', { portfolio }),
  saveVersion: async (req: EclRequest & { notes?: string; tags?: string[]; with_ecl?: boolean }) => {
    const r = await fetch('/api/versions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
    return r.json() as Promise<VersionRecord>
  },
  compareVersions: (hashes: string[]) =>
    get<CompareResult>('/versions/compare', { hashes: hashes.join(',') }),
  lineage: (portfolio: string) =>
    get<{ nodes: { hash: string; name: string; status: string; created_at: string
                   starred: boolean; auc: number | null; n_variables: number }[]
          edges: { from: string; to: string }[] }>('/versions/lineage', { portfolio }),
  patchVersion: (hash: string, params: Record<string, string | boolean>) =>
    fetch(`/api/versions/${hash}?` + new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
      { method: 'PATCH' }).then((r) => r.json()) as Promise<VersionRecord>,
  promoteVersion: (hash: string) =>
    fetch(`/api/versions/${hash}/promote`, { method: 'POST' }).then((r) => r.json()) as Promise<VersionRecord>,
  deleteVersion: (hash: string) =>
    fetch(`/api/versions/${hash}`, { method: 'DELETE' }).then((r) => r.json()),
  rollup: () => get<RollUpResponse>('/rollup'),
}
