import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FitRequest, LgdSpecPayload, PortfolioKey, Treatment } from './api'

type Theme = 'dark' | 'light'

/** The PD specification that was fitted, per portfolio.
 *
 *  The request is stored rather than the response, because the request
 *  determines the hash. Save and project replay it unchanged, so a saved version
 *  and a projection both refer to the specification that was fitted rather than
 *  to one rebuilt from the current state of the variable tray. */
export interface FittedModel {
  request: FitRequest
  hash: string
  name: string
  fittedAt: string
  /** The tray selection at the moment of the fit, so a later divergence is
   *  detectable and can be shown rather than silently ignored. */
  variablesAtFit: string[]
}

/** The LGD specification, held separately because the two models are fitted on
 *  separate surfaces and in either order. A Model ID requires both. */
export interface FittedLgd {
  spec: LgdSpecPayload
  hash: string
  fittedAt: string
  meanLgd: number
  nDefaults: number
}

/** A saved model opened for inspection. While this is set, every surface shows
 *  that specification rather than the working draft. Saved models are not edited
 *  in place: a change creates a new Model ID recording this one as its parent. */
export interface LoadedModel {
  hash: string
  name: string
  status: string
  loadedAt: string
}

interface UiState {
  theme: Theme
  paletteOpen: boolean
  methodologyOpen: string | null
  selectedVariables: Record<PortfolioKey, string[]>
  fitted: Record<PortfolioKey, FittedModel | null>
  fittedLgd: Record<PortfolioKey, FittedLgd | null>
  loaded: Record<PortfolioKey, LoadedModel | null>
  /** How each variable enters the model. Absent means the default, WoE. */
  treatments: Record<PortfolioKey, Record<string, Treatment>>
  /** Spline knots placed by hand, per variable. Absent means the knots are taken
   *  from quantiles of the variable's own distribution. */
  knots: Record<PortfolioKey, Record<string, number[]>>
  /** Macro terms promoted out of the transformation search, per target. They are
   *  candidates, not model terms: the PD fit and the LGD specification each
   *  choose from this list. */
  macroShortlist: Record<PortfolioKey, { pd: string[]; lgd: string[] }>
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setPaletteOpen: (b: boolean) => void
  setMethodology: (id: string | null) => void
  toggleVariable: (p: PortfolioKey, v: string) => void
  clearVariables: (p: PortfolioKey) => void
  setFitted: (p: PortfolioKey, f: FittedModel | null) => void
  setFittedLgd: (p: PortfolioKey, f: FittedLgd | null) => void
  setLoaded: (p: PortfolioKey, v: LoadedModel | null) => void
  /** Called before an edit while a saved model is open. Clears the marker and
   *  returns its hash, which becomes the parent of the new specification. */
  forkFromLoaded: (p: PortfolioKey) => string | null
  setTreatment: (p: PortfolioKey, column: string, t: Treatment) => void
  setKnots: (p: PortfolioKey, column: string, k: number[] | undefined) => void
  toggleShortlist: (p: PortfolioKey, target: 'pd' | 'lgd', column: string) => void
}

/** Shared empty values for selectors whose key may be absent.
 *
 *  Zustand compares snapshots with `Object.is`. A selector written
 *  `(s) => s.map[key] ?? []` builds a NEW array whenever the key is missing, so
 *  it reports a change on every render and the component re-renders forever.
 *  React surfaces it as "the result of getSnapshot should be cached" followed by
 *  "maximum update depth exceeded", and the surface renders blank. Every
 *  selector with a fallback must return one of these instead of a literal. */
export const NONE: readonly string[] = Object.freeze([])
export const NO_MAP: Readonly<Record<string, never>> = Object.freeze({})

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      paletteOpen: false,
      methodologyOpen: null,
      selectedVariables: { consumer: [], mortgage: [], cre: [] },
      fitted: { consumer: null, mortgage: null, cre: null },
      fittedLgd: { consumer: null, mortgage: null, cre: null },
      loaded: { consumer: null, mortgage: null, cre: null },
      treatments: { consumer: {}, mortgage: {}, cre: {} },
      knots: { consumer: {}, mortgage: {}, cre: {} },
      macroShortlist: {
        consumer: { pd: [], lgd: [] }, mortgage: { pd: [], lgd: [] },
        cre: { pd: [], lgd: [] },
      },
      setTheme: (t) => {
        document.documentElement.setAttribute('data-theme', t)
        set({ theme: t })
      },
      toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setMethodology: (methodologyOpen) => set({ methodologyOpen }),
      toggleVariable: (p, v) =>
        set((s) => {
          const cur = s.selectedVariables[p] ?? []
          return {
            selectedVariables: {
              ...s.selectedVariables,
              [p]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v],
            },
          }
        }),
      clearVariables: (p) =>
        set((s) => ({ selectedVariables: { ...s.selectedVariables, [p]: [] } })),
      setFitted: (p, f) => set((s) => ({ fitted: { ...s.fitted, [p]: f } })),
      setFittedLgd: (p, f) => set((s) => ({ fittedLgd: { ...s.fittedLgd, [p]: f } })),
      setLoaded: (p, v) => set((s) => ({ loaded: { ...s.loaded, [p]: v } })),
      forkFromLoaded: (p) => {
        const cur = get().loaded[p]
        if (cur) set((s) => ({ loaded: { ...s.loaded, [p]: null } }))
        return cur?.hash ?? null
      },
      setTreatment: (p, column, t) =>
        set((s) => ({ treatments: { ...s.treatments, [p]: { ...s.treatments[p], [column]: t } } })),
      toggleShortlist: (p, target, column) =>
        set((s) => {
          const cur = s.macroShortlist[p][target]
          return {
            macroShortlist: {
              ...s.macroShortlist,
              [p]: {
                ...s.macroShortlist[p],
                [target]: cur.includes(column)
                  ? cur.filter((c) => c !== column) : [...cur, column],
              },
            },
          }
        }),
      setKnots: (p, column, k) =>
        set((s) => {
          const next = { ...s.knots[p] }
          if (k && k.length) next[column] = k
          else delete next[column]          // absent means "use quantile knots"
          return { knots: { ...s.knots, [p]: next } }
        }),
    }),
    { name: 'creditiq-ui', partialize: (s) => ({ theme: s.theme, selectedVariables: s.selectedVariables,
                            fitted: s.fitted, fittedLgd: s.fittedLgd, loaded: s.loaded,
                            treatments: s.treatments, knots: s.knots,
                            macroShortlist: s.macroShortlist }) },
  ),
)

/** Applied once at boot so the first paint is already in the right theme. */
export function applyStoredTheme() {
  const t = useUi.getState().theme
  document.documentElement.setAttribute('data-theme', t)
}
