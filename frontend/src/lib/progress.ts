import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey } from './api'
import { NONE, useUi } from './store'

export type StageState = 'done' | 'changed' | 'todo'

export interface Stage {
  to: string
  label: string
  /** The primary navigation item this stage belongs to. */
  parent: string
  state: StageState
  note?: string
  /** A stage that is not required to reach a saved model. It reads as skipped
   *  rather than outstanding, so an empty one does not look like a blocker. */
  optional?: boolean
}

/** What relationship the working state has to the version that was opened.
 *
 *  `edited` and `drifted` produced identical red warnings before, and they are
 *  not the same thing. Editing an opened model is the normal way to build a
 *  challenger. A replay that disagrees with the saved record when NOTHING was
 *  edited means the data or the estimator moved underneath it, which is a real
 *  problem. */
export type WorkingMode = 'none' | 'clean' | 'edited' | 'drifted' 

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** Where this book is in building a model.
 *
 *  Each stage reads its state from what already exists rather than from a
 *  checklist someone has to maintain: a stage is done when its output exists,
 *  not when it was ticked.
 *
 *  When a saved model is open, a stage whose specification differs from that
 *  model is `changed`. That is the question a person has while iterating — what
 *  have I altered since I opened this — and the version list cannot answer it,
 *  because it only records end states.
 */
/** Everything the state machine reads. Kept as a plain object so the logic below
 *  is a pure function of it: the flows through this app are numerous enough that
 *  they need to be reasonable about in one place rather than inferred from five
 *  components. */
export interface ProgressInput {
  picked: string[]
  fitted: { hash: string; name: string; variablesAtFit: string[] } | null
  lgd: { hash: string; spec: { drivers: string[]; categoricals: string[] } } | null
  loaded: { hash: string; name: string } | null
  shortlisted: number
  originVars: string[] | null
  originLgd: string[] | null
}

const EMPTY_INPUT: ProgressInput = {
  picked: [], fitted: null, lgd: null, loaded: null,
  shortlisted: 0, originVars: null, originLgd: null,
}

/** One shared empty array for every "no variables" answer.
 *
 *  Zustand compares snapshots with `Object.is`. A selector that builds a fresh
 *  `[]` each call therefore reports a change on EVERY render, and the component
 *  re-renders forever — React reports it as "the result of getSnapshot should be
 *  cached" followed by "maximum update depth exceeded". The roll-up hit this on
 *  every load, because it has no portfolio key and so always took the fallback;
 *  the surface crashed and rendered blank. A selector must return a value that
 *  is REFERENTIALLY stable when nothing has changed. */
export function useProgress(portfolio: string | undefined) {
  const pk = portfolio as PortfolioKey
  const fitted = useUi((s) => (pk ? s.fitted[pk] : null))
  const lgd = useUi((s) => (pk ? s.fittedLgd[pk] : null))
  const loaded = useUi((s) => (pk ? s.loaded[pk] : null))
  const picked = useUi((s) => (pk ? s.selectedVariables[pk] ?? NONE : NONE))
  const shortlist = useUi((s) => (pk ? s.macroShortlist[pk] : null))

  const origin = useQuery({
    queryKey: ['version', loaded?.hash],
    queryFn: () => api.version(loaded!.hash),
    enabled: !!loaded,
  })

  // One return shape, always. Two shapes made every caller narrow a union
  // before it could read `pdStale`.
  if (!portfolio) return computeProgress(EMPTY_INPUT)

  const spec = origin.data?.spec as any | undefined
  return computeProgress({
    picked: picked as string[],
    fitted: fitted ? { hash: fitted.hash, name: fitted.name,
                       variablesAtFit: fitted.variablesAtFit } : null,
    lgd: lgd ? { hash: lgd.hash, spec: lgd.spec } : null,
    loaded: loaded ? { hash: loaded.hash, name: loaded.name } : null,
    shortlisted: (shortlist?.pd.length ?? 0) + (shortlist?.lgd.length ?? 0),
    originVars: spec ? (spec.variables ?? []).map((v: any) => v.column) : null,
    originLgd: spec ? [...(spec.lgd?.drivers ?? []),
                       ...(spec.lgd?.categoricals ?? [])] : null,
  })
}

