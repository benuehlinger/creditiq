import { defineConfig } from '@playwright/test'

/** End-to-end tests: the layer where this application's real bugs lived.
 *
 *  The backend suite tests the mathematics; the frontend suite tests the
 *  state machine's logic. Neither can see a tab switch refitting a model, a
 *  pane fitting a different spec than its list shows, or a null crashing a
 *  render — the bug classes actually found in use. These tests drive the
 *  running app in a real browser and assert the STATE CONTRACT (docs/
 *  STATE.md), request counts included.
 *
 *  They run against the dev servers (`make dev` first), read-only where
 *  possible, and snapshot/restore browser state where not.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  retries: 0,
  workers: 1,               // the app under test is one shared instance
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
  },
})
