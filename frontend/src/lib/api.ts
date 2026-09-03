/** API client. One origin — Vite proxies /api to the backend — so there is no
 *  CORS step on a machine that has never run this before. */

const base = '/api'

/** Turn an error body into something a person can read.
 *
 *  FastAPI returns `detail` as a STRING for a raised HTTPException and as a
 *  LIST OF OBJECTS for a validation failure. Reading `.detail` and handing it to
 *  `new Error()` stringified the list, so a request rejected on three fields
 *  surfaced as "Error: [object Object],[object Object],[object Object]" — which
 *  names neither the fields nor the reason. */
export function errorText(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail) && detail.length) {
    return detail.map((e: any) => {
      // `loc` is ['body', 'field', ...]; the leading source is noise here.
      const where = Array.isArray(e?.loc)
        ? e.loc.filter((x: unknown) => x !== 'body').join('.') : ''
      const why = e?.msg ?? 'invalid'
      return where ? `${where}: ${why}` : String(why)
    }).join('; ')
  }
  return fallback
}

/** POST with a hard timeout.
 *
 *  A fetch has no timeout of its own, so a request that stalls — a dev-server
 *  module swap mid-flight, a dropped connection, a backend that never answers —
 *  leaves its promise pending forever, and any mutation waiting on it stays
 *  "in progress" with no way to finish. Every projection and fit goes through
 *  here, so the worst case is an error after `timeoutMs`, never a spinner that
 *  never stops. The caller then shows the error and offers a retry. */