export function computeProgress(inp: ProgressInput) {
  const { picked, fitted, lgd, loaded, shortlisted, originVars, originLgd } = inp
  const currentLgd = lgd ? [...lgd.spec.drivers, ...lgd.spec.categoricals] : []

  // A fit is a RESULT, and the tray is the draft specification. Once they
  // diverge the fit no longer describes what is on screen: clearing every
  // variable left `fitted` in place, so the panel reported the PD model complete
  // with nothing selected, and offered to save a specification the API refuses.
  const pdStale = !!fitted && (
    picked.length === 0
    || fitted.variablesAtFit.length !== picked.length
    || fitted.variablesAtFit.some((v) => !picked.includes(v)))
  const lgdStale = !!lgd?.hash && currentLgd.length === 0

  // Whether the SPECIFICATION differs from the opened version. Decided from the
  // variables and drivers, never from the hash: a hash that differs while the
  // specification matches is a drift, which is a different situation and needs a
  // different answer. Reading both off the hash made every drift look like an
  // edit, and the drift alarm unreachable.
  const specEdited = !!loaded && (
    (originVars !== null && !sameSet(originVars, picked))
    || (originLgd !== null && !sameSet(originLgd, currentLgd))
    || pdStale || lgdStale)
  const drifted = !!loaded && !specEdited && originVars !== null
    && !!fitted && fitted.hash !== loaded.hash

  const stages: Stage[] = [
    { to: 'data', label: 'Data', parent: 'data', state: 'done' },
    {
      // Optional: a model can take the catalogue's level terms without ever
      // opening the search. An empty one is a choice, not an outstanding task.
      to: 'macro', label: 'Macro', parent: 'macro', optional: true,
      state: shortlisted > 0 ? 'done' : 'todo',
      note: shortlisted > 0 ? `${shortlisted} terms shortlisted`
                            : 'optional — none shortlisted',
    },
    {
      to: 'pd/explore', label: 'PD explore', parent: 'pd',
      state: !picked.length ? 'todo'
        : originVars && !sameSet(originVars, picked) ? 'changed' : 'done',
      note: picked.length ? `${picked.length} variables selected` : 'no variables selected',
    },
    {
      to: 'pd/fit', label: 'PD fit', parent: 'pd',
      state: !fitted || pdStale ? 'todo'
        : specEdited || drifted ? 'changed' : 'done',
      note: !fitted ? 'not fitted'
        : picked.length === 0 ? 'no variables selected — refit needed'
        : pdStale ? `${fitted.name} no longer matches the selection`
        : fitted.name,
    },
    {
      to: 'lgd/explore', label: 'LGD explore', parent: 'lgd',
      state: !currentLgd.length ? 'todo'
        : originLgd && !sameSet(originLgd, currentLgd) ? 'changed' : 'done',
      note: currentLgd.length ? `${currentLgd.length} drivers selected` : 'no drivers selected',
    },
    {
      to: 'lgd/fit', label: 'LGD fit', parent: 'lgd',
      state: !lgd?.hash || lgdStale ? 'todo' : 'done',
      note: !lgd?.hash ? 'not fitted'
        : lgdStale ? 'no drivers selected — refit needed' : 'fitted',
    },
    {
      to: 'scenarios', label: 'Scenarios', parent: 'scenarios', optional: true,
      state: fitted && lgd?.hash ? 'done' : 'todo',
      note: fitted && lgd?.hash ? 'ready to project' : 'needs both models',
    },
  ]

  // Versions is complete when the specification ON SCREEN is saved — not when a
  // saved one has been opened. Opening a version and then editing it left this
  // green while the work was unsaved, which is exactly backwards.
  const changed = stages.filter((s) => s.state === 'changed').length
  // Saveable, not merely fitted: a stale fit cannot be saved, because what would
  // be written is not what the screen shows.
  const complete = !!fitted && !pdStale && !!lgd?.hash && !lgdStale
  const saved = !!loaded && changed === 0
  stages.push({
    to: 'versions', label: 'Versions', parent: 'versions',
    state: saved ? 'done' : changed ? 'changed' : 'todo',
    note: saved ? `saved as ${loaded!.name}`
      : changed ? `unsaved changes to ${loaded!.name}`
      : complete ? 'this specification is not saved'
      : 'nothing to save yet',
  })

  const mode: WorkingMode = !loaded ? 'none'
    : specEdited ? 'edited'
    : drifted ? 'drifted'
    : 'clean'

  // Exactly one thing to do next, in the order the work happens. A checklist
  // that reports state without saying what it wants leaves the reader to work it
  // out from eight dots.
  const required = stages.filter((s) => !s.optional && s.to !== 'versions')
  const firstTodo = required.find((s) => s.state === 'todo')
  const NEXT_LABEL: Record<string, string> = {
    'pd/explore': 'Select PD variables', 'pd/fit': 'Fit the PD model',
    'lgd/explore': 'Select LGD drivers', 'lgd/fit': 'Fit the LGD model',
    data: 'Review the data',
  }
  const next = mode === 'drifted'
    ? { label: 'Refit and compare', to: 'pd/fit' }
    : firstTodo ? { label: NEXT_LABEL[firstTodo.to] ?? firstTodo.label, to: firstTodo.to }
    : changed > 0 ? { label: 'Save as a new version', to: 'versions' }
    : complete && !loaded ? { label: 'Save this model', to: 'versions' }
    : null

  // WHAT changed, not just how many stages did. The machine already holds both
  // sets; reporting only a count left the reader to open a popover and compare
  // two numbers by eye to work out whether they had forked, edited, or arrived
  // here by accident.
  const diff = loaded ? {
    pd: {
      added: picked.filter((v) => originVars !== null && !originVars.includes(v)),
      removed: (originVars ?? []).filter((v) => !picked.includes(v)),
      from: originVars?.length ?? null, to: picked.length,
    },
    lgd: {
      added: currentLgd.filter((v) => originLgd !== null && !originLgd.includes(v)),
      removed: (originLgd ?? []).filter((v) => !currentLgd.includes(v)),
      from: originLgd?.length ?? null, to: currentLgd.length,
    },
    /** Edited to the point that the fit on screen no longer describes the
     *  specification, so a refit is owed before this can be saved. */
    needsRefit: pdStale || lgdStale,
  } : null

  return {
    stages, loaded, mode, next, complete, pdStale, lgdStale, diff,
    done: stages.filter((s) => s.state === 'done').length,
    changed,
  }
}

/** The dot a PARENT navigation item carries: the least advanced of its stages,
 *  with any change taking precedence. The detail lives on the sub-navigation. */
export function rollUpState(stages: Stage[], parent: string): StageState | null {
  const own = stages.filter((s) => s.parent === parent)
  if (!own.length) return null
  if (own.some((s) => s.state === 'changed')) return 'changed'
  return own.every((s) => s.state === 'done') ? 'done' : 'todo'
}

export const STATE_COLOUR: Record<StageState, string> = {
  done: 'var(--status-good)',
  changed: 'var(--status-serious)',
  todo: 'transparent',
}
