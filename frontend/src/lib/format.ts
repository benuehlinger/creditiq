/** Formatting helpers.
 *
 *  Rule from the brief: every number carries units and a period. These helpers
 *  exist so that rule is cheap to follow rather than a thing to remember.
 */

export const pct = (v: number | null | undefined, dp = 2) =>
  v == null || Number.isNaN(v) ? '—' : `${v.toFixed(dp)}%`

export const bps = (v: number | null | undefined) =>
  v == null ? '—' : `${Math.round(v * 100)} bps`

export function usd(v: number | null | undefined, compact = true): string {
  if (v == null || Number.isNaN(v)) return '—'
  const a = Math.abs(v)
  if (!compact || a < 1000) return `$${v.toFixed(0)}`
  const [div, suf] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'K']
  const n = v / div
  return `$${n.toFixed(Math.abs(n) < 10 ? 1 : 0)}${suf}`
}

export const num = (v: number | null | undefined, dp = 0) =>
  v == null || Number.isNaN(v) ? '—' : v.toLocaleString('en-US',
    { minimumFractionDigits: dp, maximumFractionDigits: dp })

export const ratio = (v: number | null | undefined, dp = 3) =>
  v == null || Number.isNaN(v) ? '—' : v.toFixed(dp)

/** "Jan 2020" — the grain the panel actually has. */
export const month = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

export const monthShort = (iso: string) => {
  const d = new Date(iso + 'T00:00:00')
  return d.getMonth() === 0
    ? String(d.getFullYear())
    : d.toLocaleDateString('en-US', { month: 'short' })
}

/** Period label for a chart subtitle, so no chart is undated. */
export const periodLabel = (from: string, to: string) => `${month(from)} – ${month(to)}`


/** Format a profiled value by its declared UNIT, never by guessing from its
 *  magnitude. Guessing is how an account id ends up rendered as $25K. */
export function byUnit(v: number | null | undefined, unit: string): string {
  if (v == null || Number.isNaN(v)) return '—'
  switch (unit) {
    case 'identifier': return num(v)
    case 'currency': return usd(v)
    case 'percent': return `${v.toFixed(1)}%`
    case 'decimal_rate': return `${(v * 100).toFixed(2)}%`
    case 'count': return num(v)
    case 'score': return v.toFixed(v < 10 ? 2 : 0)
    default: return Math.abs(v) >= 1000 ? num(v) : v.toFixed(2)
  }
}
