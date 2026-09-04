import { test, expect, type Page } from '@playwright/test'
import { fitViaApi, seedFittedConsumer, seedSavedConsumer, storeStateFor } from './seed'

/** The state contract, executed.
 *
 *  Each test here encodes one sentence of docs/STATE.md as something a
 *  browser can falsify. When one fails, the contract is broken — these are
 *  regression walls for the exact bug classes found in use: recomputation on
 *  navigation, panes disagreeing with their lists, silent substitutes,
 *  render crashes taking down the app.
 */

const COMPUTE = /\/api\/(fit|lgd\/fit|ecl|rollup)$/

function countCompute(page: Page): { calls: string[] } {
  const box = { calls: [] as string[] }
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (COMPUTE.test(u.pathname)) box.calls.push(u.pathname)
  })
  return box
}

async function settle(page: Page, ms = 2000) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(ms)
}

/** Navigate the way a user does: by clicking the stage links, which is
 *  client-side routing. `page.goto` is a full browser reload — a brand-new
 *  app with an empty in-memory query cache — so a lap of gotos would refetch
 *  legitimately and blame the app for the test's own navigation style. */
const NAV: Record<string, string> = {
  data: 'Data', macro: 'Macro', pd: 'PD model', lgd: 'LGD model',
  scenarios: 'Scenarios', versions: 'Versions',
}
async function click(page: Page, stage: string) {
  await page.getByRole('link', { name: NAV[stage], exact: true }).click()
}

test('switching stages costs zero computation once warm', async ({ page }) => {
  await seedFittedConsumer(page)
  // Warm lap: first visit to each surface computes once per identity — that
  // is the contract, not a violation. Wait for the WORK to finish, not a
  // stopwatch: a cold projection outlasts any fixed timeout, and moving on
  // early would blame the next lap for this lap's computation.
  await page.goto('/consumer/pd')
  await page.getByText('Fitted specification').waitFor({ timeout: 90_000 })
  await click(page, 'lgd')
  await page.getByText(/robust standard errors/).waitFor({ timeout: 90_000 })
  await click(page, 'scenarios')
  await page.getByText(/Lifetime ECL/i).waitFor({ timeout: 90_000 })
  await page.waitForLoadState('networkidle')
  for (const s of ['data', 'macro', 'versions']) {
    await click(page, s); await settle(page)
  }
  // Measured lap: every identity is now computed and cached. The contract
  // says navigation is lookups only.
  const box = countCompute(page)
  for (const s of ['data', 'macro', 'pd', 'lgd', 'scenarios', 'versions', 'pd', 'scenarios']) {
    await click(page, s)
    await settle(page, 2500)
  }
  expect(box.calls, `compute fired on navigation: ${box.calls.join(', ')}`).toHaveLength(0)
})

test('editing a saved model prompts to fork; cancelling leaves it untouched', async ({ page }) => {
  // A SAVED model is open. The store guard must intercept any edit with the
  // fork question; cancelling must change nothing.
  const { version } = await seedSavedConsumer(page)
  try {
    await page.goto('/consumer/pd')
    await page.getByText('Fitted specification').waitFor({ timeout: 90_000 })
    await page.locator('button[title="Add to the specification"]').first().click()
    await expect(page.getByText('This creates a new Model ID')).toBeVisible()
    await page.getByRole('button', { name: /Keep viewing/ }).click()
    await expect(page.getByText('This creates a new Model ID')).toHaveCount(0)
    // still the saved model, still its fitted specification — nothing forked
    await expect(page.getByText('Fitted specification')).toBeVisible()
    await expect(page.getByText('Working draft')).toHaveCount(0)
  } finally {
    // the version this test saved is the test's, not the analyst's — a suite
    // run must not leave a model in the user's version list
    await fetch(`http://localhost:8000/api/versions/${version.hash}`, { method: 'DELETE' })
  }
})

