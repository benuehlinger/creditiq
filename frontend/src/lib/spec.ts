import type { PortfolioKey, Treatment } from './api'

/**
 * The PD specification: ONE object, the way the severity side always had one.
 *
 * It was previously eight separate things — five fields in the store, and
 * `maxBins`, `nKnots`, `estimator`, `ootFrom` and `downsample` as local state on
 * two different surfaces. That scattering is the reason the two model stages
 * felt like different products, and it caused a specific class of bug that kept
 * coming back:
 *
 *  - `maxBins` and `nKnots` were local AND global — one value shared by every
 *    variable, reset on navigation. Changing the bin count and walking to the
 *    fit lost the change, which is exactly what it looked like: nothing
 *    happened.
 *  - Some fields were in the store and some were not, so a change to one was
 *    detected as a change and a change to another was not.
 *  - The fork guard could only wrap the mutations it knew about, and it did not
 *    know about the ones on the Explore stage.
 *
 * One object fixes all three at once: one place to read, one place to write, one
 * thing to diff, one thing to guard.
 */

/** How a single variable enters the model. */
export interface VariableSpec {
  column: string
  treatment: Treatment
  /** Bin edges set by hand. Absent means the optimal binning at `maxBins`. */
  edges?: number[]
  /** Spline knots set by hand. Absent means quantile knots at `nKnots`. */
  knots?: number[]
  /** Per variable, not per screen. A global bin count meant rebinning one
   *  variable silently rebinned every other one. */
  maxBins: number
  nKnots: number
}

export interface PdSpec {
  /** Ordered, because the order the analyst added them is the order they read
   *  in every table downstream. */
  variables: VariableSpec[]
  /** Macro terms as `key@transform@lag`. One form covers a level term and a
   *  transformed one, so there is no second code path for the second kind. */
  mevs: string[]
  estimator: string
  ootFrom: string
  downsample: number | null
  /** The account-age baseline: a curve on months on book capturing how default
   *  risk varies with loan age, so selected variables do not absorb it. The
   *  analyst's choice, on the fit controls; part of the model's identity.
   *  Absent on older persisted drafts — read it `?? true` everywhere. */
  seasoningSpline?: boolean
}

export const DEFAULT_MAX_BINS = 8
export const DEFAULT_N_KNOTS = 4

const DEFAULT_MEVS: Record<string, string[]> = {
  consumer: ['unemployment_rate@level@0', 'real_disp_income_growth@level@0'],
  mortgage: ['unemployment_rate@level@0'],
  cre: ['cre_price_index_yoy@level@0', 'bbb_yield@level@0'],
}

export function emptyPdSpec(portfolio: string): PdSpec {
  return {
    variables: [],
    mevs: DEFAULT_MEVS[portfolio] ?? [],
    estimator: 'logistic',
    ootFrom: '2023-01-01',
    downsample: null,
    seasoningSpline: true,
  }
}

export const emptyPdSpecs = (): Record<PortfolioKey, PdSpec> => ({
  consumer: emptyPdSpec('consumer'),
  mortgage: emptyPdSpec('mortgage'),
  cre: emptyPdSpec('cre'),
})

export const variable = (s: PdSpec, column: string): VariableSpec | undefined =>
  s.variables.find((v) => v.column === column)

export const columns = (s: PdSpec): string[] => s.variables.map((v) => v.column)

export const isPicked = (s: PdSpec, column: string): boolean =>
  column.includes('@') ? s.mevs.includes(column) : s.variables.some((v) => v.column === column)

/** Add or remove a term. One entry point for both kinds, because a macro
 *  variable is a candidate like any other — it just lands in a different field
 *  of the request. */
export function toggleTerm(s: PdSpec, column: string): PdSpec {
  if (column.includes('@')) {
    return { ...s, mevs: s.mevs.includes(column)
      ? s.mevs.filter((m) => m !== column) : [...s.mevs, column] }
  }
  const has = s.variables.some((v) => v.column === column)
  return { ...s, variables: has
    ? s.variables.filter((v) => v.column !== column)
    : [...s.variables, { column, treatment: 'woe',
                         maxBins: DEFAULT_MAX_BINS, nKnots: DEFAULT_N_KNOTS }] }
}