async function post<T>(path: string, body: unknown, timeoutMs = 45_000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(errorText(await r.json().catch(() => null), r.statusText))
    return r.json() as Promise<T>
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s at ${path}. `
        + 'The server did not answer. Try again.')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const q = params
    ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : ''
  const r = await fetch(`${base}${path}${q}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} at ${path}`)
  return r.json() as Promise<T>
}

export const PORTFOLIO_KEYS = ['consumer', 'mortgage', 'cre'] as const
export type PortfolioKey = (typeof PORTFOLIO_KEYS)[number]
export const isPortfolioKey = (k: string | undefined): k is PortfolioKey =>
  !!k && (PORTFOLIO_KEYS as readonly string[]).includes(k)

export interface DataInitStatus {
  ready: boolean
  portfolios_present: string[]
  state: 'idle' | 'running' | 'done' | 'error'
  step: number; total: number; label: string
  elapsed_s: number; eta_s: number | null; error: string
}

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

/** A specification's macro terms as the projection consumes them: one shared
 *  history, then the baseline and severely adverse branches. */
export interface ModelPathSeries {
  term: string; key: string; transform: string; lag_months: number
  label: string; unit: string
  history: { date: string; value: number }[]
  baseline: { date: string; value: number }[]
  severely_adverse: { date: string; value: number }[]
}
export interface ModelPaths { as_of: string; series: ModelPathSeries[] }

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

/** One time cohort. Distinct from `SeverityPoint`, which is a bucket along a
 *  DRIVER rather than a period in time. */
export interface SeverityTimePoint {
  period: string; n: number
  /** Null where the period carried too few resolutions to average. Emitted as a
   *  HOLE rather than omitted, so a time axis breaks the line instead of joining
   *  across a gap where nothing resolved. */
  actual: number | null; lo95: number | null; hi95: number | null
  zero_loss_share: number | null
  too_thin: boolean
  /** Present only on the backtest, where a fitted model supplies a prediction. */
  predicted?: number; calibrated?: boolean; in_sample?: boolean
}

export type SeverityFreq = 'MS' | 'QS' | 'YS'

export interface SeverityOverTime {
  portfolio: string
  freq: SeverityFreq
  period_freq: string
  n_defaults: number; mean: number
  /** Periods dropped for carrying too few resolutions to average. On a thin
   *  book this is most of them, and saying so beats drawing seven points. */
  periods_total: number; periods_kept: number; periods_dropped: number
  min_resolutions: number
  points: SeverityTimePoint[]
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
  /** What the editor asked for and what the data would carry. They differ when
   *  a monotonic trend cannot survive the extra split; the editor says so
   *  rather than leaving the control looking broken. */
  requested_bins?: number | null
  achieved_bins?: number | null
  column_costs: Record<string, number | null>
  supports_continuous: boolean
  n_levels_raw: number
  shrinkage: number
  shape: {
    recommendation: Treatment; confidence: string; reason: string
    linear_r2: number | null; smooth_r2?: number
    monotone: boolean; curvature: number | null
  }
  knots: number[]
  n_knots: number
}

export type Treatment = 'woe' | 'bins' | 'indicator' | 'continuous' | 'spline'

/** A variable is either discretised — in which case it has bins, a weight of
 *  evidence and an information value — or kept on its continuous scale, in which
 *  case it has knots and none of those three applies. */
export const DISCRETISED: Treatment[] = ['woe', 'bins', 'indicator']
export const isDiscretised = (t: Treatment) => DISCRETISED.includes(t) 

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
  /** The term this column belongs to, and that TERM's variance inflation on the
   *  one-column scale. `vif` above is the ordinary per-column figure, which for
   *  one column of a multi-column term says almost nothing: bin indicators from
   *  one variable are mutually exclusive, so they inflate each other before any
   *  other variable is considered. */
  term?: string | null
  term_vif?: number | null
  term_df?: number
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
    /** Error rates on the annualised default rate, in percentage points, split
     *  at the out-of-time boundary. The numbers behind the cohort chart. */
    errors?: { all: BacktestErrors; in_time: BacktestErrors; out_of_time: BacktestErrors }
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
  /** Reference level per dummy-encoded variable — the bin with no indicator
   *  column, which every coefficient of that term is measured against. */
  references?: Record<string, string>
  performance_note: string
}

export interface BacktestErrors {
  n_cohorts: number
  mae_pp?: number; rmse_pp?: number; bias_pp?: number; ratio?: number
  coverage?: number; mean_actual_pp?: number; mean_predicted_pp?: number
  worst_period?: string; worst_miss_pp?: number
}

export interface SliceMetrics {
  n: number; events: number; auc: number; gini: number; ks: number
  ks_at_score: number; brier: number; log_loss: number
  actual_annual: number; predicted_annual: number
}

/** The empirical log-odds curve, at a resolution you can place a knot from. */
export interface CurvePoint {
  x: number; lo: number; hi: number; n: number; events: number
  rate: number; log_odds: number; lo95: number; hi95: number
}

export interface LevelPoint {
  level: string; n: number; events: number; rate: number
  log_odds: number; lo95: number; hi95: number; thin: boolean
}

export interface CurveResult {
  column: string
  kind: 'numeric' | 'categorical'
  sampled: boolean
  missing_rate: number
  n: number; n_events: number; base_log_odds: number
  recommendation: { treatment: string; reason: string }
  note?: string
  // numeric
  domain?: [number, number]
  points: CurvePoint[] | LevelPoint[]
  grid?: number[]
  /** Fitted with the estimator the model uses, on the rows the model uses. */
  linear?: {
    pseudo_r2: number; log_likelihood: number; n_params: number
    bic: number; n_rows: number; n_events: number; fitted: number[]
  }
  spline?: {
    knots: number[]; pseudo_r2: number; log_likelihood: number; n_params: number
    bic: number; delta_bic: number
    lr_statistic: number; lr_df: number; lr_p: number
    fitted: number[]
  } | null
  candidate_knots?: number[]
  reversals?: number
  resolution?: number
  // categorical
  n_levels?: number
}

/** One candidate macro term: a base variable, a transform and a lag. */
export interface MacroCandidate {
  column: string          // key@transform@lag — stable, parseable
  key: string; label: string; unit: string
  transform: string; transform_label: string; lag_months: number
  adf_p: number | null; stationary: boolean | null
  pd_r: number | null; pd_p: number | null; pd_n: number; pd_n_effective: number | null
  lgd_r: number | null; lgd_p: number | null; lgd_n: number; lgd_n_effective: number | null
  expected_sign: number | null
  pd_observed_sign: number | null; pd_sign_ok: boolean | null
  lgd_observed_sign: number | null; lgd_sign_ok: boolean | null
}

export interface MacroLibrary {
  portfolio: string
  window: [string, string]
  n_candidates: number; n_bases: number
  transforms: { key: string; label: string; note: string }[]
  lags: number[]
  adf_alpha: number
  pd_months: number; lgd_defaults: number; lgd_months: number
  rows: MacroCandidate[]
}

export interface MacroSeries {
  column: string; key: string; transform: string; lag_months: number
  points: { month: string; value: number | null; pd: number | null; lgd: number | null }[]
}

export interface FitRequest {
  portfolio: string
  variables: { column: string; treatment?: Treatment; edges?: number[] | null
                knots?: number[] | null; n_knots?: number }[]
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
  /** The severity half. Absent means the PD model is being worked on alone,
   *  which is a legal working state — naming and saving require both. */
  lgd?: LgdSpecPayload | null
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
  alternative_ecl: number | null
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
         note: string; drivers: string[]; spec: LgdSpecPayload & { portfolio: string } }
}

/** The severity half of a Model. Deliberately thinner than the PD spec: LGD is
 *  fitted on defaulted rows only — a few hundred on the commercial book — and a
 *  binning apparatus on 381 observations is false precision. */
/** No weight-of-evidence option: it is defined on a binary outcome and realised
 *  severity has no events to count. */
export type LgdTreatment = 'bins' | 'continuous' | 'spline'

/**
 * Normalise a per-column setting to a real object.
 *
 * `treatments`, `edges` and `knots` are mappings, but they have been on the
 * wire as a LIST OF PAIRS — the server stores them as tuples so it can hash a
 * frozen dataclass, and that detail leaked. The two shapes are
 * indistinguishable to `?? {}`, and spreading the list form into an object
 * literal produces index keys:
 *
 *     {...[["cltv","spline"]], hpi_yoy: "bins"}
 *       -> {"0": ["cltv","spline"], hpi_yoy: "bins"}    // rejected by the API
 *
 * The server now emits objects, but a specification saved in the old shape
 * still exists in browser storage and in version files, so every read
 * normalises. A caller must never spread one of these raw.
 */
export function asMap<T>(v: unknown): Record<string, T> {
  if (!v) return {}
  if (Array.isArray(v)) {
    return Object.fromEntries(
      v.filter((p): p is [string, T] => Array.isArray(p) && p.length === 2))
  }
  // An object that already carries index keys is a spread of the list form —
  // drop those and keep the pairs they hold.
  const out: Record<string, T> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (/^\d+$/.test(k) && Array.isArray(val) && val.length === 2) {
      out[String(val[0])] = val[1] as T
    } else {
      out[k] = val as T
    }
  }
  return out
}

/** Clean a specification for the wire.
 *
 *  Applied at the boundary rather than trusting the caller, because the store
 *  persists to browser storage and can therefore hold a shape written by an
 *  older build. Normalising here means one place is responsible and a stale
 *  browser cannot send a request the API will reject. */
/** Every query that a change to the SAVED VERSIONS invalidates.
 *
 *  The roll-up is the one that keeps being forgotten: it carries the list of
 *  available versions for its model picker, and it is fetched with
 *  `staleTime: Infinity` because projecting three books is expensive. So after
 *  saving or deleting a version its picker offered a set of models that no
 *  longer matched the versions page. Naming the set once means a new mutation
 *  cannot omit one. */
export const VERSION_QUERIES = ['versions', 'lineage', 'rollup', 'compare'] as const

export function wireLgdSpec(spec: LgdSpecPayload): LgdSpecPayload {
  return {
    ...spec,
    treatments: asMap<LgdTreatment>(spec.treatments),
    edges: asMap<number[]>(spec.edges),
    knots: asMap<number[]>(spec.knots),
  }
}

export interface LgdSpecPayload {
  drivers: string[]
  categoricals: string[]
  treatments?: Record<string, LgdTreatment>
  edges?: Record<string, number[]>
  knots?: Record<string, number[]>
  n_knots?: number
  max_bins?: number
}

export interface LgdDiagnostics {
  n: number
  deviance_r2: number; log_likelihood: number; null_log_likelihood: number
  spearman: number | null; spearman_p: number | null
  mae: number; rmse: number
  mean_actual: number; mean_predicted: number
  calibration: { cohort: number; n: number; predicted: number; actual: number
                 actual_lo95: number; actual_hi95: number
                 zero_loss_share: number; total_loss_share: number }[]
  residuals: { predicted: number; residual: number; lo95: number; hi95: number; n: number }[]
  link_test: { coefficient: number | null; z: number | null
               p_value: number | null; ok: boolean | null }
  predicted_range: [number, number]; actual_range: [number, number]
}

export interface LgdBacktest {
  oot_from: string; n_train: number; n_test: number; usable: boolean; note?: string
  train?: { n: number; mean_actual: number; mean_predicted: number; mae: number
            rmse: number; spearman: number | null; deviance_r2: number | null }
  test?: LgdBacktest['train']
  by_year?: { year: number; n: number; actual: number; predicted: number
              in_sample: boolean }[]
  /** Actual against predicted mean severity per time cohort, with the interval
   *  of the realised mean. The yearly table cannot show a turn, or say whether
   *  a gap is a miss or the spread of a thin period. */
  by_period?: SeverityTimePoint[]
  period_freq?: string
  freq?: SeverityFreq
  periods_total?: number; periods_kept?: number; periods_dropped?: number
  min_resolutions?: number
}

export interface SeverityBinning {
  column: string; kind: 'numeric' | 'categorical'
  edges: number[] | null
  n_total: number; book_mean: number; deviance_r2: number
  monotone: boolean; direction: string; warnings: string[]
  bins: { index: number; label: string; lo: number | null; hi: number | null
          levels: string[] | null; n: number; mean: number; se: number
          weight: number; share: number }[]
  domain: [number, number] | null
  histogram: { bounds: number[]; counts: number[] } | null
  /** What the editor asked for and what the data would carry. They differ when
   *  a monotonic trend cannot survive the extra split; the editor says so
   *  rather than leaving the control looking broken. */
  requested_bins?: number | null
  achieved_bins?: number | null
  supports_continuous: boolean
  column_costs: Record<string, number | null>
}

export interface LgdCandidate {
  column: string; filled: number; kind: 'numeric' | 'categorical'
  macro: boolean; caution: boolean; levels?: number
}

export interface LgdCandidates {
  numeric: LgdCandidate[]
  categorical: LgdCandidate[]
  n_defaults: number
  default_spec: LgdSpecPayload & { portfolio: string }
}

export interface LgdFitResult {
  portfolio: string; spec: LgdSpecPayload; hash: string
  /** Derived from the hash, the way the PD fit's name is. */
  name?: string
  n_defaults: number; mean_lgd: number; zero_loss_share: number
  mean_severity_given_loss: number; mean_workout_months: number
  columns: string[]
  diagnostics: LgdDiagnostics
  coefficients: { column: string; coefficient: number; std_error: number | null
                  z: number | null; p_value: number | null }[]
  calibration: { cohort: number; n: number; predicted: number; actual: number
                 zero_loss_share: number }[]
  severity_histogram: { lo: number; hi: number; n: number; zero: boolean }[]
  macro_drivers: string[]; dropped: string[]; note: string
  /** Reference bin per discretised term — what its coefficients are measured
   *  against. */
  references?: Record<string, string>
}

export interface LgdScreenRow {
  column: string; kind: 'numeric' | 'categorical'
  filled: number; macro: boolean; caution: boolean; levels?: number
  spearman: number | null; spread: number; linear_r2: number | null; buckets: number
}

export interface LgdScreen {
  portfolio: string; n_defaults: number; mean_lgd: number; zero_loss_share: number
  rows: LgdScreenRow[]
  default_spec: LgdSpecPayload & { portfolio: string }
}

export interface SeverityPoint {
  x: number; lo: number; hi: number; n: number
  mean_lgd: number; se: number; lo95: number; hi95: number; zero_share: number
}

export interface SeverityLevel {
  level: string; n: number; mean_lgd: number; se: number
  lo95: number; hi95: number; thin: boolean
}

export interface SeverityCurve {
  column: string
  kind: 'numeric' | 'categorical'
  n_defaults: number
  missing_rate: number
  mean_lgd: number
  note?: string
  domain?: [number, number]
  points: SeverityPoint[] | SeverityLevel[]
  grid?: number[]
  linear?: { coefficient: number; intercept: number; pseudo_r2: number; fitted: number[] }
  candidate_knots?: number[]
  /** Fitted with the LGD model's own estimator, on the defaulted rows. */
  candidates?: {
    linear: { deviance_r2: number; log_likelihood: number; n_params: number
              bic: number; dispersion: number; n: number; fitted: number[] }
    spline: {
      knots: number[]; deviance_r2: number; log_likelihood: number
      n_params: number; bic: number; delta_bic: number; dispersion: number
      /** Joint Wald test on the spline columns, with the sandwich covariance.
       *  A quasi-likelihood-ratio statistic is not chi-squared, so there is no
       *  LR test here. */
      wald: number | null; wald_df: number; wald_p: number | null
      fitted: number[]
    } | null
  }
  spearman?: number
  spread: number
  resolution?: number
  n_levels?: number
  distribution?: {
    bins?: { lo: number; hi: number; n: number }[]
    p1?: number; p25?: number; median?: number; p75?: number; p99?: number
    mean?: number; sd?: number; distinct: number
  }
}

export interface LgdDistribution {
  portfolio: string; n_defaults: number
  mean_lgd: number; median_lgd: number
  zero_loss_share: number; total_loss_share: number
  histogram: { lo: number; hi: number; n: number; zero: boolean }[]
}

export interface LgdSensitivity {
  portfolio: string; base: number
  sensitivity: { driver: string; sd: number; base: number; up: number; down: number }[]
}

/** A Model ID covers the PD specification AND the LGD specification, because an
 *  ECL number is the product of both. `complete` false means it cannot be named
 *  yet, and `missing` says which half is absent. */
export interface ModelIdentity {
  hash: string
  complete: boolean
  missing: string[]
  name: string | null
  pd_variables: string[]
  lgd_drivers: string[]
  lgd_categoricals: string[]
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
  parent_hash: string | null; replaced_hash?: string | null; author: string
  /** False when the version was fitted on a panel that no longer exists. A
   *  specification reproduces exactly against different data and returns
   *  different numbers while still calling itself the same model. */
  data_is_current?: boolean
  data_fingerprint?: string
}

export interface CompareResult {
  versions: VersionRecord[]
  metrics: { key: string; label: string; better: 'up' | 'down' | 'zero'; values: (number | null)[] }[]
  variables: {
    all: string[]; shared: string[]
    per_version: Record<string, string[]>
    added: Record<string, string[]>; missing: Record<string, string[]>
  }
  coefficients: { variable: string; values: (number | null)[]; sign_flip: boolean }[]
}

export interface RollUpResponse {
  scenarios: string[]
  is_adopted: boolean
  selection: Record<string, string>
  available: Record<string, {
    hash: string; name: string; status: string; created_at: string
    starred: boolean; auc_test: number | null; n_variables: number | null
    data_is_current: boolean
  }[]>
  portfolios: {
    portfolio: PortfolioKey; label: string; accent_slot: number
    model_name: string; model_hash: string; from_champion: boolean
    version_hash: string | null
    source: 'selected' | 'champion' | 'default'
    champion_hash: string | null; champion_name: string | null
    data_is_current: boolean
    ead_method: string; ead_ccf: number | null
    n_accounts: number; exposure: number
    by_scenario: Record<string, { ecl: number; ecl_bps: number; pd_12m: number; lgd: number }>
  /** The macro terms this book's model carries, canonical `key@transform@lag`. */
  mev_terms?: string[]
    capped: boolean; extrapolation_flags: string[]; sign_flips: string[]
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
  /** Whether the synthetic panels exist, and generation progress if running. */
  dataStatus: () => get<DataInitStatus>('/data/status'),
  dataGenerate: () => post<{ state: string; total?: number }>('/data/generate', {}),
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
  modelPaths: (terms: string[]) =>
    get<ModelPaths>('/scenarios/model-paths', { terms: terms.join(',') }),
  spliced: (name: string, keys: string[], historyFrom = '2008-01-01') =>
    get<{ scenario: string; published: boolean; series: Record<string, SplicedSeries> }>(
      `/scenarios/${name}/spliced`, { keys: keys.join(','), history_from: historyFrom }),
  screen: (k: string) =>
    get<{
      sampled: boolean; n_rows: number; rows: ScreenRow[]
      floors: Record<string, number>; sample_note: string; null_note: string
      bands: { upto: number | null; label: string }[]
    }>(`/portfolios/${k}/screen`),
  binning: (k: string, col: string, edges?: number[], maxBins = 8, nKnots = 4) =>
    get<BinningResult>(`/portfolios/${k}/binning/${encodeURIComponent(col)}`, {
      max_bins: maxBins, n_knots: nKnots,
      // The editor asks for a COUNT, not a ceiling. A ceiling does not respond
      // to a button: a solver that chose four bins under a ceiling of eight
      // does not move when the ceiling drops to seven, six or five, and the
      // control appears inert. Hand-set edges are their own count, so the
      // request is only exact when there are none.
      exact_bins: edges?.length ? undefined : 'true',
      edges: edges?.length ? edges.join(',') : undefined,
    }),
  bivariate: (k: string, col: string, edges?: number[]) =>
    get<{
      column: string; bins: string[]
      points: { period: string; bin: string; n: number; sum: number; rate: number }[]
    }>(`/portfolios/${k}/bivariate/${encodeURIComponent(col)}`, {
      edges: edges?.length ? edges.join(',') : undefined,
    }),
  macroLibrary: (k: string) => get<MacroLibrary>(`/portfolios/${k}/macro/library`),
  macroSeries: (k: string, column: string) =>
    get<MacroSeries>(`/portfolios/${k}/macro/series`, { column }),
  autoKnots: (k: string, col: string, nKnots = 4) =>
    get<{
      knots: number[]; quantile_knots: number[]
      n_buckets: number; n_candidates: number
      gain_over_line: number; gain_over_quantile: number; note: string
    }>(`/portfolios/${k}/knots/${encodeURIComponent(col)}`, { n_knots: nKnots }),
  curve: (k: string, col: string, knots?: number[], resolution = 30) =>
    get<CurveResult>(`/portfolios/${k}/curve/${encodeURIComponent(col)}`, {
      knots: knots?.length ? knots.join(',') : undefined, resolution,
    }),
  psi: (k: string, col: string) =>
    get<{ column: string; points: { period: string; psi: number; n: number }[] }>(
      `/portfolios/${k}/psi/${encodeURIComponent(col)}`),
  correlation: (k: string) => get<CorrelationResult>(`/portfolios/${k}/correlation`),
  /** Variance inflation on the columns the model will actually contain, so it
   *  depends on the treatment. `treatments` is column:treatment pairs. */
  vif: (k: string, cols: string[], treatments: Record<string, string> = {}) =>
    get<{
      vif: { column: string; vif: number; gvif: number; df: number
             aliased: boolean; treatment: string }[]
      seasoning: { term: string; df: number; vif: number } | null
      n_columns: number; skipped: string[]; sampled: boolean
    }>(`/portfolios/${k}/vif`, {
      columns: cols.join(','),
      treatments: cols.map((c) => `${c}:${treatments[c] ?? 'woe'}`).join(','),
    }),
  /** A fit the server still holds, by hash.
   *
   *  The fit RESULT used to live in component state, so walking to Explore and
   *  back threw away the coefficients, the diagnostics and the backtest and the
   *  stage went back to asking to be fitted. The server already caches a run
   *  under its hash, so the result is fetched rather than recomputed. A miss is
   *  a 404 and means the cache was evicted: the stage then asks for a refit,
   *  which is honest, rather than showing a model it cannot produce. */
  model: (hash: string) => get<FitResponse>(`/models/${hash}`),
  /** The friendly name for any hash, for a half restored from a record that
   *  stored the hash only. */
  nameFor: (hash: string) => get<{ hash: string; name: string }>(`/name/${hash}`),
  fit: (req: FitRequest): Promise<FitResponse> => post('/fit', req),
  /** Report an already-fitted model's backtest at another frequency. No refit —
   *  the scored account-months are held on the cached run. */
  recohort: (req: FitRequest, freq: 'MS' | 'QS' | 'YS') =>
    post<Pick<FitResponse['backtest'], 'cohorts' | 'rank_order' | 'score_psi'>
      & { period_freq: string }>('/backtest/recohort', { ...req, freq }),
  segmentBacktest: (portfolio: string, hash: string, column: string) =>
    fetch(`/api/segment-backtest?portfolio=${portfolio}&hash_=${hash}&column=${column}`,
          { method: 'POST' }).then((r) => r.json()) as Promise<{
      column: string
      segments: FitResponse['backtest']['segments']
    }>,
  ecl: (req: EclRequest): Promise<EclResponse> => post('/ecl', req),
  editableScenario: (name: string, keys: string[]) =>
    fetch(`/api/scenarios/${name}/editable?keys=${keys.join(',')}`).then((r) => r.json()) as
      Promise<{ scenario: string; published: boolean; note: string
                series: Record<string, { quarter: string; value: number }[]> }>,
  versions: (portfolio?: string) =>
    get<VersionRecord[]>('/versions', { portfolio }),
  saveVersion: async (req: EclRequest & { notes?: string; tags?: string[]
                                          with_ecl?: boolean; replaces?: string | null }) => {
    const r = await fetch('/api/versions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!r.ok) throw new Error(errorText(await r.json().catch(() => null), r.statusText))
    return r.json() as Promise<VersionRecord>
  },
  version: (hash: string) => get<VersionRecord>(`/versions/${hash}`),
  lgdScreen: (k: string, extra: string[] = []) =>
    get<LgdScreen>(`/portfolios/${k}/lgd/screen`, { extra: extra.join(',') }),
  lgdCurve: (k: string, col: string, resolution = 12, knots?: number[]) =>
    get<SeverityCurve>(`/portfolios/${k}/lgd/curve/${encodeURIComponent(col)}`, {
      resolution, knots: knots?.length ? knots.join(',') : undefined,
    }),
  lgdAutoKnots: (k: string, col: string, nKnots = 3) =>
    get<{ knots: number[]; quantile_knots: number[]; n_defaults: number
          n_buckets: number; gain_over_quantile: number; note: string }>(
      `/portfolios/${k}/lgd/knots/${encodeURIComponent(col)}`, { n_knots: nKnots }),
  lgdDistribution: (k: string) => get<LgdDistribution>(`/portfolios/${k}/lgd/distribution`),
  lgdCandidates: (k: string) => get<LgdCandidates>(`/portfolios/${k}/lgd/candidates`),
  lgdFit: (portfolio: string, spec: LgdSpecPayload): Promise<LgdFitResult> =>
    post('/lgd/fit', { portfolio, ...wireLgdSpec(spec) }),
  lgdBacktest: async (portfolio: string, spec: LgdSpecPayload,
                      ootFrom = '2022-01-01',
                      freq: SeverityFreq = 'MS'): Promise<LgdBacktest> => {
    const r = await fetch('/api/lgd/backtest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ portfolio, ...wireLgdSpec(spec), oot_from: ootFrom, freq }),
    })
    if (!r.ok) throw new Error(errorText(await r.json().catch(() => null), r.statusText))
    return r.json()
  },
  /** The dependent variable through time: mean realised severity per cohort. */
  lgdSeverityOverTime: (k: string, freq: SeverityFreq = 'MS') =>
    get<SeverityOverTime>(`/portfolios/${k}/lgd/severity-over-time`, { freq }),
  lgdBinning: (k: string, col: string, maxBins = 5, edges?: number[]) =>
    get<SeverityBinning>(`/portfolios/${k}/lgd/binning/${encodeURIComponent(col)}`, {
      max_bins: maxBins, edges: edges?.length ? edges.join(',') : undefined,
    }),
  lgdSensitivity: (k: string, spec: LgdSpecPayload) =>
    get<LgdSensitivity>(`/portfolios/${k}/lgd/sensitivity`, {
      drivers: spec.drivers.join(','), categoricals: spec.categoricals.join(','),
    }),
  identity: async (req: FitRequest): Promise<ModelIdentity> => {
    const r = await fetch('/api/model/identity', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
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
  rollup: (selection: Record<string, string> = {}) =>
    get<RollUpResponse>('/rollup', {
      select: Object.entries(selection).filter(([, v]) => v)
        .map(([k, v]) => `${k}:${v}`).join(','),
    }),
  reconciliation: (key: string) =>
    get<{
      key: string; label: string; series_id: string; native: string; kind: string
      measure: string; agg: string; unit: string; note: string | null
      rebase: boolean; derive: string | null; method: string
      raw_is_derived: boolean
      raw: { date: string; value: number }[]
      derived: { date: string; value: number }[]
      residual_absolute: number | null; residual_relative: number | null
      identity_holds: boolean | null
    }>(`/mev/reconciliation/${key}`),
}
