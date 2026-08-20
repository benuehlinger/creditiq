import type { ReactNode } from 'react'
import { useUi } from '../lib/store'

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
  /** One line: what this chart tells you. Required on every chart card. */
  caption?: string
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
        {caption && <p className="mt-1.5 text-xs leading-snug text-ink-secondary">{caption}</p>}
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
        {explain && <span className="text-micro opacity-60">ⓘ</span>}
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
          <span aria-hidden>{delta > 0 ? '▲' : '▼'}</span>
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
  // Status always ships with an icon AND a label. On the light surface warning
  // and serious sit below 3:1 by design, so the pairing is the mitigation and
  // colour never carries the meaning alone.
  const icon = { good: '✓', warning: '!', serious: '▲', critical: '✕' }[severity]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-micro font-medium"
      style={{
        color: `var(--status-${severity})`,
        background: `color-mix(in srgb, var(--status-${severity}) 12%, transparent)`,
      }}
    >
      <span aria-hidden>{icon}</span>
      {children}
    </span>
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