/**
 * Change one variable's settings.
 *
 * A variable that is not yet in the specification is added by the change. This
 * is deliberate: adjusting a binning IS an expression of intent to use the
 * variable, and requiring a separate "add" step is what made the editor feel
 * like it was ignoring input — the change applied to a preview and then
 * evaporated because nothing was holding it.
 */
export function setVariable(s: PdSpec, column: string,
                            patch: Partial<Omit<VariableSpec, 'column'>>): PdSpec {
  const existing = s.variables.find((v) => v.column === column)
  if (!existing) {
    return { ...s, variables: [...s.variables, {
      column, treatment: 'woe', maxBins: DEFAULT_MAX_BINS, nKnots: DEFAULT_N_KNOTS,
      ...patch }] }
  }
  return { ...s, variables: s.variables.map((v) =>
    v.column === column ? { ...v, ...patch } : v) }
}

/**
 * The specification reduced to a stable string, for comparing two of them.
 *
 * Order-insensitive where order carries no meaning — reordering the variable
 * list is not a different model, changing a treatment is. This is what makes a
 * change detectable at all: comparing the fitted HASH cannot tell "not yet
 * refitted" from "the data moved", and comparing column NAMES misses everything
 * about how those columns are built.
 */
export function canonical(s: PdSpec): string {
  return JSON.stringify({
    v: [...s.variables]
      .map((v) => [v.column, v.treatment, (v.edges ?? []).join(','),
                   (v.knots ?? []).join(','), v.maxBins, v.nKnots])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    m: [...s.mevs].sort(),
    e: s.estimator, o: s.ootFrom, d: s.downsample,
    s: s.seasoningSpline ?? true,
  })
}

/** The wire form the fit endpoint takes. */
export function toRequest(s: PdSpec, portfolio: string, lgd: unknown) {
  return {
    portfolio,
    variables: s.variables.map((v) => ({
      column: v.column, treatment: v.treatment,
      edges: v.edges ?? null, knots: v.knots ?? null,
      // The bin and knot COUNTS travel too. Without them the fit fell back to
      // the library defaults: the editor showed seven bins and the model was
      // estimated on eight. They are also what lets a saved specification
      // restore the counts it was built with.
      max_bins: v.maxBins, n_knots: v.nKnots,
    })),
    mevs: s.mevs.map((col) => {
      const [key, transform, lag] = col.split('@')
      return { key, transform: transform || 'level', lag_months: Number(lag || 0) }
    }),
    estimator: s.estimator,
    seasoning_spline: s.seasoningSpline ?? true,
    oot_from: s.ootFrom,
    downsample_rows: s.downsample,
    lgd,
  }
}

/** Rebuild a specification from a saved request, so opening a version restores
 *  every setting rather than the subset that happened to live in the store. */
export function fromRequest(req: Record<string, unknown> | undefined,
                            portfolio: string): PdSpec {
  const base = emptyPdSpec(portfolio)
  if (!req) return base
  const vars = (req.variables ?? []) as Record<string, unknown>[]
  const mevs = (req.mevs ?? []) as Record<string, unknown>[]
  return {
    variables: vars.map((v) => ({
      column: String(v.column),
      treatment: (v.treatment ?? 'woe') as Treatment,
      edges: (v.edges as number[]) ?? undefined,
      knots: (v.knots as number[]) ?? undefined,
      // Prefer the count the specification carries. Older saved versions have
      // no such field; for those the hand-set edges imply it, and failing that
      // the default is what they were fitted under.
      maxBins: Number(v.max_bins)
        || (Array.isArray(v.edges) ? v.edges.length + 1 : DEFAULT_MAX_BINS),
      nKnots: Number(v.n_knots)
        || (Array.isArray(v.knots) ? v.knots.length : DEFAULT_N_KNOTS),
    })),
    mevs: mevs.map((m) =>
      `${m.key}@${m.transform ?? 'level'}@${m.lag_months ?? 0}`),
    estimator: String(req.estimator ?? base.estimator),
    ootFrom: String(req.oot_from ?? base.ootFrom),
    downsample: (req.downsample_rows as number | null) ?? null,
    seasoningSpline: (req.seasoning_spline as boolean | undefined) ?? true,
  }
}
