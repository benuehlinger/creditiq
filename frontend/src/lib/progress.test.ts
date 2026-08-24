import { describe, expect, it } from 'vitest'
import { computeProgress, type ProgressInput } from './progress'

/** Every way through this app, as states rather than clicks.
 *
 *  The flows are numerous enough — build from scratch, open and inspect, open
 *  and edit, clear the tray, drop the drivers, save, replace — that reasoning
 *  about them by clicking is not reliable. The state machine is a pure function
 *  so each one can be written down. */

const EMPTY: ProgressInput = {
  picked: [], fitted: null, lgd: null, loaded: null,
  shortlisted: 0, originVars: null, originLgd: null,
}
const fit = (name: string, hash: string, vars: string[]) =>
  ({ hash, name, variablesAtFit: vars })
const lgdOf = (hash: string, drivers: string[]) =>
  ({ hash, spec: { drivers, categoricals: [] } })
const stage = (r: ReturnType<typeof computeProgress>, to: string) =>
  r.stages.find((s) => s.to === to)!

describe('a book with nothing done', () => {
  it('asks for PD variables and offers nothing to save', () => {
    const r = computeProgress(EMPTY)
    expect(r.mode).toBe('none')
    expect(r.complete).toBe(false)
    expect(r.next?.to).toBe('pd/explore')
    expect(stage(r, 'versions').state).toBe('todo')
  })

  it('does not treat the optional stages as outstanding work', () => {
    const r = computeProgress(EMPTY)
    expect(stage(r, 'macro').optional).toBe(true)
    expect(stage(r, 'scenarios').optional).toBe(true)
    // the next action must never be an optional stage
    expect(['macro', 'scenarios']).not.toContain(r.next?.to)
  })
})

describe('building a model from scratch', () => {
  it('walks PD explore, PD fit, LGD explore, LGD fit, then save', () => {
    let s: ProgressInput = { ...EMPTY, picked: ['fico_orig'] }
    expect(computeProgress(s).next?.to).toBe('pd/fit')

    s = { ...s, fitted: fit('a', 'h1', ['fico_orig']) }
    expect(computeProgress(s).next?.to).toBe('lgd/explore')

    s = { ...s, lgd: { hash: '', spec: { drivers: ['current_ltv'], categoricals: [] } } }
    expect(computeProgress(s).next?.to).toBe('lgd/fit')

    s = { ...s, lgd: lgdOf('L1', ['current_ltv']) }
    const r = computeProgress(s)
    expect(r.complete).toBe(true)
    expect(r.next?.to).toBe('versions')
    expect(r.next?.label).toMatch(/save/i)
  })
})

describe('clearing every candidate', () => {
  const base: ProgressInput = {
    ...EMPTY, picked: ['fico_orig', 'dti'],
    fitted: fit('a', 'h1', ['fico_orig', 'dti']), lgd: lgdOf('L1', ['current_ltv']),
  }

  it('marks the PD fit outstanding rather than complete', () => {
    // The fit used to survive an emptied tray, so the panel reported a complete
    // PD model with nothing selected and offered to save a specification the API
    // refuses.
    const r = computeProgress({ ...base, picked: [] })
    expect(stage(r, 'pd/explore').state).toBe('todo')
    expect(stage(r, 'pd/fit').state).toBe('todo')
    expect(r.complete).toBe(false)
    expect(r.next?.to).toBe('pd/explore')
  })

  it('says why, rather than only showing a hollow dot', () => {
    const r = computeProgress({ ...base, picked: [] })
    expect(stage(r, 'pd/fit').note).toMatch(/refit/i)
  })

  it('also catches a tray that merely drifted from the fit', () => {
    const r = computeProgress({ ...base, picked: ['fico_orig'] })
    expect(r.pdStale).toBe(true)
    expect(r.complete).toBe(false)
    expect(stage(r, 'pd/fit').note).toMatch(/no longer matches/i)
  })
})

describe('dropping every LGD driver', () => {
  it('marks the LGD fit outstanding', () => {
    const r = computeProgress({
      ...EMPTY, picked: ['fico_orig'], fitted: fit('a', 'h1', ['fico_orig']),
      lgd: lgdOf('L1', []),
    })
    expect(r.lgdStale).toBe(true)
    expect(stage(r, 'lgd/fit').state).toBe('todo')
    expect(r.complete).toBe(false)
    expect(r.next?.to).toBe('lgd/explore')
  })
})

