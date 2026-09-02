import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey } from './api'
import { NONE, useUi } from './store'
import { canonical, columns, fromRequest } from './spec'

export type StageState = 'done' | 'changed' | 'todo'

/** One link in the chain that hangs off the specification.
 *
 *  `absent` was never produced, `current` matches what it was built from,
 *  `stale` exists but no longer describes the specification on screen. */
export type Link = 'absent' | 'current' | 'stale'

export interface Stage {
  /** Where the stage lives. Two stages can share a route: the PD workbench
   *  holds both variable selection and the fit. */
  to: string
  /** A stable identifier, distinct from the route, so a stage can be found
   *  after its route changes. Defaults to `to`. */
  id?: string
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
/** A specification reduced to a stable string, for comparing two of them.
 *
 *  Order-insensitive where order carries no meaning: reordering the variable
 *  list is not a different model, but changing a variable's TREATMENT is. This
 *  is what makes a change detectable at all — comparing the fitted hash cannot
 *  distinguish "not yet refitted" from "the data moved", and comparing column
 *  NAMES misses everything about how those columns are built. */
export function canonicalSpec(req: unknown): string {
  // Route the saved REQUEST through the same reader and the same canonical form
  // the working specification uses. There were two hand-written canonicalisers
  // over two shapes — they listed the same fields in different orders, so they
  // could never produce the same string, and every fit was reported stale the
  // instant it finished. One function, used twice, cannot drift from itself.
  return canonical(fromRequest(req as Record<string, unknown>, ''))
}

export interface ProgressInput {
  picked: string[]
  /** `specAtFit` is the canonical specification the fit was RUN on. Comparing
   *  it against the one on screen is what catches a treatment or binning change
   *  — the column names alone do not move when a variable is rebinned, so a
   *  rebin used to leave the PD stage claiming it was up to date. */
  fitted: { hash: string; name: string; variablesAtFit: string[]
            specAtFit?: string } | null
  /** The canonical specification currently on screen. */
  specNow?: string
  lgd: { hash: string; spec: { drivers: string[]; categoricals: string[] } } | null
  /** `pdHash:lgdHash` of the model this book was last projected on. */
  projected?: string | null
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
  const shortlist = useUi((s) => (pk ? s.macroShortlist[pk] : null))
  // One specification object, so "what is selected" and "what would be fitted"
  // can no longer disagree — they are the same thing read two ways.
  const pdSpec = useUi((s) => (pk ? s.pdSpec[pk] : undefined))
  const projected = useUi((s) => (pk ? s.projected?.[pk] ?? null : null))
  const picked = pdSpec ? columns(pdSpec) : (NONE as string[])
  const specNow = pdSpec ? canonical(pdSpec) : undefined

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
    picked,
    fitted: fitted ? { hash: fitted.hash, name: fitted.name,
                       variablesAtFit: fitted.variablesAtFit,
                       specAtFit: canonicalSpec(fitted.request) } : null,
    specNow,
    lgd: lgd ? { hash: lgd.hash, spec: lgd.spec } : null,
    projected,
    loaded: loaded ? { hash: loaded.hash, name: loaded.name } : null,
    shortlisted: (shortlist?.pd.length ?? 0) + (shortlist?.lgd.length ?? 0),
    originVars: spec ? (spec.variables ?? []).map((v: any) => v.column) : null,
    originLgd: spec ? [...(spec.lgd?.drivers ?? []),
                       ...(spec.lgd?.categoricals ?? [])] : null,
  })
}

