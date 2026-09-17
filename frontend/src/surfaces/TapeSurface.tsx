import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type TapeInspection } from '../lib/api'
import { num } from '../lib/format'
import { Card, CardHead, Field, Notice } from '../components/ui'

/** Loan tape ingestion — the validation gate.
 *
 *  The file must already be a panel: one row per account per month. This
 *  surface maps the seller's column names onto the canonical schema, asks
 *  the four questions the synthetic books hardcode, and registers the book.
 *  It refuses clearly when the file is not a panel — panel CONSTRUCTION is
 *  deliberately not offered here (docs/CECL-FORK.md has the boundary).
 */
export default function TapeSurface() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [report, setReport] = useState<TapeInspection | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [dpd, setDpd] = useState(4)
  const [ead, setEad] = useState<'amortizing' | 'ccf'>('amortizing')
  const [oot, setOot] = useState('2023-01-01')

  const inspect = useMutation({
    mutationFn: (f: File) => api.tapeInspect(f),
    onSuccess: (r) => {
      setReport(r)
      setMapping(r.suggested_mapping)
      const base = r.filename.replace(/\.[^.]+$/, '')
      setLabel(base.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
      if (!keyTouched) setKey(slug(base))
    },
  })

  const ingest = useMutation({
    mutationFn: () => api.tapeIngest({
      token: report!.token, key, label, mapping,
      dpd_state: dpd, ead_method: ead, oot_from: oot,
    }),
    onSuccess: (rec) => {
      qc.invalidateQueries({ queryKey: ['portfolios'] })
      qc.invalidateQueries({ queryKey: ['health'] })
      nav(`/${rec.key}/data`)
    },
  })

  const missing = useMemo(() => {
    if (!report) return []
    return report.schema.filter((s) => s.required && !mapping[s.name])
      .map((s) => s.name)
  }, [report, mapping])

  const taken = useMemo(() => new Set(Object.values(mapping).filter(Boolean)),
                        [mapping])

  return (
    <div className="mx-auto max-w-[1100px] space-y-3 px-4 py-4">
      <Card>
        <CardHead title="Load a loan tape"
          subtitle="CSV or parquet, already at monthly account grain"
          caption="The file must be a panel: one row per account per month, with a 0/1 default flag. Column names are mapped below; nothing is renamed or recoded without being shown here first. This gate validates a panel; it does not build one. Converting a snapshot or raw performance file into account-months takes judgement, and judgement belongs in a workflow that documents it." />
        <div className="flex items-center gap-3 px-4 pb-4">
          <input ref={fileRef} type="file" accept=".csv,.parquet,.pq"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) inspect.mutate(f)
            }} />
          <button onClick={() => fileRef.current?.click()}
            disabled={inspect.isPending}
            className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
            {inspect.isPending ? 'Reading the file…'
              : report ? 'Choose a different file' : 'Choose a file'}
          </button>
          {report && (
            <span className="text-xs text-ink-secondary">
              <span className="font-mono">{report.filename}</span>
              {' · '}{num(report.n_rows)} rows · {report.n_columns} columns
            </span>
          )}
          {inspect.isError && (
            <span className="text-xs" style={{ color: 'var(--status-critical)' }}>
              {String((inspect.error as Error).message)}
            </span>
          )}
        </div>
      </Card>

      {report && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card>
            <CardHead title="Column mapping"
              subtitle="Their names, onto the canonical schema"
              caption="Suggestions are preselected from common seller conventions; confirm or correct them. Columns left unmapped ride along under their own names as candidate drivers." />
            {missing.length > 0 && (
              <p className="px-4 pb-2 text-xs" style={{ color: 'var(--status-warning)' }}>
                Still required: {missing.join(', ')}
              </p>
            )}
            <div className="thin-scroll max-h-[520px] overflow-auto px-4 pb-4">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface text-tiny text-ink-muted">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">Canonical field</th>
                    <th className="py-1.5 pr-2 font-medium">Their column</th>
                    <th className="py-1.5 font-medium">What it is for</th>
                  </tr>
                </thead>
                <tbody>
                  {report.schema.map((item) => (
                    <tr key={item.name} className="border-t border-hairline align-top">
                      <td className="py-1.5 pr-2">
                        <span className="font-mono text-micro text-ink">{item.name}</span>
                        {item.required && (
                          <span className="ml-1 text-micro"
                                style={{ color: 'var(--status-warning)' }}>required</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2">
                        <select value={mapping[item.name] ?? ''}
                          onChange={(e) => setMapping((m) =>
                            ({ ...m, [item.name]: e.target.value || null }))}
                          className="w-44 rounded-ctl border border-hairline bg-surface px-1.5 py-1 text-micro">
                          <option value="">not in this file</option>
                          {report.columns.map((c) => (
                            <option key={c.name} value={c.name}
                              disabled={taken.has(c.name) && mapping[item.name] !== c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1.5 text-micro leading-relaxed text-ink-secondary">
                        {item.about}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="space-y-3">
            <Card>
              <CardHead title="About this book"
                caption="The four things the synthetic books hardcode, asked out loud because this is someone else's data." />
              <div className="space-y-3 px-4 pb-4">
                <Field label="Display name">
                  <input value={label} onChange={(e) => {
                      setLabel(e.target.value)
                      if (!keyTouched) setKey(slug(e.target.value))
                    }}
                    className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-xs" />
                </Field>
                <Field label="Key (short, permanent)">
                  <input value={key}
                    onChange={(e) => { setKeyTouched(true); setKey(slug(e.target.value)) }}
                    className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1.5 font-mono text-xs" />
                </Field>
                <Field label="Default definition trips at delinquency state">
                  <input type="number" min={1} max={12} value={dpd}
                    onChange={(e) => setDpd(+e.target.value)}
                    className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-xs" />
                </Field>
                <Field label="Exposure method">
                  <select value={ead}
                    onChange={(e) => setEad(e.target.value as 'amortizing' | 'ccf')}
                    className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-xs">
                    <option value="amortizing">Amortising loans</option>
                    <option value="ccf">Revolving commitments (CCF)</option>
                  </select>
                </Field>
                <Field label="Out-of-time window starts">
                  <input type="date" value={oot} onChange={(e) => setOot(e.target.value)}
                    className="w-full rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-xs" />
                </Field>
              </div>
            </Card>

            <Card>
              <div className="space-y-2 px-4 py-4">
                <button
                  disabled={ingest.isPending || missing.length > 0 || !key || !label}
                  title={missing.length
                    ? `Map ${missing.join(', ')} first. A panel cannot be modelled without them.`
                    : undefined}
                  onClick={() => ingest.mutate()}
                  className="w-full rounded-ctl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                  {ingest.isPending ? 'Validating and registering…' : 'Validate and add this book'}
                </button>
                {ingest.isError && (
                  <Notice severity="critical" label="The tape was refused">
                    {String((ingest.error as Error).message)}
                  </Notice>
                )}
                <p className="text-micro leading-relaxed text-ink-muted">
                  Validation refuses duplicates on the account-month key,
                  unparseable dates and a non-0/1 default flag. Judgement
                  findings (gaps, negative balances, an implausible default
                  rate) land on the Data surface instead, where they belong.
                </p>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '').slice(0, 24)
