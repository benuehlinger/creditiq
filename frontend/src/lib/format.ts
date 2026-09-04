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
/** Accepts what a chart actually hands back.
 *
 *  On a `type: 'time'` axis ECharts reports the axis value as a millisecond
 *  TIMESTAMP, not as the ISO string that went in. Appending 'T00:00:00' to a
 *  number produced `new Date("1767225600000T00:00:00")` — Invalid Date — and
 *  every crosshair tooltip on a time axis printed "Invalid Date" as its header.
 *  That is most of the charts in the application: the realised default rate,
 *  the backtest panels, bin stability, the macro paths and the ECL projections.
 */
const asDate = (v: string | number | Date): Date =>
  v instanceof Date ? v
    : typeof v === 'number' ? new Date(v)
    // A bare date needs the time appended, or it is read as UTC and can land on
    // the previous day west of Greenwich.
    : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v)

export const month = (v: string | number | Date) =>
  asDate(v).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

/** Tooltip headers name the month AND the year. `monthShort` drops the year on
 *  purpose — it labels a dense axis, where the year appears once each January
 *  and repeating it on every tick is noise. A tooltip has no such context. */
export const monthLong = (v: string | number | Date) =>
  asDate(v).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

export const monthShort = (v: string | number | Date) => {
  const d = asDate(v)
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

/** A categorical level a display can be trusted with. The synthetic tapes
 *  carry the mess real tapes carry — ' direct ' beside 'direct' — and
 *  collapsing the whitespace on display makes the two read as an
 *  inexplicable duplicate. A level whose trimmed self differs is shown
 *  quoted, so the padding is visible instead of invisible. */
export function visibleLevel(s: string): string {
  return s !== s.trim() ? `'${s}'` : s
}
