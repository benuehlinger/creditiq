import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Card, CardHead, Skeleton, StatusPill } from './ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import { baseOption, crosshairTooltip, lineSeries, markLineAt, xName, yName, gridFor } from '../charts/base'
import { ink, mode, series, status } from '../design/tokens'
import { useUi } from '../lib/store'
import { month } from '../lib/format'

/**
 * The macro surface: the catalog, the history-to-scenario splice, and the
 * frequency reconciliation shown rather than buried.
 *
 * The reconciliation panel is the one a validator will linger on. It overlays the
 * published quarterly points on the derived monthly series and reports the
 * benchmarking residual, so "this aggregates back exactly" is something you can
 * point at rather than something you assert.
 */
export default function MacroPanel({ portfolio }: { portfolio: string }) {
  const theme = useUi((s) => s.theme)
  const m = mode()
  const k = ink(m)
  const catalog = useQuery({ queryKey: ['mevcat'], queryFn: api.mevCatalog })
  const allowed = catalog.data?.by_portfolio?.[portfolio] ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const active = selected ?? allowed[0] ?? 'unemployment_rate'
  const baseKey = active.endsWith('_yoy') ? active.slice(0, -4) : active

  const spliced = useQuery({ queryKey: ['spliced', baseKey],
    queryFn: () => api.spliced('severely_adverse', [baseKey]) })
  const baseline = useQuery({ queryKey: ['spliced-base', baseKey],
    queryFn: () => api.spliced('baseline', [baseKey]) })
  const recon = useQuery({ queryKey: ['recon', baseKey],
    queryFn: () => api.reconciliation(baseKey) })

  // The y-axis names the SERIES and its published unit — "Unemployment rate (%)"
  // rather than a bare number. Falls back to the key while the catalog loads.
  const meta = catalog.data?.variables?.find((x) => x.key === baseKey)
  const unitLabel = meta ? `${meta.label}${meta.unit ? ` (${meta.unit})` : ''}` : baseKey

  const spliceOption = useMemo(() => {
    const sa = spliced.data?.series[baseKey]
    const bl = baseline.data?.series[baseKey]
    if (!sa) return null
    return {
      ...baseOption(),
      grid: gridFor({ left: 68, right: 18, top: 14, bottom: 46 }),
      tooltip: crosshairTooltip((v) => v.toFixed(2), (d) => month(d)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               ...xName('Month', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const, scale: true,
               ...yName(unitLabel, 44),
               axisLabel: { color: k.muted, fontSize: 10 } },
      series: [
        // Explicit palette SLOTS, not the portfolio accent. On the CRE book the
        // accent IS slot 3, so "Actual" and "Severely adverse" came out the same
        // colour. Slots 1-3 are the three that clear the all-pairs gate, so all
        // three series here are safe together in both modes.
        { ...lineSeries({ name: 'Actual (FRED)', color: series(0, m),
            data: sa.points.filter((p) => !p.projected)
              .map((p) => [p.date, p.value] as [string, number]) }),
          markLine: markLineAt(sa.splice_date, 'projection begins', status.serious) },
        lineSeries({ name: 'Baseline', color: series(1, m), dashed: true,
          data: (bl?.points ?? []).filter((p) => p.projected)
            .map((p) => [p.date, p.value] as [string, number]) }),
        lineSeries({ name: 'Severely adverse', color: series(2, m), dashed: true,
          data: sa.points.filter((p) => p.projected)
            .map((p) => [p.date, p.value] as [string, number]) }),
      ],
    }
  }, [spliced.data, baseline.data, baseKey, theme])

  const reconOption = useMemo(() => {
    const d = recon.data
    if (!d || d.native !== 'Q') return null
    return {
      ...baseOption(),
      grid: gridFor({ left: 68, right: 18, top: 14, bottom: 46 }),
      tooltip: crosshairTooltip((v) => v.toFixed(3), (dt) => month(dt)),
      xAxis: { ...(baseOption().xAxis as object), type: 'time' as const,
               ...xName('Month', 28),
               axisLabel: { color: k.muted, fontSize: 10, formatter: '{yyyy}' } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const, scale: true,
               ...yName(unitLabel, 44),
               axisLabel: { color: k.muted, fontSize: 10 } },
      series: [
        lineSeries({ name: 'Derived monthly', color: series(0, m),
          data: d.derived.map((p) => [p.date, p.value] as [string, number]) }),
        { ...lineSeries({ name: 'Published quarterly', color: series(2, m),
            showSymbol: true,
            data: d.raw.map((p) => [p.date, p.value] as [string, number]) }),
          lineStyle: { width: 0 }, symbolSize: 9 },
      ],
    }
  }, [recon.data, theme])

  if (catalog.isLoading) return <Skeleton className="h-[420px]" />
  const d = recon.data
  const sp = spliced.data?.series[baseKey]

  return (
    <div className="space-y-3">
      <Card>
        <CardHead title="Macroeconomic variables"
          subtitle={`${catalog.data?.variables.length} in the catalog · ${allowed.length} offered for this portfolio`}
          caption={catalog.data?.why_restricted}
          methodology="mev-catalog" />
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {allowed.map((key) => {
            const meta = catalog.data?.variables.find((v) => v.key === key)
            return (
              <button key={key} onClick={() => setSelected(key)}
                title={meta?.note ?? undefined}
                className={`rounded border px-2 py-1 font-mono text-micro transition-colors ${
                  key === active ? 'border-accent text-accent'
                    : 'border-hairline text-ink-muted hover:text-ink'}`}>
                {key}
              </button>
            )
          })}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title={`${d?.label ?? baseKey} — history and scenario paths`}
            subtitle={sp ? `Seam at ${month(sp.splice_date)} · rebase rule: ${sp.rule}` : ''}
            caption="FRED history joined to the Federal Reserve's published forward paths. History is drawn solid, the projected path dashed, and the join is marked."
            methodology="scenario-splice" />
          {spliceOption ? (
            <>
              <Legend items={[{ name: 'Actual (FRED)', color: series(0, m) },
                              { name: 'Baseline', color: series(1, m) },
                              { name: 'Severely adverse', color: series(2, m) }]} />
              <EChart option={spliceOption} height={230}
                ariaLabel={`${baseKey} history and scenario paths`}
                table={{ columns: ['Date', 'Value', 'Projected'],
                         rows: (sp?.points ?? []).map((p) => [p.date, Number(p.value.toFixed(4)),
                           p.projected ? 'yes' : 'no']) }} />
              <p className="px-4 pb-2 text-micro leading-snug text-ink-muted">
                {sp?.rule === 'ratio'
                  ? 'Rebased onto our history, because our proxy sits on a different index base from the Fed’s variable. The scenario’s percentage path is preserved exactly.'
                  : 'Not shifted. This is an absolute scale, so the jump at the seam is the shock arriving — removing it would cap the stress.'}
              </p>
            </>
          ) : <Skeleton className="h-[230px]" />}
        </Card>

        <Card>
          <CardHead title="Frequency reconciliation"
            subtitle={d ? `${d.native} native · ${d.method}` : ''}
            caption="The published quarterly points plotted over the derived monthly series."
            methodology="frequency-reconciliation"
            right={d?.identity_holds != null ? (
              <StatusPill severity={d.identity_holds ? 'good' : 'critical'}>
                {d.identity_holds ? 'identity holds' : 'identity broken'}
              </StatusPill>
            ) : undefined} />
          {d?.native === 'Q' && reconOption ? (
            <>
              <Legend items={[{ name: 'Derived monthly', color: series(0, m) },
                              { name: 'Published quarterly', color: series(2, m) }]} />
              <EChart option={reconOption} height={230}
                ariaLabel={`${baseKey} frequency reconciliation`}
                table={{ columns: ['Date', 'Derived monthly'],
                         rows: d.derived.map((p) => [p.date, Number(p.value.toFixed(4))]) }} />
              <p className="px-4 pb-2 text-micro leading-snug text-ink-muted">
                Worst benchmarking residual{' '}
                <span className="tnum text-ink-secondary">{d.residual_relative?.toExponential(2)}</span>{' '}
                relative. The derived monthly series aggregates back to the published
                quarterly value to machine precision — not approximately.
                {d.raw_is_derived && ' The published series is a growth rate here, so the benchmark target is the reconstructed quarterly level.'}
              </p>
            </>
          ) : (
            <div className="px-4 py-10 text-center text-xs leading-relaxed text-ink-muted">
              {d ? `${d.label} is published ${d.native === 'M' ? 'monthly' : d.native === 'D' ? 'daily' : 'weekly'}, so no benchmarking is needed — it is ${d.native === 'M' ? 'passed through' : d.method}.`
                 : 'Select a variable.'}
            </div>
          )}
        </Card>
      </div>

      {d && (
        <Card>
          <CardHead title="Metadata contract"
            caption="Each variable's conversion method is taken from this table rather than from a single rule applied to all series." />
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-xs md:grid-cols-4">
            <Meta k="FRED series" v={d.series_id} mono />
            <Meta k="Native frequency" v={d.native} />
            <Meta k="Stock or flow" v={d.kind} />
            <Meta k="Measure" v={d.measure} />
            <Meta k="Aggregation" v={d.agg} />
            <Meta k="Unit" v={d.unit} />
            <Meta k="Rebased to history" v={d.rebase ? 'yes' : 'no'} />
            <Meta k="Derivation" v={d.derive ?? 'none'} />
          </div>
          {d.note && (
            <p className="border-t border-hairline px-4 py-2 text-tiny leading-relaxed text-ink-secondary">
              {d.note}
            </p>
          )}
        </Card>
      )}
    </div>
  )
}

function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-micro uppercase tracking-wider text-ink-muted">{k}</div>
      <div className={`text-ink-secondary ${mono ? 'font-mono text-tiny' : ''}`}>{v}</div>
    </div>
  )
}
