import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { LgdScreenRow, MacroCandidate, ScreenRow } from '../lib/api'
import { Card, CardHead } from './ui'
import { Info } from './icons'
import { ratio } from '../lib/format'

/**
 * The candidate list, shared by the Explore and Fit stages of both models.
 *
 * Three things it fixes, all of them the same underlying problem — the list was
 * a different thing in each of the four places it appeared.
 *
 * MACRO VARIABLES ARE IN THE LIST. On the PD side they were a row of chips on
 * the fit screen, so a macro term could not be examined or chosen where every
 * other candidate was. They are candidates like any other; they are separated
 * into their own section because they behave differently — they are the only
 * terms a scenario can project — not because they are chosen differently.
 *
 * IT SURVIVES THE FIT. The severity stage kept its drivers beside the fitted
 * model, so an insignificant term could be dropped and the model refitted
 * without navigating away. The PD stage did not. Now both do.
 *
 * IT KEEPS THE SCREENING NUMBERS. Moving from the candidate view to the
 * specification view used to drop the statistic each variable was chosen on,
 * which is exactly the number needed to decide whether to keep a term that came
 * back insignificant. The statistic travels with the row.
 */

export interface ListRow {
  /** The identifier the specification uses. For a macro term this is
   *  `key@transform@lag`, which is precise and unreadable — hence `label`. */
  column: string
  /** What to show. Defaults to `column`. */
  label?: string
  /** The screening statistic this candidate was ranked on, already formatted. */
  stat: string
  /** 0–1, for the bar. */
  strength: number
  /** Optional second line: a warning, a band, a note. */
  note?: string
  tone?: 'default' | 'warning' | 'critical'
  title?: string
}

export interface SpecificationListProps {
  internal: ListRow[]
  macro: ListRow[]
  /** What is IN the specification. Membership, not the ranking. */
  picked: string[]
  onToggle: (column: string) => void
  /** Opening a row for inspection. Absent on the fit stage, where there is no
   *  detail panel to open into — there the row is membership only. */
  selected?: string | null
  onSelect?: (column: string) => void
  title: string
  subtitle: string
  caption?: string
  /** What the strength bar measures, for the column header. */
  statLabel: string
  macroNote: string
  /** Add the strongest macro candidates in one move. Receives the columns to
   *  add TOGETHER, so a guarded edit prompts once, not once per term. */
  onAddMacroTop?: (cols: string[]) => void
  className?: string
}