describe('opening a saved version', () => {
  const opened: ProgressInput = {
    ...EMPTY, picked: ['fico_orig'], fitted: fit('saved', 'V1', ['fico_orig']),
    lgd: lgdOf('L1', ['current_ltv']), loaded: { hash: 'V1', name: 'saved' },
    originVars: ['fico_orig'], originLgd: ['current_ltv'],
  }

  it('reads as unmodified when nothing has been touched', () => {
    const r = computeProgress(opened)
    expect(r.mode).toBe('clean')
    expect(r.changed).toBe(0)
    expect(stage(r, 'versions').state).toBe('done')
    expect(r.next).toBeNull()
  })

  it('reads as EDITED, not as an error, once something changes', () => {
    // These two used to raise the same red warning. Editing an opened model is
    // the normal way to build a challenger.
    const r = computeProgress({
      ...opened, picked: ['fico_orig', 'dti'],
      fitted: fit('new', 'V2', ['fico_orig', 'dti']),
    })
    expect(r.mode).toBe('edited')
    expect(r.changed).toBeGreaterThan(0)
    expect(r.next?.to).toBe('versions')
  })

  it('reads as DRIFTED when nothing changed and the replay disagrees', () => {
    const r = computeProgress({ ...opened, fitted: fit('other', 'V9', ['fico_orig']) })
    expect(r.mode).toBe('drifted')
    expect(r.next?.label).toMatch(/refit/i)
  })

  it('does not call a slow origin fetch a drift', () => {
    // originVars null means the saved specification has not arrived yet.
    const r = computeProgress({ ...opened, originVars: null, originLgd: null,
                                fitted: fit('other', 'V9', ['fico_orig']) })
    expect(r.mode).not.toBe('drifted')
  })

  it('stops calling Versions complete once the work is unsaved', () => {
    // It used to mark done when a version was OPENED, which is backwards.
    const r = computeProgress({
      ...opened, picked: ['fico_orig', 'dti'],
      fitted: fit('new', 'V2', ['fico_orig', 'dti']),
    })
    expect(stage(r, 'versions').state).toBe('changed')
    expect(stage(r, 'versions').note).toMatch(/unsaved/i)
  })
})

describe('the next action', () => {
  it('is never more than one thing', () => {
    const cases: ProgressInput[] = [
      EMPTY,
      { ...EMPTY, picked: ['a'] },
      { ...EMPTY, picked: ['a'], fitted: fit('x', 'h', ['a']) },
      { ...EMPTY, picked: ['a'], fitted: fit('x', 'h', ['a']), lgd: lgdOf('L', ['b']) },
    ]
    for (const c of cases) {
      const r = computeProgress(c)
      expect(r.next === null || typeof r.next.label === 'string').toBe(true)
    }
  })

  it('always points at a stage that exists', () => {
    const r = computeProgress({ ...EMPTY, picked: ['a'] })
    expect(r.stages.map((s) => s.to)).toContain(r.next!.to)
  })
})

describe('what changed since the version was opened', () => {
  // Opened a saved model with two PD variables and one LGD driver.
  const opened: ProgressInput = {
    ...EMPTY,
    picked: ['fico_orig', 'dti'],
    fitted: fit('hardy-pergola-22', 'h1', ['fico_orig', 'dti']),
    lgd: lgdOf('L1', ['current_ltv']),
    loaded: { hash: 'h1', name: 'hardy-pergola-22' },
    originVars: ['fico_orig', 'dti'],
    originLgd: ['current_ltv'],
  }

  it('reports nothing changed when nothing has', () => {
    const r = computeProgress(opened)
    expect(r.mode).toBe('clean')
    expect(r.diff?.pd.added).toEqual([])
    expect(r.diff?.pd.removed).toEqual([])
    expect(r.diff?.lgd.added).toEqual([])
  })

  it('names the variable added to PD, not just a count of stages', () => {
    // The bar said "edited in 3 stages", which counts stages rather than
    // changes: adding one PD variable marks PD explore AND PD fit as changed.
    // Someone returning to the screen could not tell what they had done.
    const r = computeProgress({
      ...opened,
      picked: ['fico_orig', 'dti', 'foreclosure_referral_flag'],
      fitted: fit('hardy-pergola-22', 'h1',
                  ['fico_orig', 'dti', 'foreclosure_referral_flag']),
    })
    expect(r.mode).toBe('edited')
    expect(r.diff?.pd.added).toEqual(['foreclosure_referral_flag'])
    expect(r.diff?.pd.removed).toEqual([])
    expect(r.diff?.pd.from).toBe(2)
    expect(r.diff?.pd.to).toBe(3)
    // Two stages read as changed for ONE edit — which is why a count misleads.
    expect(r.changed).toBeGreaterThan(r.diff!.pd.added.length)
  })

  it('names a removed variable too, and reports both sides at once', () => {
    const r = computeProgress({
      ...opened,
      picked: ['fico_orig'],
      fitted: fit('hardy-pergola-22', 'h1', ['fico_orig']),
      lgd: lgdOf('L2', ['current_ltv', 'hpi@yoy@3']),
    })
    expect(r.diff?.pd.removed).toEqual(['dti'])
    expect(r.diff?.pd.added).toEqual([])
    expect(r.diff?.lgd.added).toEqual(['hpi@yoy@3'])
  })

  it('flags a refit owed when the fit no longer matches the specification', () => {
    // Variables changed but the fit was not re-run: what would be saved is not
    // what the screen shows.
    const r = computeProgress({ ...opened, picked: ['fico_orig', 'dti', 'ltv_orig'] })
    expect(r.diff?.needsRefit).toBe(true)
    expect(r.diff?.pd.added).toEqual(['ltv_orig'])
  })

  it('has no diff to report when no version was opened', () => {
    expect(computeProgress({ ...EMPTY, picked: ['fico_orig'] }).diff).toBeNull()
  })
})
