import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FitRequest, PortfolioKey, Treatment } from './api'

type Theme = 'dark' | 'light'

/** The specification that was actually fitted, per portfolio.
 *
 *  This exists because three surfaces used to rebuild the spec independently and
 *  each got it wrong in its own way: Versions saved with no macro terms at all,
 *  and Scenarios projected whatever the variable tray happened to hold rather
 *  than what was fitted. The consequence was silent — you got a saved version
 *  with a different hash, a different name and different metrics from the model
 *  on screen.
 *
 *  The REQUEST is stored rather than the response, because the request is what
 *  determines the hash. Save and project replay it verbatim, so the version is
 *  provably the model that was fitted. */
export interface FittedModel {
  request: FitRequest
  hash: string
  name: string
  fittedAt: string
  /** The tray selection at the moment of the fit, so a later divergence is
   *  detectable and can be shown rather than silently ignored. */
  variablesAtFit: string[]
}

interface UiState {
  theme: Theme
  paletteOpen: boolean
  methodologyOpen: string | null
  selectedVariables: Record<PortfolioKey, string[]>
  fitted: Record<PortfolioKey, FittedModel | null>
  /** How each variable enters the model. Absent means the default, WoE. */
  treatments: Record<PortfolioKey, Record<string, Treatment>>
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setPaletteOpen: (b: boolean) => void
  setMethodology: (id: string | null) => void
  toggleVariable: (p: PortfolioKey, v: string) => void
  clearVariables: (p: PortfolioKey) => void
  setFitted: (p: PortfolioKey, f: FittedModel | null) => void
  setTreatment: (p: PortfolioKey, column: string, t: Treatment) => void
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      paletteOpen: false,
      methodologyOpen: null,
      selectedVariables: { consumer: [], mortgage: [], cre: [] },
      fitted: { consumer: null, mortgage: null, cre: null },
      treatments: { consumer: {}, mortgage: {}, cre: {} },
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
      setTreatment: (p, column, t) =>
        set((s) => ({ treatments: { ...s.treatments, [p]: { ...s.treatments[p], [column]: t } } })),
    }),
    { name: 'creditiq-ui', partialize: (s) => ({ theme: s.theme, selectedVariables: s.selectedVariables,
                            fitted: s.fitted, treatments: s.treatments }) },
  ),
)

/** Applied once at boot so the first paint is already in the right theme. */
export function applyStoredTheme() {
  const t = useUi.getState().theme
  document.documentElement.setAttribute('data-theme', t)
}