export default function SpecificationList({
  internal, macro, picked, onToggle, selected, onSelect,
  title, subtitle, caption, statLabel, macroNote, onAddMacroTop, className = '',
}: SpecificationListProps) {
  const [q, setQ] = useState('')
  const [onlyPicked, setOnlyPicked] = useState(false)

  const match = (r: ListRow) =>
    (!q || `${r.label ?? ''} ${r.column}`.toLowerCase().includes(q.toLowerCase()))
    && (!onlyPicked || picked.includes(r.column))

  const shownInternal = useMemo(() => internal.filter(match),
    [internal, q, onlyPicked, picked])
  const shownMacro = useMemo(() => macro.filter(match),
    [macro, q, onlyPicked, picked])

  const nPickedInternal = internal.filter((r) => picked.includes(r.column)).length
  const nPickedMacro = macro.filter((r) => picked.includes(r.column)).length

  // The strongest unpicked macro terms, one per underlying series. Several
  // transforms of the same variable rank together because they carry the same
  // information; adding three spellings of unemployment is not three terms.
  // Terms that contradict the economic prior are skipped for the same reason
  // they are flagged in the list.
  const topMacro = useMemo(() => {
    const seen = new Set(picked.map((c) => c.split('@')[0]))
    const out: string[] = []
    for (const r of macro) {
      if (out.length >= 3) break
      if (picked.includes(r.column) || r.tone === 'warning' || !r.strength) continue
      const base = r.column.split('@')[0]
      if (seen.has(base)) continue
      seen.add(base)
      out.push(r.column)
    }
    return out
  }, [macro, picked])

  return (
    <Card className={`flex h-fit max-h-[calc(100vh-190px)] flex-col ${className}`}>
      <CardHead title={title} subtitle={subtitle} caption={caption} />

      <div className="border-b border-hairline px-3 py-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…"
          className="w-full rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-muted" />
        <label className="mt-2 flex items-center gap-1.5 text-micro text-ink-muted">
          <input type="checkbox" checked={onlyPicked}
            onChange={(e) => setOnlyPicked(e.target.checked)} />
          In the specification only
          <span className="ml-auto tnum text-ink-secondary">
            {nPickedInternal + nPickedMacro} selected
          </span>
        </label>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <Section label="Internal variables" n={nPickedInternal} of={internal.length}
          note="Account and loan attributes. They shape the score; they cannot move under a scenario, because nothing projects them forward." />
        {shownInternal.map((r) => (
          <Row key={r.column} r={r} picked={picked.includes(r.column)}
            active={selected === r.column} onToggle={onToggle} onSelect={onSelect}
            statLabel={statLabel} />
        ))}
        {!shownInternal.length && <Empty />}

        <Section label="Macro variables" n={nPickedMacro} of={macro.length}
          note={macroNote}
          action={onAddMacroTop && topMacro.length > 0 ? (
            <button onClick={() => onAddMacroTop(topMacro)}
              title={`Add the ${topMacro.length} strongest remaining macro terms — one per underlying series, skipping any that contradict the economic prior: ${topMacro.join(', ')}`}
              className="rounded border border-hairline px-1.5 py-px text-micro text-ink-secondary hover:text-ink">
              Add top {topMacro.length}
            </button>
          ) : undefined} />
        {shownMacro.map((r) => (
          <Row key={r.column} r={r} picked={picked.includes(r.column)}
            active={selected === r.column} onToggle={onToggle} onSelect={onSelect}
            statLabel={statLabel} />
        ))}
        {!shownMacro.length && <Empty />}
      </div>
    </Card>
  )
}

function Section({ label, n, of, note, action }: {
  label: string; n: number; of: number; note: string; action?: ReactNode
}) {
  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-2 border-y border-hairline
                    bg-sunken px-3 py-1.5">
      <span className="text-micro font-medium uppercase tracking-wider text-ink-secondary">
        {label}
      </span>
      <span className="cursor-help text-ink-muted" title={note}><Info /></span>
      {action}
      <span className="ml-auto tnum text-micro text-ink-muted">{n}/{of}</span>
    </div>
  )
}

function Empty() {
  return <p className="px-3 py-2 text-micro text-ink-muted">Nothing matches the filter.</p>
}

function Row({ r, picked, active, onToggle, onSelect, statLabel }: {
  r: ListRow; picked: boolean; active: boolean
  onToggle: (c: string) => void
  onSelect?: (c: string) => void
  statLabel: string
}) {
  const colour = r.tone === 'critical' ? 'var(--status-critical)'
    : r.tone === 'warning' ? 'var(--status-warning)' : undefined
  return (
    <div className={`flex items-center gap-2 border-b border-hairline px-3 py-1 ${
      active ? 'bg-accent-soft' : ''}`}>
      {/* Membership is a checkbox, examination is the row. Two actions, two
          targets — one control doing both is how a variable used to end up in a
          specification when the intent was only to look at it. */}
      <button onClick={() => onToggle(r.column)}
        title={picked ? 'Remove from the specification' : 'Add to the specification'}
        className={`h-3 w-3 shrink-0 rounded-sm border ${
          picked ? 'border-accent bg-accent' : 'border-hairline hover:border-accent'}`} />
      <button onClick={() => onSelect?.(r.column)}
        disabled={!onSelect}
        title={r.title ?? (onSelect ? 'Open this variable' : undefined)}
        className="min-w-0 flex-1 text-left disabled:cursor-default">
        <div className="flex items-center gap-2">
          <span className={`truncate font-mono text-tiny ${
            active ? 'text-ink' : picked ? 'text-ink' : 'text-ink-secondary'}`}>
            {r.label ?? r.column}
          </span>
          {r.note && (
            <span className="shrink-0 text-micro" style={{ color: colour ?? 'var(--ink-muted)' }}>
              {r.note}
            </span>
          )}
          {/* the statistic, with its strength as a short bar beneath it: one
              glance gives rank and magnitude without a second line */}
          <span className="ml-auto flex shrink-0 flex-col items-end" title={statLabel}>
            <span className="tnum text-tiny" style={{ color: colour }}>{r.stat}</span>
            <span className="mt-0.5 h-0.5 w-10 rounded-sm bg-hairline">
              <span className="block h-full rounded-sm"
                    style={{ width: `${Math.min(Math.max(r.strength, 0), 1) * 100}%`,
                             background: colour ?? 'var(--accent)' }} />
            </span>
          </span>
        </div>
      </button>
    </div>
  )
}

