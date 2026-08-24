import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  api, type LgdScreenRow, type LgdTreatment, type PortfolioKey,
  type SeverityCurve, type SeverityFreq, type SeverityLevel, type SeverityPoint,
} from '../lib/api'
import { Card, CardHead, Skeleton, StatTile } from '../components/ui'
import SeverityOverTime, { severitySummary } from '../components/SeverityOverTime'
import { Editor } from '../components/BinningEditor'
import { chrome, deemphasis, ink, mode, sequential, series } from '../design/tokens'
import { num, pct, ratio } from '../lib/format'
import { useUi, NONE } from '../lib/store'

/** Explore, for the LGD model.
 *
 *  The same stage as PD Explore, on a different population and a different
 *  target. PD is estimated on every account-month with a binary outcome; LGD is
 *  estimated on defaulted account-months only, and the outcome is a proportion.
 *  Everything here follows from that: the population is smaller, the bucket
 *  statistic is a mean rather than a rate, and the reference scale is the logit
 *  of the mean because the fitted model is a fractional logit. */
export default function LgdExploreSurface() {
  const { portfolio = 'consumer' } = useParams()
  const pk = portfolio as PortfolioKey
  const nav = useNavigate()
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const setFittedLgd = useUi((s) => s.setFittedLgd)
  const [column, setColumn] = useState<string | null>(null)
  const [maxBins, setMaxBins] = useState(5)

  // Terms promoted from the macro search are ranked here beside the tape columns,
  // on the same population and the same statistic.
  const macroShortlist = useUi((s) => s.macroShortlist[pk]?.lgd ?? NONE) as string[]
  const screen = useQuery({
    queryKey: ['lgdscreen', portfolio, macroShortlist.join(',')],
    queryFn: () => api.lgdScreen(portfolio, macroShortlist),
  })
  const dist = useQuery({ queryKey: ['lgddist', portfolio], queryFn: () => api.lgdDistribution(portfolio) })
  // The dependent variable through time. Monthly by default because the panel
  // is monthly; the chart reports how many periods were too thin to average,
  // which on a book that resolves two workouts a month is the whole story.
  const [sotFreq, setSotFreq] = useState<SeverityFreq>('MS')
  const sot = useQuery({
    queryKey: ['lgd-sot', portfolio, sotFreq],
    queryFn: () => api.lgdSeverityOverTime(portfolio, sotFreq),
  })

  useEffect(() => { setColumn(null) }, [portfolio])
  const selected = column ?? screen.data?.rows[0]?.column ?? null

  const spec = fittedLgd?.spec ?? screen.data?.default_spec ?? { drivers: [], categoricals: [] }
  const inSpec = (r: LgdScreenRow) =>
    (r.kind === 'numeric' ? spec.drivers : spec.categoricals).includes(r.column)

  const treatment: LgdTreatment = !selected ? 'continuous'
    : spec.treatments?.[selected]
      ?? (spec.categoricals.includes(selected) ? 'bins' : 'continuous')

  const setTreatment = (t: LgdTreatment) => {
    if (!selected) return
    setFittedLgd(pk, {
      spec: { ...spec, treatments: { ...(spec.treatments ?? {}), [selected]: t } },
      hash: '', fittedAt: '', meanLgd: NaN, nDefaults: 0,
    })
  }

  /** Selecting here writes the LGD specification, so Fit opens with it ready. */
  const toggle = (r: LgdScreenRow) => {
    const key = r.kind === 'numeric' ? 'drivers' : 'categoricals'
    const cur = spec[key]
    const next = {
      ...spec,
      [key]: cur.includes(r.column) ? cur.filter((c) => c !== r.column) : [...cur, r.column],
    }
    setFittedLgd(pk, { spec: next, hash: '', fittedAt: '', meanLgd: NaN, nDefaults: 0 })
  }

  if (screen.isLoading || !screen.data) return <div className="p-4"><Skeleton className="h-[560px]" /></div>

  const n = spec.drivers.length + spec.categoricals.length

  return (
    <div className="space-y-3 p-4">
      <Card>
        <CardHead
          title="LGD model — Explore"
          subtitle={`${num(screen.data.n_defaults)} defaulted account-months`}
          caption="Loss given default is estimated on defaulted rows only, because those are the rows where a realised severity exists. The candidate list below is ranked on that population, not on the full tape."
        />
        <div className="grid gap-3 border-t border-hairline p-3 sm:grid-cols-4">
          <StatTile label="Defaults" value={num(screen.data.n_defaults)} />
          <StatTile label="Mean realised LGD" value={pct(screen.data.mean_lgd * 100, 1)} />
          <StatTile label="Resolved with no loss" value={pct(screen.data.zero_loss_share * 100, 1)}
            explain="Defaults where recovery covered the balance in full." />
          <StatTile label="Selected drivers" value={String(n)} />
        </div>
        <div className="flex items-center gap-3 border-t border-hairline px-4 py-2">
          <p className="text-tiny text-ink-secondary">
            Selecting a driver here sets the LGD specification. Fit applies it.
          </p>
          <button onClick={() => nav(`/${portfolio}/lgd/fit`)} disabled={n === 0}
            className="ml-auto rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
            Go to Fit →
          </button>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <DriverRanking rows={screen.data.rows} selected={selected}
                       onSelect={setColumn} inSpec={inSpec} onToggle={toggle} />
        <div className="space-y-3">
          {selected && (
            <SeverityTreatment portfolio={portfolio} column={selected}
                               treatment={treatment} onTreatment={setTreatment}
                               inSpec={spec.drivers.includes(selected)
                                       || spec.categoricals.includes(selected)}
                               maxBins={maxBins} onMaxBins={setMaxBins}
                               nKnots={spec.n_knots ?? 3}
                               onNKnots={(n) => setFittedLgd(pk, {
                                 spec: { ...spec, n_knots: n },
                                 hash: '', fittedAt: '', meanLgd: NaN, nDefaults: 0,
                               })} />
          )}
          {selected && (
            <SeverityView portfolio={portfolio} column={selected}
                          treatment={treatment}
                          knots={spec.knots?.[selected]}
                          nKnots={spec.n_knots ?? 3}
                          onKnots={(k) => setFittedLgd(pk, {
                            spec: {
                              ...spec,
                              knots: k?.length
                                ? { ...(spec.knots ?? {}), [selected]: k }
                                : Object.fromEntries(Object.entries(spec.knots ?? {})
                                    .filter(([c]) => c !== selected)),
                            },
                            hash: '', fittedAt: '', meanLgd: NaN, nDefaults: 0,
                          })} />
          )}
          {dist.data && <SeverityDistribution d={dist.data} />}
          {sot.data && (
            <Card>
              <CardHead
                title="Realised severity through time"
                subtitle={severitySummary(sot.data)}
                caption="The distribution above shows the SHAPE of the target; this shows when. Severity on a secured book follows collateral values, so it moves with the cycle — a driver earns its place by tracking that movement. The band is the 95% interval of the cohort mean."
              />
              <SeverityOverTime d={sot.data} freq={sotFreq} onFreq={setSotFreq}
                                busy={sot.isFetching} height={220} />
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

/** `key@transform@lag` reads as a column name, not as a quantity. */
const TRANSFORM_LABEL: Record<string, string> = {
  level: 'level', diff: '1m change', four_quarter_change: '12m change',
  yoy: '12m % change', qoq_annualized: '3m change ann.',
}
export function macroTermLabel(column: string): string {
  if (!column.includes('@')) return column
  const [key, transform, lag] = column.split('@')
  const t = TRANSFORM_LABEL[transform] ?? transform
  return `${key} · ${t}${Number(lag) ? ` · lag ${lag}m` : ''}`
}

function DriverRanking({ rows, selected, onSelect, inSpec, onToggle }: {
  rows: LgdScreenRow[]
  selected: string | null
  onSelect: (c: string) => void
  inSpec: (r: LgdScreenRow) => boolean
  onToggle: (r: LgdScreenRow) => void
}) {
  const strongest = Math.max(...rows.map((r) => r.spread), 0.01)
  return (
    <Card className="self-start">
      <CardHead
        title="Candidate drivers"
        subtitle={`${rows.length} candidates, ranked by rank correlation`}
        caption="Spread is the difference between the highest and lowest bucket mean, in percentage points of severity. It states the same relationship in the units of the answer."
      />
      <div className="thin-scroll max-h-[640px] overflow-auto">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="sticky top-0 border-y border-hairline bg-surface text-tiny text-ink-muted">
            <tr>
              <th className="w-7 px-2 py-2" />
              <th className="px-2 py-2 font-medium">Driver</th>
              <th className="w-12 px-2 py-2 text-right font-medium"
                  title="Spearman rank correlation between the driver and realised severity, on defaulted rows.">ρ</th>
              <th className="w-24 px-2 py-2 text-right font-medium">Spread</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const active = r.column === selected
              return (
                <tr key={r.column}
                    className={`cursor-pointer border-b border-hairline/60 ${
                      active ? 'bg-accent-soft' : 'hover:bg-sunken/60'}`}
                    onClick={() => onSelect(r.column)}>
                  <td className="px-2 py-1.5" onClick={(e) => { e.stopPropagation(); onToggle(r) }}>
                    <span className={`block h-3 w-3 rounded-sm border ${
                      inSpec(r) ? 'border-accent bg-accent' : 'border-hairline'}`}
                      title={inSpec(r) ? 'In the LGD specification' : 'Add to the LGD specification'} />
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`block truncate font-mono text-tiny ${active ? 'text-ink' : 'text-ink-secondary'}`}
                          title={r.column}>
                      {macroTermLabel(r.column)}
                    </span>
                    <div className="mt-0.5 flex gap-1">
                      {r.macro && (
                        <span className="rounded bg-sunken px-1 text-micro text-ink-muted"
                              title="Joined at the default month. Macro drivers are what make predicted severity respond to a scenario.">
                          macro
                        </span>
                      )}
                      {r.caution && (
                        <span className="rounded bg-sunken px-1 text-micro text-ink-muted"
                              title="The name suggests an operational identifier rather than a risk driver. Check what it records before using it.">
                          identifier?
                        </span>
                      )}
                      {r.levels != null && (
                        <span className="text-micro text-ink-muted">{r.levels} levels</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right tnum text-ink-secondary">
                    {r.spearman == null ? '—' : ratio(r.spearman, 2)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="h-1.5 rounded-sm"
                            style={{ width: `${Math.max(2, (r.spread / strongest) * 40)}px`,
                                     background: sequential(0.55) }} />
                      <span className="w-9 text-right tnum text-ink-secondary">
                        {pct(r.spread * 100, 0)}
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** Mean severity across a driver, with the volume behind each bucket. */
/** The univariate view: how the driver itself is distributed on the defaulted
 *  population. A bucket mean cannot be read without it — a driver with almost no
 *  spread among defaults will produce flat buckets whatever its relationship
 *  with severity, and one with a spike at a default value will produce a bucket
 *  that is really one value. */
function DriverDistribution({ data }: { data: SeverityCurve }) {
  const m = mode()
  const d = data.distribution
  if (!d) return null
  if (data.kind === 'categorical' || !d.bins?.length) {
    return (
      <Card>
        <CardHead title="Driver distribution" subtitle={`${data.column} · ${d.distinct} distinct values`} />
        <p className="px-4 pb-3 text-tiny text-ink-secondary">
          Level shares are shown in the panel above, beside each level's severity.
        </p>
      </Card>
    )
  }
  const maxN = Math.max(...d.bins.map((b) => b.n), 1)
  return (
    <Card>
      <CardHead
        title="Driver distribution"
        subtitle={`${macroTermLabel(data.column)} on ${num(data.n_defaults)} defaults · median ${d.median?.toPrecision(4)} · ${d.distinct} distinct values`}
        caption="The driver's own spread among defaults, before any relationship with severity. A driver that barely varies on this population cannot separate it, whatever the bucket means suggest."
      />
      <div className="flex px-4 pb-1 pt-3">
        <div className="relative mr-2 w-10 shrink-0" style={{ height: 96 }}>
          <span className="absolute right-0 top-0 text-micro tabular-nums text-ink-muted">
            {num(maxN)}
          </span>
          <span className="absolute bottom-0 right-0 text-micro tabular-nums text-ink-muted">0</span>
          <span className="absolute left-0 top-1/2 whitespace-nowrap text-micro text-ink-secondary"
                style={{ transform: 'translate(-14px,-50%) rotate(-90deg)' }}>
            Defaults
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-end gap-[2px] border-b border-hairline" style={{ height: 96 }}>
            {d.bins.map((b, i) => (
              <div key={i} className="flex-1 rounded-t-sm"
                   style={{ height: `${(b.n / maxN) * 100}%`, background: sequential(0.45, m) }}
                   title={`${b.lo.toPrecision(4)} to ${b.hi.toPrecision(4)}: ${num(b.n)} defaults`} />
            ))}
          </div>
          <div className="flex justify-between pt-1 text-micro tabular-nums text-ink-muted">
            <span>{d.p1?.toPrecision(4)}</span>
            <span title="Median">{d.median?.toPrecision(4)}</span>
            <span>{d.p99?.toPrecision(4)}</span>
          </div>
          <p className="pt-0.5 text-center text-micro text-ink-secondary">{data.column}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 px-4 pb-3 text-micro text-ink-muted">
        <span>p25 {d.p25?.toPrecision(4)}</span>
        <span>p75 {d.p75?.toPrecision(4)}</span>
        <span>mean {d.mean?.toPrecision(4)}</span>
        <span>sd {d.sd?.toPrecision(3)}</span>
        <span>{pct(data.missing_rate * 100, 1)} missing</span>
      </div>
    </Card>
  )
}

function SeverityView({ portfolio, column, treatment, knots, nKnots, onKnots }: {
  portfolio: string; column: string; treatment: LgdTreatment
  knots: number[] | undefined; nKnots: number
  onKnots: (k: number[] | undefined) => void
}) {
  const [resolution, setResolution] = useState(12)
  const { data, isFetching } = useQuery({
    queryKey: ['lgdcurve', portfolio, column, resolution, (knots ?? []).join(',')],
    queryFn: () => api.lgdCurve(portfolio, column, resolution, knots),
    placeholderData: (prev) => prev,
  })
  const place = useMutation({
    mutationFn: () => api.lgdAutoKnots(portfolio, column, nKnots),
    onSuccess: (r) => { if (r.knots.length) onKnots(r.knots) },
  })

  // The count re-places the knots — see the note on the PD side. Keyed on a
  // CHANGE, so opening a saved model keeps the knots it was fitted with.
  const lastN = useRef<number | null>(null)
  useEffect(() => {
    const prev = lastN.current
    lastN.current = nKnots
    if (prev === null || prev === nKnots || treatment !== 'spline') return
    place.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nKnots, treatment])
  useEffect(() => {
    lastN.current = nKnots
    if (!knots && treatment === 'spline') place.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [column, treatment])
  if (!data) return <Skeleton className="h-[360px]" />
  if (data.note) {
    return (
      <Card>
        <CardHead title="Severity across the driver" subtitle={column} />
        <p className="px-4 py-6 text-xs text-ink-secondary">{data.note}</p>
      </Card>
    )
  }
  return (
    <>
    <Card>
      <CardHead
        title="Severity across the driver"
        subtitle={data.kind === 'numeric'
          ? `${macroTermLabel(column)} · ${data.resolution} buckets of ${num(data.n_defaults)} defaults`
          : `${macroTermLabel(column)} · ${data.n_levels} levels`}
        caption="Mean realised severity per bucket, with a 95% interval from the spread within the bucket, and the number of defaults behind each bucket on the same axis. The reference curve is a univariate fractional logit fitted on those rows by the same estimator the LGD model uses."
        right={data.kind === 'numeric' && (
          <span className="flex items-center gap-1"
                title="Buckets are quantiles of the driver. Fewer buckets means more defaults in each and a narrower interval.">
            <button onClick={() => setResolution((v) => Math.max(4, v - 4))}
              className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">−</button>
            <span className="tabular-nums text-micro text-ink-muted">{resolution}</span>
            <button onClick={() => setResolution((v) => Math.min(24, v + 4))}
              className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-muted hover:text-ink">+</button>
          </span>
        )}
      />
      <div className="flex flex-wrap items-baseline gap-x-4 border-y border-hairline px-4 py-2 text-tiny text-ink-secondary">
        <span>Book mean {pct(data.mean_lgd * 100, 1)}</span>
        <span>Spread across buckets {pct(data.spread * 100, 1)}</span>
        {data.spearman != null && <span>Rank correlation {ratio(data.spearman, 2)}</span>}
        {data.candidates?.linear && (
          <span title={`Both curves are fitted on ${data.candidates.linear.n} defaults with the LGD model's own estimator — a fractional logit, not a logistic. BIC is divided by the estimated dispersion (${data.candidates.spline?.dispersion.toFixed(2) ?? data.candidates.linear.dispersion.toFixed(2)}): it is derived from a genuine likelihood and this is a quasi-likelihood, so the unscaled form misprices the extra columns. The Wald test uses the sandwich covariance, because twice the quasi-log-likelihood difference is not chi-squared.`}>
            deviance R² {ratio(data.candidates.linear.deviance_r2, 3)}
            {data.candidates.spline && treatment === 'spline' && (
              <> → {ratio(data.candidates.spline.deviance_r2, 3)} · ΔBIC{' '}
                {data.candidates.spline.delta_bic > 0 ? '+' : ''}
                {data.candidates.spline.delta_bic.toFixed(1)}
                {data.candidates.spline.wald_p != null && (
                  <> · Wald p {data.candidates.spline.wald_p < 0.001 ? '<0.001'
                    : data.candidates.spline.wald_p.toFixed(3)}</>
                )}</>
            )}
          </span>
        )}
        {data.missing_rate > 0.001 && <span>{pct(data.missing_rate * 100, 1)} missing</span>}
      </div>
      <div className={isFetching ? 'opacity-60 transition-opacity' : ''}>
        {data.kind === 'numeric'
          ? <NumericSeverity data={data} treatment={treatment}
                             knots={knots ?? data.candidate_knots ?? []}
                             custom={!!knots} onKnots={onKnots} nKnots={nKnots}
                             onAutoPlace={() => place.mutate()}
                             placing={place.isPending}
                             gain={place.data?.gain_over_quantile ?? null} />
          : <LevelSeverity data={data} />}
      </div>
    </Card>
    <DriverDistribution data={data} />
    </>
  )
}

const H = 290
const VOL_H = 50
const PAD = { l: 76, r: 16, t: 14, b: 42 }

function formatTick(v: number): string {
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${Math.round(v / 1e3)}k`
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toPrecision(2)
}

function NumericSeverity({ data, treatment, knots, custom, onKnots, nKnots,
                           onAutoPlace, placing, gain }: {
  data: SeverityCurve; treatment: LgdTreatment
  knots: number[]; custom: boolean; onKnots: (k: number[] | undefined) => void
  nKnots: number; onAutoPlace: () => void; placing: boolean; gain: number | null
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [W, setW] = useState(720)
  const [drag, setDrag] = useState<number | null>(null)
  const [local, setLocal] = useState<number[] | null>(null)
  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(360, e.contentRect.width)))
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const m = mode()
  const k = ink(m)
  const c = chrome(m)
  const pts = data.points as SeverityPoint[]
  const [dlo, dhi] = data.domain ?? [0, 1]
  const hiY = Math.min(1, Math.max(...pts.map((p) => p.hi95)) + 0.05)
  const loY = Math.max(0, Math.min(...pts.map((p) => p.lo95)) - 0.05)
  const plotH = H - VOL_H - PAD.t - PAD.b
  const x = (v: number) => PAD.l + ((v - dlo) / (dhi - dlo || 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - loY) / (hiY - loY || 1)) * plotH
  const maxN = Math.max(...pts.map((p) => p.n), 1)
  const volY = PAD.t + plotH + 16
  const showKnots = treatment === 'spline'
  const drawnKnots = local ?? knots
  const cand = data.candidates
  const xInv = (px: number) =>
    dlo + ((px - PAD.l) / (W - PAD.l - PAD.r || 1)) * (dhi - dlo)
  const pointerX = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    return Math.min(dhi, Math.max(dlo, xInv(e.clientX - r.left)))
  }
  const onMove = (e: React.PointerEvent) => {
    if (drag == null) return
    const next = [...(local ?? knots)]
    next[drag] = pointerX(e)
    setLocal(next)
  }
  const commit = () => {
    if (drag != null && local) onKnots([...local].sort((a, b) => a - b))
    setDrag(null); setLocal(null)
  }
  const path = (fitted: number[]) => (data.grid ?? [])
    .map((g, i) => `${i ? 'L' : 'M'}${x(g).toFixed(1)},${y(fitted[i]).toFixed(1)}`)
    .join(' ')
  const ticks = useMemo(
    () => [0, 0.25, 0.5, 0.75, 1].map((t) => loY + t * (hiY - loY)), [loY, hiY])

  return (
    <div ref={wrap} className="px-4 pb-3 pt-2">
      <svg ref={svg} width={W} height={H} className="block select-none"
           style={{ cursor: drag != null ? 'ew-resize' : 'default' }}
           onPointerMove={onMove} onPointerUp={commit} onPointerLeave={commit}
           onDoubleClick={showKnots ? (e) => {
             const r = svg.current!.getBoundingClientRect()
             onKnots([...knots, xInv(e.clientX - r.left)].sort((a, b) => a - b))
           } : undefined}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={c.grid} strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={k.muted}>
              {pct(t * 100, 0)}
            </text>
          </g>
        ))}
        {/* the book mean, so each bucket is read against it */}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(data.mean_lgd)} y2={y(data.mean_lgd)}
              stroke={c.axis} strokeWidth={1} />
        <text x={W - PAD.r} y={y(data.mean_lgd) - 4} textAnchor="end" fontSize={9} fill={k.muted}>
          book mean
        </text>

        {/* the observed relationship, bucket to bucket */}
        <path fill="none" stroke={sequential(0.55, m)} strokeWidth={2} strokeLinejoin="round"
              d={pts.map((p, i) =>
                `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.mean_lgd).toFixed(1)}`).join(' ')} />
        {/* the fitted spline, shown only while its knots are being placed */}
        {showKnots && cand?.spline && (
          <path d={path(cand.spline.fitted)} fill="none" stroke={series(1, m)}
                strokeWidth={2} strokeDasharray="5 3" />
        )}

        {pts.map((p, i) => (
          <g key={i}>
            <line x1={x(p.x)} x2={x(p.x)} y1={y(p.lo95)} y2={y(p.hi95)}
                  stroke={c.axis} strokeWidth={1.5} />
            <circle cx={x(p.x)} cy={y(p.mean_lgd)} r={4}
                    fill={sequential(0.55, m)} stroke={c.border} strokeWidth={1}>
              <title>
                {`${p.lo.toPrecision(4)} to ${p.hi.toPrecision(4)}\n` +
                 `${num(p.n)} defaults · mean severity ${pct(p.mean_lgd * 100, 1)}\n` +
                 `${pct(p.zero_share * 100, 0)} resolved with no loss`}
              </title>
            </circle>
          </g>
        ))}

        {showKnots && drawnKnots.map((kn, i) => (
          <g key={i}>
            <line x1={x(kn)} x2={x(kn)} y1={PAD.t} y2={PAD.t + plotH}
                  stroke={series(1, m)} strokeWidth={1} strokeOpacity={0.5} />
            <rect x={x(kn) - 5} y={PAD.t + plotH - 4} width={10} height={12} rx={3}
                  fill={series(1, m)} style={{ cursor: 'ew-resize' }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    ;(e.target as Element).setPointerCapture(e.pointerId)
                    setDrag(i)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    onKnots(knots.filter((_, j) => j !== i))
                  }}>
              <title>Drag to move. Double-click to remove.</title>
            </rect>
          </g>
        ))}
        <text transform={`translate(14,${PAD.t + plotH / 2}) rotate(-90)`}
              textAnchor="middle" fontSize={10} fill={k.secondary}>
          Mean realised LGD
        </text>
        <text transform={`translate(14,${volY + (VOL_H - 18) / 2}) rotate(-90)`}
              textAnchor="middle" fontSize={9} fill={k.muted}>
          Defaults
        </text>
        {pts.map((p, i) => {
          const w = Math.max(2, (x(p.hi) - x(p.lo)) - 2)
          const h = Math.max(1, (p.n / maxN) * (VOL_H - 18))
          return (
            <rect key={i} x={x(p.lo) + 1} y={volY + (VOL_H - 18) - h} width={w} height={h}
                  rx={1.5} fill={deemphasis(m)}>
              <title>{`${num(p.n)} defaults`}</title>
            </rect>
          )
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={volY + VOL_H - 18} y2={volY + VOL_H - 18}
              stroke={c.axis} strokeWidth={1} />
        {[dlo, dlo + (dhi - dlo) / 4, (dlo + dhi) / 2, dhi - (dhi - dlo) / 4, dhi]
          .map((t, i) => (
            <text key={i} x={x(t)} y={H - 22} fontSize={10} fill={k.muted}
                  textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>
              {formatTick(t)}
            </text>
          ))}
        <text x={PAD.l + (W - PAD.l - PAD.r) / 2} y={H - 5} textAnchor="middle"
              fontSize={10} fill={k.secondary}>
          {data.column}
        </text>
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-micro text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: sequential(0.55, m) }} />
          observed, bucket to bucket
        </span>
        {showKnots ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded"
                    style={{ background: `repeating-linear-gradient(90deg, ${series(1, m)} 0 5px, transparent 5px 8px)` }} />
              spline at {drawnKnots.length} knot{drawnKnots.length === 1 ? '' : 's'}
            </span>
            <span className="rounded-ctl px-1.5 py-0.5 font-medium"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              Drag a knot. Double-click the plot to add one, a knot to remove it. Set how many under “knots” above.
            </span>
            <button onClick={onAutoPlace} disabled={placing}
              className="rounded border border-hairline px-1.5 py-0.5 text-micro text-ink-secondary hover:text-ink disabled:opacity-50"
              title="Search knot positions against the severity fit instead of placing them at quantiles.">
              {placing ? 'placing…' : `place ${nKnots} knots automatically`}
            </button>
            {gain != null && gain !== 0 && (
              <span>{gain > 0 ? '+' : ''}{gain.toFixed(1)} log-likelihood vs quantiles</span>
            )}
            {custom && (
              <button onClick={() => onKnots(undefined)} className="underline hover:text-ink">
                reset to quantiles
              </button>
            )}
          </>
        ) : (
          <span>The hairline across the plot is the book mean.</span>
        )}
      </div>
    </div>
  )
}

function LevelSeverity({ data }: { data: SeverityCurve }) {
  const m = mode()
  const pts = data.points as SeverityLevel[]
  const maxN = Math.max(...pts.map((p) => p.n), 1)
  const hi = Math.min(1, Math.max(...pts.map((p) => p.hi95)) + 0.05)
  const at = (v: number) => (v / hi) * 100
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * hi)
  return (
    <div className="px-4 pb-3 pt-2">
      {/* the scale the dots sit on, stated rather than implied */}
      <div className="mb-1 grid grid-cols-[140px_minmax(0,1fr)_96px] items-end gap-2">
        <span />
        <div className="relative h-7">
          {ticks.map((t, i) => (
            <span key={i} className="absolute bottom-0 text-micro tabular-nums text-ink-muted"
                  style={{ left: `${at(t)}%`,
                           transform: i === 0 ? 'none'
                             : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
              {pct(t * 100, 0)}
            </span>
          ))}
          <span className="absolute bottom-3.5 left-1/2 -translate-x-1/2 text-micro text-ink-secondary">
            Mean realised LGD
          </span>
        </div>
        <span className="text-right text-micro text-ink-secondary">Defaults · mean</span>
      </div>
      <div className="space-y-1">
        {pts.map((p) => (
          <div key={p.level} className="grid grid-cols-[140px_minmax(0,1fr)_96px] items-center gap-2">
            <span className="truncate font-mono text-tiny text-ink-secondary" title={p.level}>
              {p.level}
            </span>
            <div className="relative h-4">
              <div className="absolute top-0 h-4 w-px bg-hairline"
                   style={{ left: `${at(data.mean_lgd)}%` }} title="Book mean" />
              <div className="absolute top-[7px] h-0.5 rounded"
                   style={{ left: `${at(p.lo95)}%`, width: `${at(p.hi95) - at(p.lo95)}%`,
                            background: 'var(--chrome-axis)' }} />
              <div className="absolute top-1 h-2 w-2 rounded-full"
                   style={{ left: `calc(${at(p.mean_lgd)}% - 4px)`,
                            background: p.thin ? deemphasis(m) : sequential(0.55, m) }} />
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <div className="h-2 rounded-sm" title={`${num(p.n)} defaults`}
                   style={{ width: `${Math.max(2, (p.n / maxN) * 40)}px`, background: deemphasis(m) }} />
              <span className="w-11 text-right text-micro tabular-nums text-ink-muted">
                {pct(p.mean_lgd * 100, 1)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="pt-2 text-micro text-ink-muted">
        Dot is the mean severity for the level, the rule behind it is the 95% interval,
        the hairline is the book mean. Grey dots carry fewer than 30 defaults.
      </p>
    </div>
  )
}

function SeverityDistribution({ d }: { d: import('../lib/api').LgdDistribution }) {
  const m = mode()
  const body = d.histogram.filter((h) => !h.zero)
  const zero = d.histogram.find((h) => h.zero)
  const maxN = Math.max(...d.histogram.map((h) => h.n), 1)
  return (
    <Card>
      <CardHead
        title="Distribution of realised severity"
        subtitle={`${num(d.n_defaults)} defaults · mean ${pct(d.mean_lgd * 100, 1)} · median ${pct(d.median_lgd * 100, 1)}`}
        caption="Realised severity is a proportion, and it is not evenly spread. A share of defaults resolve with no loss and a smaller share lose the full balance. The fitted model estimates the conditional mean and does not model those two points separately."
      />
      <div className="flex px-4 pb-1 pt-3">
        {/* y-axis: counts, so a bar height can be read rather than compared */}
        <div className="relative mr-2 w-12 shrink-0" style={{ height: 148 }}>
          <span className="absolute -left-1 top-1/2 origin-center -rotate-90 whitespace-nowrap text-micro text-ink-secondary"
                style={{ transform: 'translate(-6px,-50%) rotate(-90deg)' }}>
            Defaults
          </span>
          {[0, 0.5, 1].map((t) => (
            <span key={t} className="absolute right-0 text-micro tabular-nums text-ink-muted"
                  style={{ bottom: `${t * 100}%`, transform: 'translateY(50%)' }}>
              {num(Math.round(maxN * t))}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-end gap-[3px] border-b border-hairline" style={{ height: 148 }}>
            <div className="flex flex-col items-center justify-end" style={{ height: '100%' }}>
              <div className="w-5 rounded-t-sm"
                   style={{ height: `${((zero?.n ?? 0) / maxN) * 100}%`, background: sequential(0.7, m) }}
                   title={`${num(zero?.n ?? 0)} defaults resolved with no loss`} />
            </div>
            <div className="mx-2 h-full w-px bg-hairline" />
            {body.map((h, i) => (
              <div key={i} className="flex-1 rounded-t-sm"
                   style={{ height: `${(h.n / maxN) * 100}%`, background: sequential(0.4, m) }}
                   title={`${(h.lo * 100).toFixed(0)}–${(h.hi * 100).toFixed(0)}%: ${num(h.n)} defaults`} />
            ))}
          </div>
          <div className="flex justify-between pt-1 text-micro tabular-nums text-ink-muted">
            <span>0%<span className="ml-1 normal-case">no loss ({pct(d.zero_loss_share * 100, 0)})</span></span>
            <span>25%</span><span>50%</span><span>75%</span>
            <span>100%<span className="ml-1">full loss ({pct(d.total_loss_share * 100, 0)})</span></span>
          </div>
          <p className="pt-0.5 text-center text-micro text-ink-secondary">Realised severity</p>
        </div>
      </div>
    </Card>
  )
}


const TREATMENTS: { key: LgdTreatment; label: string; blurb: string }[] = [
  { key: 'bins', label: 'Bins',
    blurb: 'Discretised, then one indicator per bin less a reference. Imposes no '
         + 'shape. Costs a parameter per bin, which on a few hundred defaults is '
         + 'a real price.' },
  { key: 'continuous', label: 'Continuous',
    blurb: 'The standardised driver, one column, linear in the logit of severity.' },
  { key: 'spline', label: 'Spline',
    blurb: 'A piecewise-linear basis at quantile knots, orthogonalised. Represents '
         + 'curvature without discretising, and is usually what fixes a failing '
         + 'link test.' },
]

/** How this driver enters the severity model, and the binning behind it.
 *
 *  The same four treatments the PD side offers. What changes is the statistic:
 *  the bin carries a MEAN rather than an event rate, and the strength measure is
 *  a deviance R-squared rather than an information value. A fractional target has
 *  no events and no non-events, so neither an information value nor a weight of
 *  evidence is defined on it, and neither is offered. */
function SeverityTreatment({ portfolio, column, treatment, onTreatment, inSpec,
                             maxBins, onMaxBins, nKnots, onNKnots }: {
  portfolio: string; column: string
  treatment: LgdTreatment; onTreatment: (t: LgdTreatment) => void
  inSpec: boolean; maxBins: number; onMaxBins: (n: number) => void
  nKnots: number; onNKnots: (n: number) => void
}) {
  // Edges are editable, exactly as on the PD side: the endpoint accepts an
  // explicit edge list, so a dragged edge round-trips and the means, shares and
  // deviance R-squared all recompute against it.
  const [edges, setEdges] = useState<number[] | null>(null)
  useEffect(() => { setEdges(null) }, [column, maxBins])
  const { data, isFetching } = useQuery({
    queryKey: ['lgdbinning', portfolio, column, maxBins, edges?.join(',') ?? ''],
    queryFn: () => api.lgdBinning(portfolio, column, maxBins, edges ?? undefined),
    placeholderData: (prev) => prev,
  })
  const discretised = treatment === 'bins'
  if (!data) return <Skeleton className="h-40" />
  const cost = treatment === 'bins' ? Math.max(data.bins.length - 1, 0) : 1

  return (
    <Card>
      <CardHead
        title={discretised ? `Binning — ${macroTermLabel(column)}`
                           : `Treatment — ${macroTermLabel(column)}`}
        subtitle={discretised
          ? `${data.bins.length} bins · ${num(data.n_total)} defaults · book mean ${pct(data.book_mean * 100, 1)}`
          : `${num(data.n_total)} defaults · book mean ${pct(data.book_mean * 100, 1)}`}
        right={discretised && data.supports_continuous ? (
          <span className="flex items-center gap-1 text-micro text-ink-muted">
            bins
            <button onClick={() => onMaxBins(Math.max(2, maxBins - 1))}
              className="rounded border border-hairline px-1.5 hover:text-ink">−</button>
            <span className="tabular-nums">{maxBins}</span>
            <button onClick={() => onMaxBins(Math.min(10, maxBins + 1))}
              className="rounded border border-hairline px-1.5 hover:text-ink">+</button>
          </span>
        ) : undefined}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline px-4 py-2">
        <span className="text-tiny text-ink-muted">Enters the model as</span>
        <div className="flex items-center gap-0.5 rounded-ctl bg-sunken p-0.5">
          {TREATMENTS.map((o) => {
            const ok = data.supports_continuous
              || (o.key !== 'continuous' && o.key !== 'spline')
            return (
              <button key={o.key} disabled={!ok} onClick={() => onTreatment(o.key)}
                title={ok ? o.blurb : 'Not available for a categorical driver.'}
                className={`rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors ${
                  o.key === treatment ? 'bg-raised text-ink shadow-sm'
                    : ok ? 'text-ink-muted hover:text-ink-secondary'
                         : 'cursor-not-allowed text-ink-muted/40'}`}>
                {o.label}
              </button>
            )
          })}
        </div>
        <span className="text-tiny text-ink-muted">
          <span className="tnum text-ink-secondary">{cost}</span>
          {cost === 1 ? ' column' : ' columns'}
        </span>
        {/* The knot COUNT lives here, beside the treatment that uses it; the
            POSITIONS are dragged on the relationship panel below. PD carried
            this control and severity did not, so there was no way to ask for a
            different number of knots on this side at all. */}
        {treatment === 'spline' && (
          <span className="flex items-center gap-1.5 text-tiny text-ink-muted">
            <span className="h-4 w-px bg-hairline" />
            <span>knots</span>
            <button onClick={() => onNKnots(Math.max(1, nKnots - 1))}
              title="One fewer knot. Each knot is a parameter, so fewer is a smoother curve estimated on more rows per segment."
              className="rounded border border-hairline px-1.5 text-micro hover:text-ink">−</button>
            <span className="tnum text-ink-secondary">{nKnots}</span>
            <button onClick={() => onNKnots(Math.min(8, nKnots + 1))}
              title="One more knot. Each knot is a parameter; on a few thousand workouts three or four is usually the most the population supports."
              className="rounded border border-hairline px-1.5 text-micro hover:text-ink">+</button>
          </span>
        )}
        {discretised && (
          <span className="text-tiny text-ink-muted"
                title="Deviance R-squared of the binned model against an intercept-only one, on the same quasi-likelihood the model is fitted with. The fractional analogue of an information value, which is not defined here.">
            deviance R² <span className="tnum text-ink-secondary">{ratio(data.deviance_r2, 3)}</span>
          </span>
        )}
        {!inSpec && (
          <span className="ml-auto text-micro text-ink-muted">not in the specification</span>
        )}
      </div>

      {discretised ? (
        <div className="overflow-x-auto">
          {data.kind === 'numeric' && data.domain && (
            <Editor
              view={{
                column: data.column, edges: data.edges, domain: data.domain,
                histogram: data.histogram,
                valueLabel: 'Mean severity',
                formatValue: (v) => pct(v * 100, 1),
                toneLabel: 'Logit shift',
                bins: data.bins.map((b) => ({
                  label: b.label, value: b.mean, tone: b.weight,
                  share: b.share, n: b.n,
                  detail: [`Mean severity ${pct(b.mean * 100, 1)}`,
                           `Logit shift ${b.weight.toFixed(3)}`],
                })),
              }}
              onEdgesChange={setEdges} pending={isFetching} />
          )}
          <table className="w-full text-xs">
            <thead className="border-y border-hairline text-tiny text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Bin</th>
                <th className="px-3 py-2 text-right font-medium">Defaults</th>
                <th className="px-3 py-2 text-right font-medium">Share</th>
                <th className="px-3 py-2 text-right font-medium">Mean severity</th>
                <th className="px-3 py-2 text-right font-medium"
                    title="logit(bin mean) − logit(book mean): how far this bin sits from the book, on the scale the model works in. A descriptive statistic, not an encoding — the bins enter as indicators.">
                  Logit shift
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.bins.map((b) => (
                <tr key={b.index} className="border-b border-hairline/60">
                  <td className="px-3 py-1.5 font-mono text-tiny">{b.label}</td>
                  <td className="px-3 py-1.5 text-right tnum text-ink-muted">{num(b.n)}</td>
                  <td className="px-3 py-1.5 text-right tnum text-ink-muted">
                    {pct(b.share * 100, 0)}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum">{pct(b.mean * 100, 1)}</td>
                  <td className="px-3 py-1.5 text-right tnum">{ratio(b.weight, 3)}</td>
                  <td className="px-3 py-1.5">
                    <div className="relative h-2 w-24">
                      <div className="absolute inset-y-0 left-1/2 w-px bg-hairline" />
                      <div className="absolute inset-y-0 rounded-sm"
                           style={{
                             background: b.weight > 0 ? 'var(--status-critical)' : 'var(--series-1)',
                             left: b.weight > 0 ? '50%' : undefined,
                             right: b.weight <= 0 ? '50%' : undefined,
                             width: `${Math.min(Math.abs(b.weight) / 2.5, 1) * 50}%`,
                           }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.warnings.length > 0 && (
            <p className="px-4 py-2 text-micro leading-relaxed text-ink-muted">
              {data.warnings.join(' ')}
            </p>
          )}
        </div>
      ) : (
        <p className="px-4 pb-2.5 text-micro text-ink-muted">
          {treatment === 'continuous'
            ? 'No binning and no deviance R² — both are properties of a discretisation.'
            : `A piecewise-linear basis at quantile knots. On ${num(data.n_total)} defaults, each knot is a parameter; three is usually the most this population supports.`}
        </p>
      )}
    </Card>
  )
}
