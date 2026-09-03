import type { ReactNode } from 'react'
import { useUi } from '../lib/store'
import { ArrowDown, ArrowUp, Info } from './icons'

/** Shared primitives. The rules from the brief are enforced here rather than
 *  remembered at each call site: every chart has a title and a "what this tells
 *  you" caption, every metric explains how it is computed on hover, loading is a
 *  skeleton and never a spinner over blank space, and empty states teach the
 *  next action. */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

export function CardHead({
  title, subtitle, caption, methodology, right,
}: {
  title: string
  subtitle?: string
  /** One line: what this chart tells you. Required on every chart card. A node,
   *  so a caption can carry a typeset equation. */
  caption?: ReactNode
  /** Key into METHODOLOGY — renders the "How this is computed" affordance. */
  methodology?: string
  right?: ReactNode
}) {
  const setMethodology = useUi((s) => s.setMethodology)
  return (
    <header className="flex items-start justify-between gap-4 border-b border-hairline px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
          {methodology && (
            <button
              onClick={() => setMethodology(methodology)}
              className="shrink-0 rounded border border-hairline px-1.5 py-px text-micro text-ink-muted hover:text-ink"
              title="How this is computed"
            >
              method
            </button>
          )}
        </div>
        {subtitle && <p className="mt-0.5 text-tiny text-ink-muted">{subtitle}</p>}
        {caption && (
          <p className="mt-1.5 max-w-[88ch] text-xs leading-snug text-ink-secondary">
            {caption}
          </p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </header>
  )
}

export function StatTile({
  label, value, unit, delta, deltaLabel, goodDirection = 'down', explain, accent = false,
}: {
  label: string
  value: string
  unit?: string
  delta?: number
  deltaLabel?: string
  /** Whether a rise is good. For a default rate it is not. */
  goodDirection?: 'up' | 'down'
  /** How this number is computed — shown on hover. */
  explain?: string
  accent?: boolean
}) {
  const good = delta == null ? null : goodDirection === 'up' ? delta > 0 : delta < 0
  return (
    <div className="px-4 py-3" title={explain}>
      <div className="flex items-center gap-1 text-tiny text-ink-muted">
        {label}
        {explain && <Info className="opacity-50" />}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        {/* Proportional figures on a standalone value — tabular-nums makes a
            number like 121 look loose at display sizes. */}
        <span
          className={`text-2xl font-semibold tracking-tight ${accent ? 'text-accent' : 'text-ink'}`}
        >
          {value}
        </span>
        {unit && <span className="text-xs text-ink-muted">{unit}</span>}
      </div>
      {delta != null && (
        <div
          className="mt-0.5 flex items-center gap-1 text-tiny"
          style={{ color: good ? 'var(--good-text)' : 'var(--status-critical)' }}
        >
          {delta > 0 ? <ArrowUp /> : <ArrowDown />}
          <span className="tnum">{Math.abs(delta).toFixed(2)}</span>
          {deltaLabel && <span className="text-ink-muted">{deltaLabel}</span>}
        </div>
      )}
    </div>
  )
}

export function HeroFigure({
  label, value, unit, sub,
}: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="px-5 py-4">
      <div className="text-tiny uppercase tracking-wider text-ink-muted">{label}</div>
      {/* Same sans as everything else — a display or serif face here reads as
          off-brand decoration. */}
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-hero font-semibold text-ink">{value}</span>
        {unit && <span className="text-lg text-ink-secondary">{unit}</span>}
      </div>
      {sub && <p className="mt-1 text-xs text-ink-secondary">{sub}</p>}
    </div>
  )
}

export function StatusPill({
  severity, children,
}: { severity: 'good' | 'warning' | 'serious' | 'critical'; children: ReactNode }) {
  // A dot and a word. The tinted pill with an icon inside it read as a sticker,
  // and three of them on one line competed with the content they described.
  // Colour sits on the dot only; the word carries the meaning, so colour never
  // carries it alone. Sentence case, whatever the caller passed.
  const label = typeof children === 'string'
    ? children.charAt(0).toUpperCase() + children.slice(1) : children
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-tiny font-medium text-ink-secondary">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: `var(--status-${severity})` }} />
      {label}
    </span>
  )
}

/** A finding that needs the reader's attention, in the app's own voice.
 *
 *  The first draft of these was a status-coloured wash over the whole box —
 *  an amber field with an orange border — which read as a browser alert
 *  pasted into the page. This is the calm version: the card surface every
 *  other exhibit uses, a slim accent bar on the left edge carrying the
 *  severity, and a dot-plus-label header, so colour sits in two small places
 *  and the words do the work. One primitive, so every callout in the app has
 *  the same anatomy: label, finding, optional evidence line.
 */
export function Notice({ severity, label, children, detail, className = '' }: {
  severity: 'warning' | 'serious' | 'critical'
  /** Two or three words naming the finding: "Review", "Leakage likely". */
  label: string
  children: ReactNode
  /** The evidence, one line, in small muted type. */
  detail?: ReactNode
  className?: string
}) {
  return (
    <div className={`overflow-hidden rounded-card border border-hairline bg-raised ${className}`}
         role="note">
      <div className="border-l-[3px] px-4 py-3"
           style={{ borderLeftColor: `var(--status-${severity})` }}>
        <div className="flex items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: `var(--status-${severity})` }} />
          <span className="text-tiny font-semibold uppercase tracking-wider text-ink">
            {label}
          </span>
        </div>
        <div className="mt-1.5 max-w-[88ch] text-xs leading-relaxed text-ink-secondary">
          {children}
        </div>
        {detail && (
          <div className="mt-1.5 max-w-[88ch] text-micro text-ink-muted">{detail}</div>
        )}
      </div>
    </div>
  )
}


export function Skeleton({ className = 'h-40' }: { className?: string }) {
  return <div className={`skeleton ${className}`} role="status" aria-label="Loading" />
}

export function EmptyState({
  title, action, children,
}: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <h4 className="text-sm font-medium text-ink">{title}</h4>
      {children && <p className="max-w-sm text-xs leading-relaxed text-ink-secondary">{children}</p>}
      {action}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-tiny text-ink-muted" title={hint}>{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

/**
 * Switch between views of one stage.
 *
 * Three surfaces were switching views and each drew its own control: the two
 * fit stages hand-rolled the same row of pills, and the explore stage used
 * underline tabs. One job, three implementations, two of which were copies and
 * the third of which simply looked like a different thing.
 *
 * These are not places in the app and they are not steps in a sequence: they
 * are lenses on the stage you are already on, so they sit against the content
 * they change rather than in the navigation.
 */
export function ViewTabs<T extends string>({ value, onChange, tabs, className = '' }: {
  value: T
  onChange: (next: T) => void
  tabs: { key: T; label: string; title?: string }[]
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key}
          title={t.title} onClick={() => onChange(t.key)}
          className={`whitespace-nowrap rounded-ctl px-3 py-1 text-xs font-medium transition-colors ${
            value === t.key ? 'bg-accent-soft text-ink'
                            : 'text-ink-muted hover:text-ink-secondary'}`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}
