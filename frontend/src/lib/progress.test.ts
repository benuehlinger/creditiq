import { describe, expect, it } from 'vitest'
import { computeProgress, type ProgressInput, canonicalSpec } from './progress'
import { canonical, columns, fromRequest, toRequest, type PdSpec } from './spec'

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
const stage = (r: ReturnType<typeof computeProgress>, id: string) =>
  r.stages.find((s) => (s.id ?? s.to) === id)!

describe('a book with nothing done', () => {
  it('asks for PD variables and offers nothing to save', () => {
    const r = computeProgress(EMPTY)
    expect(r.mode).toBe('none')
    expect(r.complete).toBe(false)
    expect(r.next?.to).toBe('pd')
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
    expect(computeProgress(s).next?.to).toBe('pd')

    s = { ...s, fitted: fit('a', 'h1', ['fico_orig']) }
    expect(computeProgress(s).next?.to).toBe('lgd')

    s = { ...s, lgd: { hash: '', spec: { drivers: ['current_ltv'], categoricals: [] } } }
    expect(computeProgress(s).next?.to).toBe('lgd')

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
    expect(r.next?.to).toBe('pd')
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
    expect(r.next?.to).toBe('lgd')
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
    // Drift means the divergent refit already ran, so "refit" is not a way
    // out — refitting reproduces the same divergence. The exit is to save
    // what the data now produces as a new version (or close the record).
    expect(r.next?.label).toMatch(/save/i)
    expect(r.next?.to).toBe('versions')
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

describe('a rebin is a change', () => {
  const req = (treatment: string, edges?: number[]) => ({
    portfolio: 'mortgage',
    variables: [{ column: 'current_ltv', treatment, edges }],
    mevs: [{ key: 'unemployment_rate' }],
    estimator: 'logistic', oot_from: '2023-01-01',
  })

  it('detects a treatment change that leaves the column names identical', () => {
    // The bug: PD recorded only the column NAMES at fit time, so rebinning a
    // variable or switching it from WoE to a spline changed nothing it could
    // see. The stage reported itself up to date while showing a fit of a
    // different specification.
    const woe = canonicalSpec(req('woe'))
    const spline = canonicalSpec(req('spline'))
    expect(woe).not.toBe(spline)

    const base: ProgressInput = {
      ...EMPTY, picked: ['current_ltv'],
      fitted: { ...fit('a', 'h1', ['current_ltv']), specAtFit: woe },
      specNow: spline,
    }
    expect(computeProgress(base).pdStale).toBe(true)
    expect(stage(computeProgress(base), 'pd/fit').state).toBe('todo')
  })

  it('detects a change to the bin edges alone', () => {
    const five = canonicalSpec(req('bins', [40, 60, 80]))
    const four = canonicalSpec(req('bins', [40, 70]))
    expect(five).not.toBe(four)
  })

  it('does not fire when nothing changed', () => {
    const spec = canonicalSpec(req('woe'))
    const r = computeProgress({
      ...EMPTY, picked: ['current_ltv'],
      fitted: { ...fit('a', 'h1', ['current_ltv']), specAtFit: spec },
      specNow: spec,
    })
    expect(r.pdStale).toBe(false)
  })

  it('ignores the ORDER of variables and macro terms', () => {
    const a = canonicalSpec({ variables: [{ column: 'x' }, { column: 'y' }],
                              mevs: [{ key: 'u' }, { key: 'v' }] })
    const b = canonicalSpec({ variables: [{ column: 'y' }, { column: 'x' }],
                              mevs: [{ key: 'v' }, { key: 'u' }] })
    expect(a).toBe(b)
  })
})

/**
 * The round trip. A specification that has just been fitted must NOT report
 * itself out of date.
 *
 * This is a regression test for a bug that made the whole staleness signal
 * useless: `canonicalSpec` (over the saved request) and `canonical` (over the
 * working specification) were two hand-written functions listing the same
 * fields in different orders. They could never produce the same string, so a
 * model reported "the PD specification changed" the instant it finished
 * fitting, and a REAL change was indistinguishable from that noise.
 *
 * The test asserts the property, not the implementation: whatever the canonical
 * form is, a specification must survive `toRequest` and come back equal.
 */
describe('specification round trip', () => {
  const spec: PdSpec = {
    variables: [
      { column: 'fico_orig', treatment: 'bins', maxBins: 7, nKnots: 4 },
      { column: 'dti', treatment: 'spline', knots: [12, 24, 36], maxBins: 8, nKnots: 3 },
      { column: 'interest_rate', treatment: 'woe', edges: [4.5, 9], maxBins: 3, nKnots: 4 },
    ],
    mevs: ['unemployment_rate@level@0', 'real_disp_income_growth@yoy@3'],
    estimator: 'logistic', ootFrom: '2023-01-01', downsample: null,
  }

  it('survives the wire unchanged', () => {
    const req = toRequest(spec, 'consumer', null)
    expect(canonical(fromRequest(req as never, 'consumer'))).toBe(canonical(spec))
  })

  it('reports a freshly fitted specification as current, not stale', () => {
    const req = toRequest(spec, 'consumer', null)
    const p = computeProgress({
      picked: columns(spec),
      fitted: { hash: 'h', name: 'n', variablesAtFit: columns(spec),
                specAtFit: canonicalSpec(req) },
      specNow: canonical(spec),
      lgd: null, loaded: null, shortlisted: 0, originVars: null, originLgd: null,
    })
    expect(p.pdStale).toBe(false)
  })

  it('still catches a rebinning, which the column names do not carry', () => {
    const req = toRequest(spec, 'consumer', null)
    const rebinned = { ...spec, variables: spec.variables.map((v) =>
      v.column === 'fico_orig' ? { ...v, maxBins: 5 } : v) }
    const p = computeProgress({
      picked: columns(rebinned),
      fitted: { hash: 'h', name: 'n', variablesAtFit: columns(spec),
                specAtFit: canonicalSpec(req) },
      specNow: canonical(rebinned),
      lgd: null, loaded: null, shortlisted: 0, originVars: null, originLgd: null,
    })
    expect(p.pdStale).toBe(true)
  })
})

/**
 * The scenarios marker means RUN, not RUNNABLE.
 *
 * It used to turn green as soon as both halves were fitted, while its own note
 * read "ready to project". Green meant "you could do this" on that one stage
 * and "this is done" on every other, so the same mark carried two opposite
 * meanings on one screen.
 */
describe('scenarios stage', () => {
  const both = {
    ...EMPTY,
    picked: ['fico_orig'],
    fitted: { hash: 'pd1', name: 'a-model-01', variablesAtFit: ['fico_orig'] },
    lgd: { hash: 'lgd1', spec: { drivers: ['cltv'], categoricals: [] } },
  }
  const scen = (inp: ProgressInput) =>
    computeProgress(inp).stages.find((s) => s.to === 'scenarios')!

  it('is outstanding when both models are fitted but nothing has been projected', () => {
    expect(scen(both).state).toBe('todo')
    expect(scen(both).note).toBe('not projected yet')
  })

  it('is done once THAT model has been projected', () => {
    expect(scen({ ...both, projected: 'pd1:lgd1' }).state).toBe('done')
  })

  it('is changed when the model moved on from what was projected', () => {
    const s = scen({ ...both, projected: 'pd0:lgd1' })
    expect(s.state).toBe('changed')
    expect(s.note).toBe('the model changed since this was projected')
  })

  it('is outstanding when a half is missing and nothing was projected', () => {
    expect(scen({ ...both, lgd: null }).state).toBe('todo')
    expect(scen({ ...both, lgd: null }).note).toBe('needs both models')
  })

  it('reads as invalidated, not unstarted, when a projection survives a missing half', () => {
    // A projection WAS produced and the model underneath it is now incomplete.
    // That is a different situation from never having run one, and it is the
    // cascade doing its job: nothing downstream of an absent fit is current.
    const s = scen({ ...both, lgd: null, projected: 'pd1:lgd1' })
    expect(s.state).toBe('changed')
    expect(s.note).toBe('needs both models')
  })

  it('goes stale when the SPECIFICATION changes, before any refit', () => {
    // The case that was wrong. The projection still matches the hash of the fit
    // it was built on, because that fit has not been re-run; what moved is the
    // specification underneath it. Comparing only against the fit hash left
    // this green on top of a dirty specification.
    const s = scen({
      ...both, projected: 'pd1:lgd1',
      picked: ['fico_orig', 'dti'],                 // a variable was added
      fitted: { ...both.fitted!, variablesAtFit: ['fico_orig'] },
    })
    expect(s.state).toBe('changed')
    expect(s.note).toBe('the specification changed. Refit, then project')
  })
})
