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
}