test('the LGD pane fits exactly what the candidate list shows', async ({ page }) => {
  await seedFittedConsumer(page)
  await page.goto('/consumer/lgd')
  await settle(page, 4000)
  const list = await page.getByText(/\d+ drivers? in the specification/).first().textContent()
  const n = Number(list?.match(/(\d+) drivers?/)?.[1] ?? -1)
  expect(n).toBeGreaterThanOrEqual(0)
  // every count of "N drivers in the specification" on the page must agree
  const all = await page.getByText(/\d+ drivers? in the specification/).allTextContents()
  const counts = new Set(all.map((t) => t.match(/(\d+) drivers?/)?.[1]))
  expect(counts.size, `list and pane disagree: ${all.join(' | ')}`).toBe(1)
})

test('scenarios without a fitted LGD is a prompt, not a substituted number', async ({ page }) => {
  // seeded PD, deliberately NO severity model: the gate must hold
  await seedFittedConsumer(page)
  await page.addInitScript(() => {
    const raw = JSON.parse(localStorage.getItem('creditiq-ui')!)
    raw.state.fittedLgd.consumer = null
    localStorage.setItem('creditiq-ui', JSON.stringify(raw))
  })
  const box = countCompute(page)
  await page.goto('/consumer/scenarios')
  await settle(page, 3000)
  await expect(page.getByText('The severity model is not fitted')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fit the LGD model' })).toBeVisible()
  expect(box.calls.filter((c) => c.endsWith('/ecl'))).toHaveLength(0)
})

test('a null statistic renders an em dash, never a white screen', async ({ page }) => {
  await seedFittedConsumer(page)
  await page.goto('/consumer/pd')
  // the seed guarantees a fitted model, so the tab MUST appear — its absence
  // would itself be a bug, not a reason to skip
  const tab = page.getByRole('tab', { name: 'Backtesting', exact: true })
  await tab.waitFor({ timeout: 90_000 })
  await tab.click()
  await settle(page, 3000)
  // vintage segmentation exercises the null-AUC path on thin segments
  const sel = page.locator('select').filter({ has: page.locator('option[value="vintage"]') }).first()
  if (await sel.count()) {
    await sel.selectOption('vintage')
    await settle(page, 4000)
  }
  await expect(page.locator('main')).not.toBeEmpty()
  await expect(page.getByText('This view hit an error')).toHaveCount(0)
})

test('start from scratch clears every draft, and it STAYS cleared', async ({ page }) => {
  // The bug this walls off: deleting the storage key while the app runs is a
  // race — the store writes itself back on the next state change, and the
  // "cleared" workspace resurrects on reload. The in-app reset must close
  // that valve. State is planted by hand (not addInitScript, which re-runs
  // on every load and would replant it after the reset).
  const { fit, lgd } = await fitViaApi()
  await page.goto('/consumer/data')
  await page.evaluate(
    (s) => localStorage.setItem('creditiq-ui', JSON.stringify(s)),
    storeStateFor(fit, lgd))
  await page.goto('/consumer/pd')
  await page.getByText('Fitted specification').waitFor({ timeout: 90_000 })
  page.on('dialog', (d) => d.accept())
  await page.getByRole('button', { name: /Jump to/ }).click()
  await page.getByPlaceholder(/Jump to/).fill('scratch')
  await page.keyboard.press('Enter')
  // sit past several poll ticks — the exact window the race lived in
  await page.waitForTimeout(4000)
  const state = await page.evaluate(() => {
    const raw = localStorage.getItem('creditiq-ui')
    return raw ? JSON.parse(raw).state : null
  })
  expect(state?.fitted?.consumer ?? null).toBeNull()
  expect(state?.fittedLgd?.consumer ?? null).toBeNull()
  // and the surface agrees: nothing fitted anywhere on this book
  await page.goto('/consumer/pd')
  await expect(page.getByText('Fitted specification')).toHaveCount(0)
})

test('the roll-up covers only reported books and never shows a default spec', async ({ page }) => {
  await page.goto('/rollup')
  await settle(page, 5000)
  await expect(page.getByText(/documented default|default spec/i)).toHaveCount(0)
  const uncovered = await page.getByText('no model promoted').count()
  // Two honest states. With NOTHING promoted anywhere there are no totals to
  // be excluded from, and the page says so in its empty state instead.
  const nothingPromoted = await page.getByText('No book has a promoted model yet').count()
  if (uncovered > 0 && nothingPromoted === 0) {
    await expect(page.getByText(/not included in the totals?/).first()).toBeVisible()
  }
})