export function computeProgress(inp: ProgressInput) {
  const { picked, fitted, lgd, loaded, shortlisted, originVars, originLgd,
          specNow, projected } = inp
  const currentLgd = lgd ? [...lgd.spec.drivers, ...lgd.spec.categoricals] : []

  // A fit is a RESULT, and the tray is the draft specification. Once they
  // diverge the fit no longer describes what is on screen: clearing every
  // variable left `fitted` in place, so the panel reported the PD model complete
  // with nothing selected, and offered to save a specification the API refuses.
  const pdStale = !!fitted && (
    picked.length === 0
    || fitted.variablesAtFit.length !== picked.length
    || fitted.variablesAtFit.some((v) => !picked.includes(v))
    // Everything the names do not carry: treatments, bin edges, spline knots,
    // the estimator, the out-of-time boundary, the macro terms.
    || (!!fitted.specAtFit && !!specNow && fitted.specAtFit !== specNow))
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

  // ── the dependency chain ────────────────────────────────────────────────
  //
  // The specification is the source. Everything else is DERIVED from it and,
  // in order, from each other: a fit is produced from the specification, a
  // projection from the fit, a saved version records both. So a change to the
  // specification does not invalidate one thing. It invalidates everything
  // downstream, and getting clean again is a sequence: refit, reproject, save.
  //
  // Each link is current only when its own record matches what it was built
  // from AND every link above it is current. That second clause is the whole
  // point. Without it a projection kept reporting itself current while sitting
  // on a fit the specification had already moved past: the scenarios marker
  // stayed green after a rebinning, because the projection still matched the
  // hash of the stale fit it was built on.
  const fitLink: Link = !fitted || !lgd?.hash ? 'absent'
    : pdStale || lgdStale ? 'stale'
    : 'current'
  const projectionLink: Link = !projected ? 'absent'
    : fitLink !== 'current' ? 'stale'
    : projected !== `${fitted!.hash}:${lgd!.hash}` ? 'stale'
    : 'current'
  const savedLink: Link = !loaded ? 'absent'
    : fitLink !== 'current' || specEdited || drifted ? 'stale'
    : 'current'

  const stages: Stage[] = [
    { to: 'data', label: 'Data', parent: 'data', state: 'done' },
    {
      // Optional: a model can take the catalogue's level terms without ever
      // opening the search. An empty one is a choice, not an outstanding task.
      to: 'macro', label: 'Macro', parent: 'macro', optional: true,
      state: shortlisted > 0 ? 'done' : 'todo',
      note: shortlisted > 0 ? `${shortlisted} terms shortlisted`
                            : 'optional, none shortlisted',
    },
    {
      to: 'pd', id: 'pd/explore', label: 'PD variables', parent: 'pd',
      state: !picked.length ? 'todo'
        : originVars && !sameSet(originVars, picked) ? 'changed' : 'done',
      note: picked.length ? `${picked.length} variables selected` : 'no variables selected',
    },
    {
      to: 'pd', id: 'pd/fit', label: 'PD fit', parent: 'pd',
      state: !fitted || pdStale ? 'todo'
        : specEdited || drifted ? 'changed' : 'done',
      note: !fitted ? 'not fitted'
        : picked.length === 0 ? 'no variables selected. Refit needed'
        : pdStale ? `PD ${fitted.hash} no longer matches the specification`
        : `PD ${fitted.hash}`,
    },
    {
      to: 'lgd', id: 'lgd/explore', label: 'LGD drivers', parent: 'lgd',
      state: !currentLgd.length ? 'todo'
        : originLgd && !sameSet(originLgd, currentLgd) ? 'changed' : 'done',
      note: currentLgd.length ? `${currentLgd.length} drivers selected` : 'no drivers selected',
    },
    {
      to: 'lgd', id: 'lgd/fit', label: 'LGD fit', parent: 'lgd',
      state: !lgd?.hash || lgdStale ? 'todo' : 'done',
      note: !lgd?.hash ? 'not fitted'
        : lgdStale ? 'no drivers selected. Refit needed' : 'fitted',
    },
    {
      // Done means RUN, the way it does on every other stage. Being able to
      // project is not the same as having projected, and this stage used to
      // report the first while every other reported the second.
      // Done means RUN, the way it does on every other stage, and it cannot be
      // reached while anything upstream is outstanding.
      to: 'scenarios', label: 'Scenarios', parent: 'scenarios', optional: true,
      state: projectionLink === 'current' ? 'done'
        : projectionLink === 'stale' ? 'changed'
        : 'todo',
      note: fitLink === 'absent' ? 'needs both models'
        : fitLink === 'stale' ? 'the specification changed. Refit, then project'
        : projectionLink === 'absent' ? 'not projected yet'
        : projectionLink === 'stale' ? 'the model changed since this was projected'
        : 'projected',
    },
  ]

  // Versions is complete when the specification ON SCREEN is saved — not when a
  // saved one has been opened. Opening a version and then editing it left this
  // green while the work was unsaved, which is exactly backwards.
  // Specification stages only. A projection that the model has moved on from is
  // a stale OUTPUT, not an unsaved change to what would be written, so counting
  // it here claimed unsaved edits against a version nobody had opened, and the
  // note below then dereferenced a null `loaded`.
  const changed = stages.filter((s) => s.state === 'changed'
    && s.parent !== 'scenarios').length
  // Saveable, not merely fitted: a stale fit cannot be saved, because what would
  // be written is not what the screen shows.
  const complete = !!fitted && !pdStale && !!lgd?.hash && !lgdStale
  const saved = savedLink === 'current' && changed === 0
  stages.push({
    to: 'versions', label: 'Versions', parent: 'versions',
    state: saved ? 'done' : changed ? 'changed' : 'todo',
    note: saved && loaded ? `saved as ${loaded.name}`
      : changed ? (loaded ? `unsaved changes to ${loaded.name}`
                          : 'unsaved changes')
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
  // Drift gets no special call to action. A drifted model has ALREADY been
  // refitted — that divergent refit is what drift is — so "Refit and compare"
  // pointed at an action that reproduces the same divergence and never exits.
  // The changed count below already routes it to "Save as a new version",
  // which is the way out: keep the record, save what the data now produces.
  const next = firstTodo ? { label: NEXT_LABEL[firstTodo.id ?? firstTodo.to] ?? firstTodo.label,
                    to: firstTodo.to }
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
    // The chain, so a caller can name the next thing to redo rather than
    // recomputing what "out of date" means for itself.
    chain: { fit: fitLink, projection: projectionLink, saved: savedLink },
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

/** The same roll-up, WITH the note from the stage that decided it.
 *
 *  The navigation used to caption every dot from a table of three generic
 *  strings, so an amber Scenarios dot said "Changed since the saved model was
 *  opened" when no model had been opened and what had actually happened was a
 *  specification edit two stages upstream. Each stage already computes an
 *  accurate note; this hands it over instead of throwing it away. */
export function rollUpSummary(stages: Stage[], parent: string):
    { state: StageState; note?: string } | null {
  const own = stages.filter((s) => s.parent === parent)
  if (!own.length) return null
  const decisive = own.find((s) => s.state === 'changed')
    ?? own.find((s) => s.state === 'todo')
    ?? own[own.length - 1]
  return { state: rollUpState(stages, parent)!, note: decisive.note }
}

export const STATE_COLOUR: Record<StageState, string> = {
  done: 'var(--status-good)',
  changed: 'var(--status-serious)',
  todo: 'transparent',
}

/**
 * What state each book is in, for the portfolio switcher.
 *
 * The answer to "what if someone starts a model and moves to another book".
 * Nothing is lost — the specification is per book and it is persisted — but
 * until now nothing said so, so leaving a half-built model looked the same as
 * never having started one. Every book now states its own state on the tab.
 *
 * This is deliberately NOT `useProgress` run three times: that hook fetches the
 * opened version to compute a specification diff, and doing that for two books
 * the user is not looking at costs three round trips to draw three dots.
 */
export type BookState = 'empty' | 'draft' | 'fitted' | 'open'

export interface BookStatus {
  state: BookState
  /** Plain words for the tab tooltip. */
  note: string
}

export function useBookStates(): Record<PortfolioKey, BookStatus> {
  const pdSpec = useUi((s) => s.pdSpec)
  const fitted = useUi((s) => s.fitted)
  const fittedLgd = useUi((s) => s.fittedLgd)
  const loaded = useUi((s) => s.loaded)

  const out = {} as Record<PortfolioKey, BookStatus>
  for (const p of ['consumer', 'mortgage', 'cre'] as PortfolioKey[]) {
    const open = loaded[p]
    if (open) {
      out[p] = { state: 'open', note: `${open.name} is open on this book.` }
      continue
    }
    const nPd = pdSpec[p] ? columns(pdSpec[p]).length : 0
    const nLgd = fittedLgd[p]
      ? fittedLgd[p]!.spec.drivers.length + fittedLgd[p]!.spec.categoricals.length : 0
    const pdDone = !!fitted[p]
    const lgdDone = !!fittedLgd[p]?.hash
    if (pdDone && lgdDone) {
      out[p] = { state: 'fitted', note: 'PD and LGD are both fitted here, not yet saved.' }
    } else if (nPd || nLgd || pdDone || lgdDone) {
      const has = [pdDone ? 'a fitted PD model' : nPd ? `${nPd} PD variables selected` : null,
                   lgdDone ? 'a fitted LGD model' : nLgd ? `${nLgd} LGD drivers selected` : null]
        .filter(Boolean).join(' and ')
      out[p] = { state: 'draft', note: `Work in progress: ${has}. It is kept.` }
    } else {
      out[p] = { state: 'empty', note: 'No work started on this book.' }
    }
  }
  return out
}

/**
 * The name and hash of the model on screen.
 *
 * A model is a PD specification together with an LGD specification, so its
 * identity depends on both. Components that read `fitted.name` directly report
 * the PD half only: the scenario stage labelled a loss figure produced by both
 * models with the PD name, one row below the bar showing the Model ID, so the
 * same model appeared under two names at once.
 *
 * Returns nulls until both halves are fitted, which is the same condition the
 * bar uses to withhold an identifier.
 */
export function useModelIdentity(portfolio: string | undefined) {
  const pk = portfolio as PortfolioKey
  const fitted = useUi((s) => (pk ? s.fitted[pk] : null))
  const lgd = useUi((s) => (pk ? s.fittedLgd[pk] : null))

  const request = fitted ? { ...fitted.request, lgd: lgd?.spec ?? null } : null
  const q = useQuery({
    queryKey: ['identity', portfolio, fitted?.hash, lgd?.hash],
    queryFn: () => api.identity(request as never),
    enabled: !!request,
  })
  return {
    name: q.data?.name ?? null,
    hash: q.data?.hash ?? null,
    complete: !!fitted && !!lgd?.hash,
  }
}
