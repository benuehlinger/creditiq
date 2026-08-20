import raw from './tokens.json'

/** The validated palette, typed. `tokens.json` is the single source of truth and
 *  the API serves the same file, so the two cannot drift silently. */
export type Mode = 'light' | 'dark'
export type PortfolioKey = 'consumer' | 'mortgage' | 'cre'

export const tokens = raw as typeof raw

/** Resolve a CSS custom property to a concrete colour.
 *
 *  ECharts draws to a canvas and cannot read CSS custom properties — passing
 *  `var(--accent)` produces a silent fallback to a default grey, which looks like
 *  a styling choice rather than a bug. Every colour handed to a chart goes
 *  through here first. */
export function cssVar(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!v) throw new Error(`cssVar(${name}): not defined — charts cannot use an unresolved variable`)
  return v
}

/** The active portfolio's accent, resolved. */
export const accent = () => cssVar('--accent')

export const isDark = () =>
  document.documentElement.getAttribute('data-theme') !== 'light'

export const mode = (): Mode => (isDark() ? 'dark' : 'light')

/** Categorical series colour by slot (0-based). Never cycles: past the cap the
 *  caller must fold to "Other", facet, or switch to emphasis. */
export function series(i: number, m: Mode = mode()): string {
  const set = tokens.categorical[m]
  if (i < 0 || i >= set.length) {
    throw new Error(
      `series(${i}): the palette has ${set.length} slots and never cycles. ` +
      `Fold the tail into "Other", facet into small multiples, or use emphasis.`,
    )
  }
  return set[i]
}

/** Hard caps from the validator. Adjacent forms (bars, stacks, lines) carry five;
 *  all-pairs forms (scatter, bubble, small multiples) carry three, because any
 *  two marks can end up side by side there. */
export const SERIES_CAP = { adjacent: 5, allPairs: 3 } as const

export const portfolioColor = (k: PortfolioKey, m: Mode = mode()) =>
  tokens.portfolios[k][m]

export const ink = (m: Mode = mode()) => tokens.ink[m]
export const chrome = (m: Mode = mode()) => tokens.chrome[m]
export const surfaces = (m: Mode = mode()) => tokens.surfaces[m]

/** Continuous magnitude. One hue, light to dark. */
export function sequential(t: number, m: Mode = mode()): string {
  const ramp = tokens.sequential[m]
  const i = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))))
  return ramp[i]
}

/** Discrete ORDERED categories — severity, vintage, decile, grade. */
export function ordinal(i: number, n: number, m: Mode = mode()): string {
  const ramp = tokens.ordinal[m]
  if (n <= 1) return ramp[Math.floor(ramp.length / 2)]
  const t = i / (n - 1)
  return ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))))]
}

/** Signed statistics — WoE, correlation, sensitivity. Blue to magenta with a
 *  neutral grey midpoint. Red and amber stay reserved for risk semantics. */
export function diverging(t: number, m: Mode = mode()): string {
  const d = tokens.diverging[m]
  const c = Math.max(-1, Math.min(1, t))
  if (Math.abs(c) < 0.02) return d.midpoint
  const from = d.midpoint
  const to = c < 0 ? d.negative : d.positive
  return mix(from, to, Math.abs(c))
}

export const status = tokens.status
export const marks = tokens.marks
export const deemphasis = (m: Mode = mode()) => tokens.deemphasis[m]

function hex2rgb(h: string): [number, number, number] {
  const s = h.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number]
}
function mix(a: string, b: string, t: number): string {
  if (a.startsWith('rgb') || b.startsWith('rgb')) return b
  const [r1, g1, b1] = hex2rgb(a)
  const [r2, g2, b2] = hex2rgb(b)
  const f = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `#${[f(r1, r2), f(g1, g2), f(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
