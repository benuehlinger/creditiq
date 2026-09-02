import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type MacroCandidate, type PortfolioKey } from '../lib/api'
import { Card, CardHead, Skeleton, StatTile } from '../components/ui'
import { Check, Cross, Info } from '../components/icons'
import EChart from '../charts/EChart'
import { baseOption, crosshairTooltip, lineSeries } from '../charts/base'
import { deemphasis, ink, mode, series } from '../design/tokens'
import { monthShort, num, ratio, monthLong } from '../lib/format'
import { useUi } from '../lib/store'

/** Macro — the transformation search.
 *
 *  A macroeconomic variable does not enter a credit model as published. It
 *  enters as some transformation of itself at some lag, and which one is an
 *  empirical question. This surface enumerates the candidates once and both
 *  models draw from the result: the same term means the same quantity in the PD
 *  hazard, in the LGD severity model and in the scenario projection, because all
 *  three build it through the same function.
 *
 *  It sits beside Data rather than inside it because the two are different
 *  objects. Data is the loan tape — one row per account-month, missingness,
 *  cardinality, the target definition. This is a handful of shared monthly
 *  series whose diagnostics are stationarity, autocorrelation and lag. */
/** The sign check follows whichever correlation the table is showing. */
function signOk(c: MacroCandidate, target: 'pd' | 'lgd'): boolean | null {
  return target === 'pd' ? c.pd_sign_ok : c.lgd_sign_ok
}

/** Most rows carry a dash, so the column says what it means without a hover. */
function SignLegend({ n, total }: { n: number; total: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline px-3 py-1.5 text-micro text-ink-muted">
      <span className="text-ink-secondary">Sign</span>
      <span className="flex items-center gap-1">
        <span style={{ color: 'var(--status-good)' }}><Check /></span>
        agrees with the economic prior for the variable
      </span>
      <span className="flex items-center gap-1">
        <span style={{ color: 'var(--status-critical)' }}><Cross /></span>
        contradicts it, usually collinearity rather than a finding
      </span>
      <span className="flex items-center gap-1">
        <span>—</span>
        no prior is declared, so nothing is checked
        {total > 0 && <span className="tnum">({n} of {total})</span>}
      </span>
    </div>
  )
}

