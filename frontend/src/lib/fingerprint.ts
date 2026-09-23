/** The data-fingerprint watchdog reloads the app when the panels change under
 *  it — a `make data` in a terminal, a rebuild in another tab. A change THIS
 *  tab just caused is not that: ingesting a tape changes the fingerprint too,
 *  and reloading on it tears down the very transition the user is watching,
 *  aborting the new book's first queries mid-flight. The acting surface
 *  blesses the change; the shell then adopts the next fingerprint silently
 *  instead of reloading. One-shot, with a time window in case the next health
 *  poll is up to its full interval away. */
let blessedUntil = 0

export function blessFingerprintChange(windowMs = 90_000) {
  blessedUntil = Date.now() + windowMs
}

export function consumeFingerprintBlessing(): boolean {
  if (Date.now() > blessedUntil) return false
  blessedUntil = 0
  return true
}
