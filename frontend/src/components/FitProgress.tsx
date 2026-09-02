import type React from 'react'
import { useEffect, useRef, useState } from 'react'

/**
 * The fit, while it runs.
 *
 * A fit is one request and the server does not stream progress, so what this
 * shows is an ESTIMATE paced by the previous fit's timings: the six phases the
 * server reports, each sized by how long it took last time, with defaults
 * before there is a last time. The bar eases toward the end and holds there
 * until the response arrives, then completes. It is labelled as an estimate
 * where it states a time.
 *
 * Why bother: a fit on three million account-months takes five to ten
 * seconds, and a static shimmer for ten seconds reads as a hang. Naming the
 * phase that is running, with the count it is running over, is the difference
 * between "is it working?" and watching it work.
 */
export interface Phase { key: string; label: string; seconds: number }

export const PD_PHASES = (n: number | undefined, t?: Record<string, number>): Phase[] => {
  const rows = n ? n.toLocaleString() + ' account-months' : 'the full panel'
  const s = (k: string, d: number) => Math.max(0.15, t?.[k] ?? d)
  return [
    { key: 'prepare',     label: `Loading ${rows}`,                         seconds: s('prepare', 0.4) },
    { key: 'design',      label: 'Building the design matrix',               seconds: s('design', 1.2) },
    { key: 'fit',         label: 'Estimating by Newton-Raphson',             seconds: s('fit', 1.6) },
    { key: 'score',       label: 'Scoring every account-month',              seconds: s('score', 0.9) },
    { key: 'diagnostics', label: 'Discrimination, calibration, lift',        seconds: s('diagnostics', 0.7) },
    { key: 'backtest',    label: 'Backtesting every performance date',       seconds: s('backtest', 1.8) },
  ]
}

export const LGD_PHASES = (n: number | undefined): Phase[] => [
  { key: 'prepare',     label: `Selecting ${n ? n.toLocaleString() + ' resolved defaults' : 'the defaulted population'}`, seconds: 0.3 },
  { key: 'design',      label: 'Standardising the drivers',                 seconds: 0.4 },
  { key: 'fit',         label: 'Fractional-logit quasi-likelihood',          seconds: 0.9 },
  { key: 'diagnostics', label: 'Calibration and sandwich errors',            seconds: 0.5 },
]

export const ECL_PHASES = (n: number | undefined, t?: Record<string, number>): Phase[] => {
  const s = (k: string, d: number) => Math.max(0.15, t?.[k] ?? d)
  const accts = n ? n.toLocaleString() + ' open accounts' : 'every open account'
  return [
    { key: 'prepare',     label: 'Preparing the PD model',                    seconds: s('pd_model', 2.5) },
    { key: 'design',      label: 'Preparing the LGD model',                   seconds: s('lgd_model', 0.8) },
    { key: 'score',       label: `Projecting ${accts} over the horizon`,       seconds: s('projection', 3.0) },
    { key: 'backtest',    label: 'Building the attribution bridge',            seconds: 0.4 },
  ]
}

export const ROLLUP_PHASES = (books: { key: string; label: string }[],
                              t?: Record<string, number>): Phase[] =>
  books.map((b, i) => ({
    key: ['prepare', 'design', 'score'][i] ?? `book${i}`,
    label: `Projecting ${b.label}`,
    seconds: Math.max(0.3, t?.[b.key] ?? 3.0),
  }))

/** A small in-progress mark for a control that is busy for under a second:
 *  a pulsing dot and a word, in the same voice as a status. */
export function Busy({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-tiny text-ink-muted">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      {children}
    </span>
  )
}

export default function FitProgress({ phases, done = false, doneLabel = 'Fitted' }: {
  phases: Phase[]; done?: boolean; doneLabel?: string
}) {
  const total = phases.reduce((a, p) => a + p.seconds, 0)
  const started = useRef(performance.now())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    let raf = 0
    const tick = () => { setElapsed((performance.now() - started.current) / 1000); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Progress eases toward 92% of the estimate and holds: the response, not
  // the clock, decides when it is finished.
  const raw = Math.min(elapsed / total, 1)
  const eased = done ? 1 : Math.min(0.92, 1 - Math.pow(1 - raw, 1.6))
  let acc = 0, current = phases.length - 1
  for (let i = 0; i < phases.length; i++) {
    acc += phases[i].seconds
    if (elapsed < acc) { current = i; break }
  }
  if (done) current = phases.length

  return (
    <div className="rounded-card border border-hairline bg-raised px-5 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-sm font-medium text-ink">
          {done ? doneLabel : phases[Math.min(current, phases.length - 1)].label}
          {!done && <span className="ml-1 inline-block w-4 text-left text-ink-muted animate-[dots_1.2s_steps(4,end)_infinite]" />}
        </div>
        <div className="tnum text-tiny text-ink-muted">
          {elapsed.toFixed(1)}s{!done && <> · about {Math.ceil(total)}s, estimated from the last fit</>}
        </div>
      </div>

      {/* the track, with a sheen that travels while it runs */}
      <div className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300 ease-out"
             style={{ width: `${eased * 100}%` }} />
        {!done && (
          <div className="absolute inset-y-0 w-24 animate-[sheen_1.4s_ease-in-out_infinite] rounded-full"
               style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)' }} />
        )}
      </div>

      {/* the phases, so it is visible WHAT is running and what is done */}
      <ol className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        {phases.map((p, i) => {
          const state = i < current ? 'done' : i === current ? 'now' : 'todo'
          return (
            <li key={p.key} className={`flex items-center gap-1.5 text-tiny ${
              state === 'now' ? 'text-ink' : state === 'done' ? 'text-ink-secondary' : 'text-ink-muted'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${
                state === 'done' ? 'bg-accent' : state === 'now' ? 'bg-accent animate-pulse' : 'bg-hairline'}`} />
              {p.label.split(' ')[0] === 'Projecting' || p.label.split(' ')[0] === 'Preparing'
                ? p.label.replace(/^(Projecting|Preparing) (the )?/, '').replace(/ over the horizon| model/, '')
                : p.key === 'prepare' ? 'Load' : p.key === 'design' ? 'Design' : p.key === 'fit' ? 'Estimate'
                : p.key === 'score' ? 'Score' : p.key === 'diagnostics' ? 'Diagnose' : 'Backtest'}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