export default function MacroSurface() {
  const { portfolio = 'consumer' } = useParams()
  const pk = portfolio as PortfolioKey
  const shortlist = useUi((s) => s.macroShortlist[pk])
  const toggleShortlist = useUi((s) => s.toggleShortlist)

  const lib = useQuery({ queryKey: ['macrolib', portfolio], queryFn: () => api.macroLibrary(portfolio) })
  const [target, setTarget] = useState<'pd' | 'lgd'>('pd')
  const [onlyStationary, setOnlyStationary] = useState(true)
  // One row per variable and transform, at its best lag. Ranking every lag of
  // every variable put prime_rate at six different lags in the top six: the
  // classic route to a spurious pick, since the best of five lags of the same
  // series will always look better than any one of them. Off, the lags are
  // listed so the lag structure can be read.
  const [bestLagOnly, setBestLagOnly] = useState(true)
  const [onlySignOk, setOnlySignOk] = useState(false)
  const [transform, setTransform] = useState<string>('all')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => { setSelected(null) }, [portfolio])

  const rows = useMemo(() => {
    const all = lib.data?.rows ?? []
    const r = (c: MacroCandidate) => (target === 'pd' ? c.pd_r : c.lgd_r)
    return all
      .filter((c) => r(c) != null)
      .filter((c) => !onlyStationary || c.stationary === true)
      .filter((c) => !onlySignOk || signOk(c, target) !== false)
      .filter((c) => transform === 'all' || c.transform === transform)
      .sort((a, b) => Math.abs(r(b)!) - Math.abs(r(a)!))
      .filter((c, _, arr) => !bestLagOnly
        || arr.find((x) => x.key === c.key && x.transform === c.transform) === c)
  }, [lib.data, target, onlyStationary, onlySignOk, transform, bestLagOnly])

  const shown = selected ?? rows[0]?.column ?? null
  const detail = useQuery({
    queryKey: ['macroseries', portfolio, shown],
    queryFn: () => api.macroSeries(portfolio, shown!),
    enabled: !!shown,
  })

  if (lib.isLoading || !lib.data) return <div className="p-4"><Skeleton className="h-[560px]" /></div>
  const d = lib.data
  const nStationary = d.rows.filter((c) => c.stationary === true).length

  return (
    <div className="space-y-3 p-4">
      <Card>
        <CardHead
          title="Macro: transformation search"
          subtitle={`${d.n_bases} supervisory variables × ${d.transforms.length} transforms × ${d.lags.length} lags · estimation window ${d.window[0].slice(0, 7)} to ${d.window[1].slice(0, 7)}`}
          caption="Only variables with a published Federal Reserve forward path are offered, because a term with no projected path cannot be carried into a scenario."
        />
        <div className="grid gap-3 border-t border-hairline p-3 sm:grid-cols-4">
          <StatTile label="Candidate terms" value={num(d.n_candidates)} />
          <StatTile label="Stationary" value={`${num(nStationary)}`}
            explain={`Augmented Dickey-Fuller p < ${d.adf_alpha}. The null is a unit root, so a small p-value is evidence against one.`} />
          <StatTile label="PD target" value={`${num(d.pd_months)} months`}
            explain="The monthly default rate on the log-odds scale, over the estimation window." />
          <StatTile label="LGD target" value={`${num(d.lgd_defaults)} defaults`}
            explain={`Severity is correlated per resolved default, with the macro term joined at the default month. This is the population the LGD model is estimated on. Those defaults fall in ${d.lgd_months} distinct months, which caps the effective sample size.`} />
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-tiny">
          <div className="flex items-center gap-0.5 rounded-ctl bg-sunken p-0.5">
            {(['pd', 'lgd'] as const).map((t) => (
              <button key={t} onClick={() => setTarget(t)}
                className={`rounded-[5px] px-2.5 py-1 font-medium transition-colors ${
                  target === t ? 'bg-surface text-ink' : 'text-ink-muted hover:text-ink-secondary'}`}>
                {t === 'pd' ? 'Rank against PD' : 'Rank against LGD'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-ink-muted"
            title="A regression of one trending series on another finds a relationship whether or not one exists. Non-stationary forms are excluded by default; the test is reported either way.">
            <input type="checkbox" checked={onlyStationary}
              onChange={(e) => setOnlyStationary(e.target.checked)} />
            Stationary only <Info className="text-ink-muted" />
          </label>
          <label className="flex items-center gap-1.5 text-ink-muted"
            title="One row per variable and transform, at the lag with the strongest correlation. Ranking every lag separately lets one series fill the top of the list, and the best of several lags of the same series always looks better than any single one of them.">
            <input type="checkbox" checked={bestLagOnly}
              onChange={(e) => setBestLagOnly(e.target.checked)} />
            Best lag only <Info className="text-ink-muted" />
          </label>
          <label className="flex items-center gap-1.5 text-ink-muted"
            title="Drops terms whose observed direction contradicts the portfolio's economic prior. Terms with no declared prior (—) are kept, because an unchecked direction is not a failed one.">
            <input type="checkbox" checked={onlySignOk}
              onChange={(e) => setOnlySignOk(e.target.checked)} />
            Sign matches the prior <Info className="text-ink-muted" />
          </label>
          <label className="flex items-center gap-1.5 text-ink-muted">
            Transform
            <select value={transform} onChange={(e) => setTransform(e.target.value)}
              className="rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink">
              <option value="all">all</option>
              {d.transforms.map((t) => (
                <option key={t.key} value={t.key} title={t.note}>{t.label}</option>
              ))}
            </select>
          </label>
          <span className="ml-auto text-ink-muted">
            {num(rows.length)} shown · {shortlist.pd.length} on the PD shortlist ·
            {' '}{shortlist.lgd.length} on the LGD shortlist
          </span>
        </div>
      </Card>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_460px]">
        <Card>
          <CardHead title="Candidates" subtitle={`Ranked by |correlation| with the ${target === 'pd' ? 'monthly default rate, on the log-odds scale' : 'monthly mean severity, on the logit scale'}`}
            caption="Significance uses an effective sample size, not the raw month count. Two smooth monthly series carry far less independent information than the observation count implies." />
          <SignLegend n={rows.filter((c) => signOk(c, target) == null).length}
                      total={rows.length} />
          <div className="thin-scroll max-h-[560px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-y border-hairline bg-surface text-tiny text-ink-muted">
                <tr>
                  <th className="px-2 py-2 font-medium">Variable</th>
                  <th className="px-2 py-2 font-medium">Transform</th>
                  <th className="px-2 py-2 text-right font-medium">Lag</th>
                  <th className="px-2 py-2 text-right font-medium" title="Augmented Dickey-Fuller p-value. Small means stationary.">ADF p</th>
                  <th className="px-2 py-2 text-right font-medium">r</th>
                  <th className="px-2 py-2 text-right font-medium" title="Adjusted for serial correlation in both series.">p</th>
                  <th className="px-2 py-2 text-center font-medium"
                      title="Whether the observed direction agrees with the declared economic prior. A prior is declared per variable and applies to every transform and lag of it. Tick agrees, cross contradicts, dash means no prior is declared.">Sign ⓘ</th>
                  <th className="px-2 py-2 text-center font-medium">PD</th>
                  <th className="px-2 py-2 text-center font-medium">LGD</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 120).map((c) => {
                  const r = target === 'pd' ? c.pd_r : c.lgd_r
                  const p = target === 'pd' ? c.pd_p : c.lgd_p
                  const active = c.column === shown
                  return (
                    <tr key={c.column}
                        className={`cursor-pointer border-b border-hairline ${
                          active ? 'bg-accent-soft' : 'hover:bg-sunken/60'}`}
                        onClick={() => setSelected(c.column)}>
                      <td className="px-2 py-1.5">
                        <span className={`font-mono text-tiny ${active ? 'text-ink' : 'text-ink-secondary'}`}>
                          {c.key}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-ink-secondary">{c.transform_label}</td>
                      <td className="px-2 py-1.5 text-right tnum text-ink-muted">
                        {c.lag_months ? `${c.lag_months}m` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right tnum"
                          style={{ color: c.stationary === false ? 'var(--status-warning)' : undefined }}>
                        {c.adf_p == null ? '—' : c.adf_p.toFixed(3)}
                      </td>
                      <td className="px-2 py-1.5 text-right tnum text-ink">
                        {r == null ? '—' : (r > 0 ? '+' : '') + r.toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5 text-right tnum text-ink-muted">
                        {p == null ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3)}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {(() => {
                          const ok = signOk(c, target)
                          if (ok == null) return (
                            <span className="text-ink-muted"
                                  title={`No economic prior is declared for ${c.key} on this book, so there is nothing to check the direction against. The term is not penalised for this.`}>—</span>
                          )
                          const obs = target === 'pd' ? c.pd_observed_sign : c.lgd_observed_sign
                          const t2 = target === 'pd' ? 'default rate' : 'loss given default'
                          return (
                            <span style={{ color: ok ? 'var(--status-good)' : 'var(--status-critical)' }}
                                  title={`Prior: a higher ${c.label} ${c.expected_sign === 1 ? 'raises' : 'lowers'} the ${t2}. Observed: it ${obs === 1 ? 'raises' : 'lowers'} it. ${ok ? 'The two agree.' : 'The two disagree, which usually points to collinearity with another term rather than to a new finding.'}`}>
                              {ok ? <Check /> : <Cross />}
                            </span>
                          )
                        })()}
                      </td>
                      {(['pd', 'lgd'] as const).map((t) => (
                        <td key={t} className="px-2 py-1.5 text-center"
                            onClick={(e) => { e.stopPropagation(); toggleShortlist(pk, t, c.column) }}>
                          <span className={`inline-block h-3 w-3 rounded-sm border ${
                            shortlist[t].includes(c.column)
                              ? 'border-accent bg-accent' : 'border-hairline'}`}
                            title={`Add to the ${t.toUpperCase()} candidate list`} />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {rows.length > 120 && (
              <p className="px-3 py-2 text-micro text-ink-muted">
                Showing the strongest 120 of {num(rows.length)}. Narrow the filters to see the rest.
              </p>
            )}

          </div>
        </Card>

        <div className="space-y-3">
          {shown && detail.data && <SeriesChart d={detail.data}
            label={rows.find((c) => c.column === shown)?.label ?? shown}
            unit={rows.find((c) => c.column === shown)?.unit ?? ''}
            target={target} />}
          <Shortlist portfolio={pk} rows={lib.data.rows} />
        </div>
      </div>
    </div>
  )
}

/** The unit a transform leaves behind. A twelve-month change in a yield is in
 *  percentage points, not in the yield's own unit, and a growth rate is a
 *  percentage whatever the base variable measures. */
function unitAfter(transform: string, unit: string): string {
  if (transform === 'yoy' || transform === 'qoq_annualized') return '%'
  if (transform === 'level') return unit
  return unit ? `${unit} chg` : 'chg'
}

function SeriesChart({ d, label, unit, target }: {
  d: import('../lib/api').MacroSeries; label: string; unit: string
  target: 'pd' | 'lgd'
}) {
  const m = mode()
  const months = d.points.map((p) => p.month)
  const raw = {
    mev: d.points.map((p) => p.value),
    tgt: d.points.map((p) => (target === 'pd' ? p.pd : p.lgd)),
  }
  const mevUnit = unitAfter(d.transform, unit)
  const option = useMemo(() => ({
    ...baseOption(),
    // `top` clears the legend; `left` clears the rotated axis title. The title
    // used to sit above the plot and was clipped by the grid.
    grid: { left: 66, right: 16, top: 26, bottom: 46, containLabel: false },
    xAxis: { ...baseOption().xAxis, type: 'category' as const, data: months,
             name: 'Reporting month', nameLocation: 'middle' as const, nameGap: 30,
             nameTextStyle: { color: ink(m).muted, fontSize: 10 },
             axisLabel: { ...(baseOption().xAxis as any).axisLabel,
                          formatter: (v: string) => monthShort(v), interval: 35 } },
    // ONE axis, in standard deviations. Both series are z-scored, which is what
    // makes a shared axis honest — see the caption.
    yAxis: { ...baseOption().yAxis, type: 'value' as const, scale: true,
             name: 'Standard deviations from the mean',
             nameLocation: 'middle' as const, nameRotate: 90, nameGap: 44,
             nameTextStyle: { color: ink(m).muted, fontSize: 10 },
             axisLabel: { ...(baseOption().yAxis as any).axisLabel,
                          formatter: (v: number) => (v > 0 ? `+${v}σ` : v < 0 ? `${v}σ` : '0') } },
    // The z-score sets the position; the reader wants the published number. Both
    // are shown, native units first.
    tooltip: { confine: true, ...crosshairTooltip(
      (v, p) => {
        const native = Array.isArray(p?.value) ? p.value[2] : null
        const u = p?.seriesIndex === 0 ? mevUnit : ''
        return native == null ? `${fmtZ(v)}`
          : `${num3(native)}${u ? ` ${u}` : ''} · ${fmtZ(v)}`
      },
      (v) => monthLong(v)) },
    legend: { ...baseOption().legend, show: true, top: 0 },
    series: [
      lineSeries({ name: label,
                   data: triples(months, standardise(raw.mev), raw.mev),
                   color: series(1, m) }),
      lineSeries({ name: target === 'pd' ? 'default rate (log-odds)' : 'severity (logit)',
                   data: triples(months, standardise(raw.tgt), raw.tgt),
                   color: deemphasis(m) }),
    ],
  }), [d, label, target, m, mevUnit])
  return (
    <Card>
      <CardHead title="Candidate against the target"
        subtitle={`${d.key} · ${d.transform}${d.lag_months ? ` · lag ${d.lag_months}m` : ''}`}
        caption="Both series are z-scored, so the single axis reads in standard deviations. Read timing and turning points, not levels. The tooltip carries the published value in its own units." />
      <div className="p-3">
        <EChart height={230} ariaLabel="Candidate macro term against the target series"
          option={option as any}
          table={{ columns: ['Month', label, 'target'],
                   rows: d.points.map((p) => [p.month,
                     p.value == null ? '' : p.value.toFixed(3),
                     (target === 'pd' ? p.pd : p.lgd)?.toFixed(3) ?? '']) }} />
      </div>
    </Card>
  )
}

/** `[category, plotted z-score, published value]`. ECharts plots the first two
 *  and carries the third to the tooltip. */
const triples = (x: string[], z: (number | null)[], raw: (number | null)[]) =>
  x.map((k, i) => [k, z[i], raw[i]] as [string, number | null, number | null])

const fmtZ = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}σ`
const num3 = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1)
  : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3))

/** z-scores, so two series in different units share one axis honestly. */
function standardise(v: (number | null)[]): (number | null)[] {
  const ok = v.filter((z): z is number => z != null && Number.isFinite(z))
  if (ok.length < 2) return v
  const mu = ok.reduce((a, b) => a + b, 0) / ok.length
  const sd = Math.sqrt(ok.reduce((a, b) => a + (b - mu) ** 2, 0) / ok.length) || 1
  return v.map((z) => (z == null || !Number.isFinite(z) ? null : (z - mu) / sd))
}

function Shortlist({ portfolio, rows }: { portfolio: PortfolioKey; rows: MacroCandidate[] }) {
  const shortlist = useUi((s) => s.macroShortlist[portfolio])
  const toggleShortlist = useUi((s) => s.toggleShortlist)
  const byColumn = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.column, r])), [rows])
  const Section = ({ t, label }: { t: 'pd' | 'lgd'; label: string }) => (
    <div className="border-t border-hairline px-4 py-2.5">
      <p className="text-micro uppercase tracking-wider text-ink-muted">{label}</p>
      {shortlist[t].length === 0 ? (
        <p className="mt-1 text-tiny text-ink-muted">
          Nothing selected. The {t.toUpperCase()} model falls back to its documented
          default macro terms.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {shortlist[t].map((col) => {
            const c = byColumn[col]
            return (
              <li key={col} className="flex items-center gap-2 text-tiny">
                <span className="min-w-0 flex-1 truncate text-ink">
                  {c ? `${c.key} · ${c.transform_label}${c.lag_months ? ` · lag ${c.lag_months}m` : ''}` : col}
                </span>
                {c?.stationary === false && (
                  <span style={{ color: 'var(--status-warning)' }} title="Not stationary on this window.">
                    ADF {c.adf_p?.toFixed(2)}
                  </span>
                )}
                {c && (
                  <span className="tnum text-ink-muted">
                    r {ratio(t === 'pd' ? c.pd_r : c.lgd_r, 2)}
                  </span>
                )}
                <button onClick={() => toggleShortlist(portfolio, t, col)}
                  className="text-ink-muted hover:text-ink">remove</button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
  return (
    <Card>
      <CardHead title="Shortlist"
        caption="These appear as candidates in the Explore stage of each model. Selecting one here does not add it to a specification." />
      <Section t="pd" label="PD model" />
      <Section t="lgd" label="LGD model" />
    </Card>
  )
}
