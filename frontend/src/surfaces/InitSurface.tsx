import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead } from '../components/ui'

/**
 * The screen a fresh clone boots into.
 *
 * The synthetic panels are generated, not shipped, so a machine that has just
 * cloned the repository has no data. The old behaviour was to require
 * `make setup` before first launch and to fail with empty endpoints without
 * it. Now the app starts instantly in an uninitialized state and offers the
 * generation as a button, with the step, the count and the clock visible —
 * a person waiting three minutes deserves to know it is three minutes.
 */
const mmss = (s: number) => {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export default function InitSurface() {
  const status = useQuery({
    queryKey: ['datastatus'],
    queryFn: api.dataStatus,
    refetchInterval: (q) =>
      q.state.data?.state === 'running' ? 1000 : q.state.data?.ready ? false : 3000,
    // Generation takes minutes; the person waiting has certainly switched to
    // another tab. Polling pauses in hidden tabs by default, which froze the
    // progress at whatever step it showed when focus left — keep polling, so
    // the screen is done (and reloaded into the app) when they come back.
    refetchIntervalInBackground: true,
  })
  const s = status.data

  // The transition out of this screen is a full reload, owned by the shell:
  // every query in the cache was made against a machine with no data.
  if (!s || s.ready) return null

  const running = s.state === 'running'
  const pct = running && s.total ? Math.round((s.step / s.total) * 100) : 0

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <Card>
        <CardHead title="No data on this machine yet"
          subtitle="The synthetic panels are generated locally, not shipped"
          caption="Three portfolios are simulated from fixed seeds: 150,000 consumer installment accounts, 55,000 residential mortgages and 45,000 commercial real estate loans, monthly from 2008 through 2025. The same seeds produce the same bytes on every machine, so the numbers here match the numbers anywhere else this runs." />
        <div className="px-4 pb-4 pt-3">
          {!running && s.state !== 'error' && (
            <>
              <button onClick={() => api.dataGenerate().then(() => status.refetch())}
                className="rounded-ctl bg-accent px-4 py-2 text-sm font-semibold text-white">
                Generate the synthetic data
              </button>
              <p className="mt-2 text-tiny text-ink-muted">
                Runs locally in {s.total || 29} steps, typically two to four minutes.
                Nothing leaves this machine.
              </p>
            </>
          )}

          {running && (
            <>
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium text-ink">
                  Step {s.step} of {s.total}
                </span>
                <span className="tnum text-ink-muted">
                  {mmss(s.elapsed_s)} elapsed
                  {s.eta_s != null && <> · about {mmss(s.eta_s)} left</>}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full bg-accent transition-all duration-500"
                     style={{ width: `${Math.max(pct, 2)}%` }} />
              </div>
              <p className="mt-2 text-tiny text-ink-secondary">{s.label}</p>
              <p className="mt-1 text-micro text-ink-muted">
                The remaining-time estimate is rough: steps are not equal-sized,
                and the simulation steps are the long ones.
              </p>
            </>
          )}

          {s.state === 'error' && (
            <>
              <p className="text-xs" style={{ color: 'var(--status-critical)' }}>
                Generation failed: {s.error}
              </p>
              <button onClick={() => api.dataGenerate().then(() => status.refetch())}
                className="mt-2 rounded-ctl border border-hairline px-3 py-1.5 text-xs text-ink-secondary hover:text-ink">
                Try again
              </button>
            </>
          )}
        </div>
      </Card>
      <p className="mt-3 text-micro text-ink-muted">
        Command-line alternative: <code className="font-mono">make data</code> in
        the repository root does the same thing.
      </p>
    </div>
  )
}