/** The PD screening rows, in the shared shape. */
export function pdRows(rows: ScreenRow[], maxIv: number): ListRow[] {
  return rows.map((r) => ({
    column: r.column,
    stat: ratio(r.iv, 3),
    strength: Math.min(r.iv || 0, maxIv) / (maxIv || 1),
    // Amber is reserved for leakage. "Review" was printed under most rows,
    // and a list where everything is flagged flags nothing; the reason is
    // still on the hover.
    note: r.leakage_risk === 'likely' ? 'leakage'
      : !r.above_null ? 'below the null floor' : undefined,
    tone: r.leakage_risk === 'likely' ? 'critical' : 'default',
    title: r.leakage_reason || undefined,
  }))
}

/** Macro terms, ranked by their correlation with the target. */
export function macroRows(
  terms: { col: string; label: string }[],
  library: MacroCandidate[] | undefined,
  target: 'pd' | 'lgd',
): ListRow[] {
  const byCol = new Map((library ?? []).map((c) => [c.column, c]))
  const rows = terms.map(({ col, label }) => {
    const c = byCol.get(col)
    const r = c ? (target === 'pd' ? c.pd_r : c.lgd_r) : null
    return {
      column: col,
      label,
      stat: r == null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}`,
      strength: r == null ? 0 : Math.min(Math.abs(r), 1),
      // A term whose direction contradicts the book's economic prior is a
      // finding about collinearity, not a discovery — see the macro surface.
      note: c && (target === 'pd' ? c.pd_sign_ok : c.lgd_sign_ok) === false
        ? 'against the economic prior' : undefined,
      tone: (c && (target === 'pd' ? c.pd_sign_ok : c.lgd_sign_ok) === false
        ? 'warning' : 'default') as ListRow['tone'],
      title: label,
    }
  })
  return rows.sort((a, b) => b.strength - a.strength)
}


/** The severity screening rows, in the shared shape.
 *
 *  Ranked on rank correlation with realised severity, with the spread — the gap
 *  in percentage points between the highest and lowest bucket mean — as the
 *  note. The spread is the one that states the relationship in the units of the
 *  answer, and it is what disappeared when the fit stage switched to a plain
 *  driver list.
 */
export function lgdRows(rows: LgdScreenRow[]): ListRow[] {
  return rows.map((r) => ({
    column: r.column,
    stat: r.spearman == null ? '—'
      : `${r.spearman > 0 ? '+' : ''}${r.spearman.toFixed(2)}`,
    strength: Math.min(Math.abs(r.spearman ?? 0), 1),
    note: [
      r.spread ? `spread ${(r.spread * 100).toFixed(0)}pt` : null,
      r.caution ? 'looks like an identifier' : null,
      r.filled < 0.95 ? `${(r.filled * 100).toFixed(0)}% populated` : null,
    ].filter(Boolean).join(' · ') || undefined,
    tone: r.caution ? 'warning' : 'default',
    title: `Rank correlation with realised severity on the defaulted population.`
      + (r.levels ? ` ${r.levels} levels.` : ''),
  }))
}
