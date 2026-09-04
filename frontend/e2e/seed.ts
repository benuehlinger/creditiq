import type { Page } from '@playwright/test'

/** Build a known model via the API and plant it in the browser store, so
 *  every test starts from a REPRODUCIBLE state instead of whatever the last
 *  human left behind. The server's disk cache makes the fits near-instant
 *  after the first suite run. */

const API = 'http://localhost:8000/api'

const PD_SPEC = {
  portfolio: 'consumer',
  variables: [
    { column: 'fico_orig', treatment: 'woe' },
    { column: 'dti', treatment: 'woe' },
  ],
  mevs: [{ key: 'unemployment_rate', transform: 'level', lag_months: 0 }],
  lgd: { drivers: ['fico_orig'], categoricals: [] },
}

export async function fitViaApi() {
  const fit = await (await fetch(`${API}/fit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PD_SPEC),
  })).json()
  const lgd = await (await fetch(`${API}/lgd/fit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ portfolio: 'consumer', ...PD_SPEC.lgd }),
  })).json()
  return { fit, lgd }
}

/** Plant the fitted state before the app boots, the way a returning user's
 *  persisted store would carry it. */
export async function seedFittedConsumer(page: Page) {
  const { fit, lgd } = await fitViaApi()
  const state = {
    state: {
      theme: 'light',
      fitted: { consumer: {
        request: PD_SPEC, hash: fit.hash, name: fit.name, pdHash: fit.pd_hash,
        fittedAt: new Date().toISOString(),
        variablesAtFit: PD_SPEC.variables.map((v) => v.column),
      }, mortgage: null, cre: null },
      fittedLgd: { consumer: {
        spec: lgd.spec, hash: lgd.hash, name: lgd.name,
        fittedAt: new Date().toISOString(),
        meanLgd: lgd.mean_lgd, nDefaults: lgd.n_defaults,
        rmse: lgd.diagnostics.rmse,
        bias: lgd.diagnostics.mean_predicted - lgd.diagnostics.mean_actual,
        devianceR2: lgd.diagnostics.deviance_r2,
      }, mortgage: null, cre: null },
      loaded: { consumer: null, mortgage: null, cre: null },
      draft: { consumer: null, mortgage: null, cre: null },
      projected: { consumer: null, mortgage: null, cre: null },
      // The tray must SHOW the fitted specification, or the state machine
      // correctly reports the fit stale against a different draft.
      pdSpec: { consumer: {
        variables: PD_SPEC.variables.map((v) => ({
          column: v.column, treatment: v.treatment, maxBins: 8, nKnots: 4 })),
        mevs: ['unemployment_rate@level@0'],
        estimator: 'logistic', ootFrom: '2023-01-01', downsample: null,
      } },
      brandVariant: 'rule',
    },
    version: 4,
  }
  await page.addInitScript((s) => {
    localStorage.setItem('creditiq-ui', JSON.stringify(s))
  }, state)
  return { fit, lgd }
}

/** The same model, but SAVED as a version and opened, the way an analyst who
 *  named a model and came back would find it. This is the state the fork
 *  guard protects; without it that guard is untestable. */
export async function seedSavedConsumer(page: Page) {
  const { fit, lgd } = await seedFittedConsumer(page)
  let v = await (await fetch(`${API}/versions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...PD_SPEC, with_ecl: false }),
  })).json()
  if (!v?.hash) {
    // already saved on a previous run — find it in the list instead
    const list = await (await fetch(`${API}/versions?portfolio=consumer`)).json()
    v = list.find((x: { hash: string }) => x.hash === fit.hash)
  }
  await page.addInitScript((mark) => {
    const raw = JSON.parse(localStorage.getItem('creditiq-ui')!)
    raw.state.loaded.consumer = mark
    localStorage.setItem('creditiq-ui', JSON.stringify(raw))
  }, { hash: v.hash, name: v.name, status: v.status, loadedAt: new Date().toISOString() })
  return { fit, lgd, version: v }
}
