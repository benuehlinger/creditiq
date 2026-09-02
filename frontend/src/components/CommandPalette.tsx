import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useUi } from '../lib/store'

interface Cmd { id: string; label: string; hint: string; run: () => void }

/** Live-demo insurance. Every screen is one keystroke away, so a mis-click never
 *  turns into a hunt through navigation in front of a client. */
export default function CommandPalette() {
  const { paletteOpen, setPaletteOpen, toggleTheme } = useUi()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { data: portfolios } = useQuery({ queryKey: ['portfolios'], queryFn: api.portfolios })

  const commands = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [
      { id: 'rollup', label: 'Portfolio Roll-Up', hint: 'Executive view · 0', run: () => nav('/rollup') },
      { id: 'theme', label: 'Toggle light / dark mode', hint: 'Appearance', run: toggleTheme },
      { id: 'brand', label: 'Brand assets', hint: 'Logos, export for a deck',
        run: () => nav('/brand') },
    ]
    for (const p of portfolios ?? []) {
      for (const [s, l] of [['data', 'Data'],
                            ['pd', 'PD model'],
                            ['lgd', 'LGD model'],
                            ['scenarios', 'Scenarios'], ['versions', 'Versions']]) {
        out.push({
          id: `${p.key}-${s}`,
          label: `${p.label} → ${l}`,
          hint: `${p.n_accounts.toLocaleString()} accounts`,
          run: () => nav(`/${p.key}/${s}`),
        })
      }
    }
    return out
  }, [portfolios, nav, toggleTheme])

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return commands.slice(0, 12)
    return commands.filter((c) => c.label.toLowerCase().includes(t)).slice(0, 12)
  }, [q, commands])

  useEffect(() => {
    if (paletteOpen) {
      setQ(''); setI(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [paletteOpen])

  if (!paletteOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[14vh]"
      onClick={() => setPaletteOpen(false)}
    >
      <div
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-card bg-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setI(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPaletteOpen(false)
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(v + 1, hits.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(v - 1, 0)) }
            if (e.key === 'Enter' && hits[i]) { hits[i].run(); setPaletteOpen(false) }
          }}
          placeholder="Jump to a portfolio or surface…"
          className="w-full border-b border-hairline bg-transparent px-4 py-3 text-base text-ink outline-none placeholder:text-ink-muted"
        />
        <ul className="thin-scroll max-h-[52vh] overflow-y-auto py-1">
          {hits.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-ink-muted">No match.</li>
          )}
          {hits.map((c, k) => (
            <li key={c.id}>
              <button
                onMouseEnter={() => setI(k)}
                onClick={() => { c.run(); setPaletteOpen(false) }}
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                  k === i ? 'bg-accent-soft text-ink' : 'text-ink-secondary'
                }`}
              >
                <span>{c.label}</span>
                <span className="text-tiny text-ink-muted">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
