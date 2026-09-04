import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FitRequest, LgdSpecPayload, PortfolioKey } from './api'
import { type PdSpec, emptyPdSpecs } from './spec'

type Theme = 'dark' | 'light'

/** The PD specification that was fitted, per portfolio.
 *
 *  The request is stored rather than the response, because the request
 *  determines the hash. Save and project replay it unchanged, so a saved version
 *  and a projection both refer to the specification that was fitted rather than
 *  to one rebuilt from the current state of the variable tray. */
export interface FittedModel {
  /** The PD specification's own hash — `hash` is the pair identity. */
  pdHash?: string
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
  /** Derived from the hash, as the PD name is. */
  name?: string
  fittedAt: string
  meanLgd: number
  nDefaults: number
  /** Headline fit statistics, so the model band can show the severity half
   *  without re-running the fit. Absent on a restored version until it is
   *  re-estimated. */
  rmse?: number
  bias?: number
  devianceR2?: number
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

/** Everything that makes up a working draft on one book. */
export interface Draft {
  pdSpec: PdSpec
  fitted: FittedModel | null
  fittedLgd: FittedLgd | null
  projected: string | null
  stashedAt: string
}

interface UiState {
  theme: Theme
  paletteOpen: boolean
  /** The model bar's call to action, clicked while its target stage is already
   *  on screen. Held in the store rather than dispatched as an event because
   *  the pane that performs the action may not be MOUNTED at the moment of the
   *  click (a variable detail open on the workbench, say): the workbench
   *  switches to the model view, the pane mounts, reads the flag, consumes it
   *  and runs. Transient — not in partialize — so it cannot survive a reload
   *  and fire an action nobody asked for. */
  cta: string | null
  methodologyOpen: string | null
  fitted: Record<PortfolioKey, FittedModel | null>
  fittedLgd: Record<PortfolioKey, FittedLgd | null>
  loaded: Record<PortfolioKey, LoadedModel | null>
  /** Macro terms promoted out of the transformation search, per target. They are
   *  candidates, not model terms: the PD fit and the LGD specification each
   *  choose from this list. */
  macroShortlist: Record<PortfolioKey, { pd: string[]; lgd: string[] }>
  /** THE PD specification, per book. One object, mutated only through
   *  `editPd` so that every path is guarded and every change is detectable. */
  pdSpec: Record<PortfolioKey, PdSpec>
  /** Which model each book has actually been PROJECTED on, as `pdHash:lgdHash`.
   *
   *  The scenarios stage reported itself complete as soon as both halves were
   *  fitted, while its own note read "ready to project". Green meant "you could
   *  do this" on that one stage and "this is done" on every other, which is the
   *  opposite meaning for the same mark. Recording what was projected lets the
   *  stage say which of the three it is: not run, run, or run on a model that
   *  has since changed. */
  projected: Record<PortfolioKey, string | null>
  setProjected: (p: PortfolioKey, key: string | null) => void
  /** The working draft, put aside when a saved model is opened over it.
   *
   *  Opening a version replaced whatever was being worked on, and there was
   *  no way back: switching models to compare them cost the analyst the draft
   *  they were comparing against. The draft is kept here until it is restored
   *  or a new draft is started, and the model picker offers it. */
  draft: Record<PortfolioKey, Draft | null>
  stashDraft: (p: PortfolioKey) => void
  restoreDraft: (p: PortfolioKey) => void
  /** Which lockup structure the header renders. Chosen on the brand page, so
   *  a candidate is judged in the real chrome rather than in a specimen. */
  brandVariant: string
  setBrandVariant: (v: string) => void
  /**
   * The one way to change a PD specification.
   *
   * A saved model is immutable, so an edit while one is open has to fork. That
   * rule was previously enforced by wrapping each mutation at its call site,
   * which meant it held on the two fit surfaces and not on the two explore
   * surfaces — a saved model could be silently rewritten just by rebinning a
   * variable. Enforcing it HERE makes it true by construction: a mutation that
   * forgets to ask does not exist, because there is only one door.
   *
   * When a saved model is open the edit is held rather than applied, and
   * `pendingEdit` is set for the shell to confirm.
   */
  editPd: (p: PortfolioKey, change: (s: PdSpec) => PdSpec, label: string) => void
  /** Replace the specification outright, WITHOUT the fork guard.
   *
   *  Restoring a saved version is not an edit of it — it is how it gets onto
   *  the screen in the first place — so it must not prompt to fork. This is the
   *  only legitimate caller. */
  setPdSpec: (p: PortfolioKey, spec: PdSpec) => void
  /** Same door for the severity specification.
   *
   *  `base` is the specification to start from when nothing has been fitted
   *  yet — the severity screen proposes one before the first fit, and an edit
   *  made there has to land somewhere. Without it the first edit on the Explore
   *  stage silently did nothing. */
  editLgd: (p: PortfolioKey, change: (s: LgdSpecPayload) => LgdSpecPayload,
            label: string, base?: LgdSpecPayload) => void
  /** An edit waiting on the fork confirmation, with what it would do. */
  pendingEdit: { portfolio: PortfolioKey; label: string; apply: () => void } | null
  confirmEdit: () => void
  cancelEdit: () => void
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setPaletteOpen: (b: boolean) => void
  setMethodology: (id: string | null) => void
  setCta: (v: string | null) => void
  setFitted: (p: PortfolioKey, f: FittedModel | null) => void
  setFittedLgd: (p: PortfolioKey, f: FittedLgd | null) => void
  setLoaded: (p: PortfolioKey, v: LoadedModel | null) => void
  /** Called before an edit while a saved model is open. Clears the marker and
   *  returns its hash, which becomes the parent of the new specification. */
  forkFromLoaded: (p: PortfolioKey) => string | null
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
      cta: null,
      methodologyOpen: null,
      fitted: { consumer: null, mortgage: null, cre: null },
      fittedLgd: { consumer: null, mortgage: null, cre: null },
      loaded: { consumer: null, mortgage: null, cre: null },
      macroShortlist: {
        consumer: { pd: [], lgd: [] }, mortgage: { pd: [], lgd: [] },
        cre: { pd: [], lgd: [] },
      },
      pdSpec: emptyPdSpecs(),
      projected: { consumer: null, mortgage: null, cre: null },
      setProjected: (p, key) =>
        set((s) => ({ projected: { ...s.projected, [p]: key } })),
      brandVariant: 'rule',
      setBrandVariant: (brandVariant) => set({ brandVariant }),
      draft: { consumer: null, mortgage: null, cre: null },
      stashDraft: (p) => set((s) => {
        // Only a draft is worth keeping: an open saved model is on disk.
        if (s.loaded[p]) return s
        const has = s.pdSpec[p].variables.length || s.fitted[p] || s.fittedLgd[p]
        if (!has) return s
        return { draft: { ...s.draft, [p]: {
          pdSpec: s.pdSpec[p], fitted: s.fitted[p], fittedLgd: s.fittedLgd[p],
          projected: s.projected[p], stashedAt: new Date().toISOString() } } }
      }),
      restoreDraft: (p) => set((s) => {
        const d = s.draft[p]
        if (!d) return s
        return {
          pdSpec: { ...s.pdSpec, [p]: d.pdSpec },
          fitted: { ...s.fitted, [p]: d.fitted },
          fittedLgd: { ...s.fittedLgd, [p]: d.fittedLgd },
          projected: { ...s.projected, [p]: d.projected },
          loaded: { ...s.loaded, [p]: null },
          draft: { ...s.draft, [p]: null },
        }
      }),
      setPdSpec: (p, spec) => set((s) => ({ pdSpec: { ...s.pdSpec, [p]: spec } })),
      pendingEdit: null,
      editPd: (p, change, label) => {
        const apply = () => set((s) => ({ pdSpec: { ...s.pdSpec, [p]: change(s.pdSpec[p]) } }))
        if (get().loaded[p]) { set({ pendingEdit: { portfolio: p, label, apply } }); return }
        apply()
      },
      editLgd: (p, change, label, base) => {
        const cur = get().fittedLgd[p]
        if (!cur && !base) return
        const apply = () => set((s) => {
          const f = s.fittedLgd[p]
          // An edit invalidates the fit. The empty hash is the marker every
          // surface already reads as "specified, not yet estimated".
          const spec = change(f ? f.spec : base!)
          return { fittedLgd: { ...s.fittedLgd, [p]: {
            spec, hash: '', fittedAt: '', meanLgd: NaN, nDefaults: 0 } } }
        })
        if (get().loaded[p]) { set({ pendingEdit: { portfolio: p, label, apply } }); return }
        apply()
      },
      confirmEdit: () => {
        const e = get().pendingEdit
        if (!e) return
        // Forking clears the marker first, so the applied edit lands on a
        // working draft rather than appearing to modify the saved model.
        set((s) => ({ loaded: { ...s.loaded, [e.portfolio]: null }, pendingEdit: null }))
        e.apply()
      },
      cancelEdit: () => set({ pendingEdit: null }),
      setTheme: (t) => {
        document.documentElement.setAttribute('data-theme', t)
        set({ theme: t })
      },
      toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setCta: (cta) => set({ cta }),
      setMethodology: (methodologyOpen) => set({ methodologyOpen }),
      setFitted: (p, f) => set((s) => ({ fitted: { ...s.fitted, [p]: f } })),
      setFittedLgd: (p, f) => set((s) => ({ fittedLgd: { ...s.fittedLgd, [p]: f } })),
      setLoaded: (p, v) => set((s) => ({ loaded: { ...s.loaded, [p]: v } })),
      forkFromLoaded: (p) => {
        const cur = get().loaded[p]
        if (cur) set((s) => ({ loaded: { ...s.loaded, [p]: null } }))
        return cur?.hash ?? null
      },
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
    }),
    { name: 'creditiq-ui', partialize: (s) => ({ theme: s.theme,
                            fitted: s.fitted, fittedLgd: s.fittedLgd, loaded: s.loaded,
                                                        macroShortlist: s.macroShortlist,
                            pdSpec: s.pdSpec, projected: s.projected, draft: s.draft,
                            brandVariant: s.brandVariant }),
      version: 4,
      // Work in progress must survive the change of shape. The old state held
      // the specification in five store fields plus local component state; the
      // local parts are gone either way, but everything that WAS persisted is
      // folded into the one object.
      migrate: (persisted: unknown, from: number) => {
        const s = (persisted ?? {}) as Record<string, any>
        // v4 (2026-09-03): drop every cached working artefact — fitted records,
        // drafts, loaded markers, per-book specs — in EVERY browser that has
        // one, on the user's instruction. Saved versions live on the server
        // and are untouched; this clears only the browser-side candidates.
        // Preferences (theme, brand) survive.
        if (from < 4) {
          for (const k of ['fitted', 'fittedLgd', 'loaded', 'draft',
                           'projected', 'pdSpec', 'macroShortlist']) {
            delete s[k]
          }
        }
        // Nothing recorded which model had been projected, so nothing may claim
        // to have been. An empty marker reads as "not run", which is correct.
        if (!s.projected) {
          s.projected = { consumer: null, mortgage: null, cre: null }
        }
        if (!s.draft) {
          s.draft = { consumer: null, mortgage: null, cre: null }
        }
        if (from >= 2 || s.pdSpec) return s
        const specs = emptyPdSpecs()
        for (const p of ['consumer', 'mortgage', 'cre'] as PortfolioKey[]) {
          const cols: string[] = s.selectedVariables?.[p] ?? []
          specs[p] = {
            ...specs[p],
            variables: cols.map((c) => ({
              column: c,
              treatment: s.treatments?.[p]?.[c] ?? 'woe',
              edges: s.edges?.[p]?.[c],
              knots: s.knots?.[p]?.[c],
              maxBins: s.edges?.[p]?.[c]?.length ? s.edges[p][c].length + 1 : 8,
              nKnots: s.knots?.[p]?.[c]?.length ?? 4,
            })),
            mevs: s.pdMevs?.[p] ?? specs[p].mevs,
            ...(s.fitted?.[p]?.request
              ? { estimator: s.fitted[p].request.estimator ?? 'logistic',
                  ootFrom: s.fitted[p].request.oot_from ?? '2023-01-01',
                  downsample: s.fitted[p].request.downsample_rows ?? null }
              : {}),
          }
        }
        return { ...s, pdSpec: specs }
      } },
  ),
)

/** Applied once at boot so the first paint is already in the right theme. */
export function applyStoredTheme() {
  const t = useUi.getState().theme
  document.documentElement.setAttribute('data-theme', t)
}
