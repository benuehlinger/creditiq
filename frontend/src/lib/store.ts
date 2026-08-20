import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PortfolioKey } from './api'

type Theme = 'dark' | 'light'

interface UiState {
  theme: Theme
  paletteOpen: boolean
  methodologyOpen: string | null
  selectedVariables: Record<PortfolioKey, string[]>
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setPaletteOpen: (b: boolean) => void
  setMethodology: (id: string | null) => void
  toggleVariable: (p: PortfolioKey, v: string) => void
  clearVariables: (p: PortfolioKey) => void
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      paletteOpen: false,
      methodologyOpen: null,
      selectedVariables: { consumer: [], mortgage: [], cre: [] },
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
    }),
    { name: 'helios-ui', partialize: (s) => ({ theme: s.theme, selectedVariables: s.selectedVariables }) },
  ),
)

/** Applied once at boot so the first paint is already in the right theme. */
export function applyStoredTheme() {
  const t = useUi.getState().theme
  document.documentElement.setAttribute('data-theme', t)
}
