import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type ColumnProfile } from '../lib/api'
import { Card, CardHead, Skeleton, StatTile, StatusPill } from '../components/ui'
import { useUi } from '../lib/store'
import EChart from '../charts/EChart'
import { baseOption, crosshairTooltip, lineSeries, markLineAt, xName, gridFor } from '../charts/base'
import { byUnit, num, pct, month } from '../lib/format'
import { accent, ink, mode, status } from '../design/tokens'

/** The caption and the annotated month are per-portfolio.
 *
 *  A caption states what the series is and the definition behind it. It does
 *  not narrate the chart, and it does not explain how the demonstration panel
 *  was produced: neither is information the reader can act on. The marked month
 *  differs per book because the cycle that drives each one differs. */
const STORY: Record<string, { caption: string; mark: [string, string] }> = {
  consumer: {
    caption:
      'Monthly default rate by performance date. Default is 90+ days past due '
      + 'or charge-off, with a 3 month outcome window.',
    mark: ['2020-03-01', 'Mar 2020'],
  },
  mortgage: {
    caption:
      'Monthly default rate by performance date. Default is 180+ days past due '
      + 'or foreclosure referral, so the peak arrives later than on an unsecured book.',
    mark: ['2020-03-01', 'Mar 2020'],
  },
  cre: {
    caption:
      'Monthly default rate by performance date. Default is nonaccrual or a '
      + 'downgrade to a default grade. The rate rises from 2022 with the '
      + 'commercial property cycle. Property type is available on the Explore stage.',
    mark: ['2022-06-01', 'CRE index peak'],
  },
}

export default function DataSurface() {
  const { portfolio = 'consumer' } = useParams()
  const theme = useUi((s) => s.theme)
  const pf = useQuery({ queryKey: ['portfolios'], queryFn: api.portfolios })
  const health = useQuery({ queryKey: ['health', portfolio], queryFn: () => api.dataHealth(portfolio) })
  const ts = useQuery({ queryKey: ['ts', portfolio], queryFn: () => api.timeseries(portfolio) })

  const info = pf.data?.find((p) => p.key === portfolio)

  const story = STORY[portfolio] ?? STORY.consumer

  const rateOption = useMemo(() => {
    if (!ts.data) return null
    const k = ink(mode())
    const pts = ts.data.map((d) => [d.performance_date, d.annual_default_rate_pct] as [string, number])
    return {
      ...baseOption(),
      grid: gridFor({ left: 62, right: 18, top: 14, bottom: 48 }),
      tooltip: crosshairTooltip((v) => `${v.toFixed(2)}%`, (d) => month(d)),
      xAxis: {
        ...(baseOption().xAxis as object),
        ...xName('Reporting month'),
        type: 'time' as const,
        axisLabel: { color: k.muted, fontSize: 11, formatter: '{yyyy}' },
      },
      yAxis: {
        ...(baseOption().yAxis as object),
        type: 'value' as const,
        name: 'Annualized default rate (%)',
        nameLocation: 'middle' as const,
        nameGap: 38,
        nameTextStyle: { color: k.muted, fontSize: 11 },
        axisLabel: { color: k.muted, fontSize: 11, formatter: (v: number) => `${v}%` },
      },
      series: [
        {
          ...lineSeries({ name: 'Realized default rate', data: pts, color: accent(), area: true }),
          markLine: markLineAt(story.mark[0], story.mark[1], status.serious),
        },
      ],
    }
    // theme is a dependency because the resolved colours change with it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ts.data, theme, story])

  if (!info || health.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-64" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  const failing = health.data?.issues.filter((i) => !i.passed) ?? []

  return (
    <div className="space-y-3 p-4">
      {/* ── the headline: one chart, then the figures that describe it ── */}
      <Card>
        <CardHead
          title="Realized default rate by performance date"
          subtitle={`${info.label} · ${month(info.window[0])} – ${month(info.window[1])} · monthly`}
          caption={story.caption}
          methodology="default-rate"
        />
        {rateOption && (
          <EChart
            option={rateOption}
            height={230}
            ariaLabel={`${info.label} realized default rate by performance date`}
            refetching={ts.isFetching && !ts.isLoading}
            table={{
              columns: ['Performance date', 'Account-months', 'Defaults', 'Annualized rate (%)'],
              rows: (ts.data ?? []).map((d) => [
                d.performance_date, d.observations, d.defaults,
                Number(d.annual_default_rate_pct.toFixed(3)),
              ]),
            }}
          />
        )}
      </Card>

      <Card>
        <div className="grid grid-cols-2 divide-x divide-hairline md:grid-cols-5">
          <StatTile label="Accounts" value={num(info.n_accounts)}
            explain="Distinct accounts in the book." />
          <StatTile label="Account-months" value={num(info.n_rows)}
            explain="Observations. One row per account per performance date, the unit a discrete-time hazard model is fitted on." />
          <StatTile label="Defaults" value={num(info.n_defaults)}
            explain={`Months in which the target fired. Definition: ${info.target.description}.`} />
          <StatTile label="Default rate" value={pct(info.annual_default_rate_pct)} unit="/yr"
            explain="Defaults divided by account-months at risk, multiplied by 12. A hazard, not a stock ratio." />
          <StatTile label="Data health" value={String(health.data?.score ?? '—')} unit="/ 100"
            explain="Weighted so a critical structural failure cannot be offset by passing cosmetic checks." />
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        {/* ── panel integrity ── */}
        <Card>
          <CardHead
            title="Panel integrity"
            subtitle={`${health.data?.n_rows.toLocaleString()} rows · ${health.data?.n_columns} columns`}
            caption="Structural checks on the panel: duplicate keys, gaps in the observation grid, rows after a terminal event, and target definition consistency. A model will fit despite these failures."
            methodology="data-health"
            right={
              <StatusPill severity={failing.some((f) => f.severity === 'critical') ? 'critical'
                : failing.length ? 'warning' : 'good'}>
                {failing.length ? `${failing.length} to review` : 'All checks pass'}
              </StatusPill>
            }
          />
          <ul className="divide-y divide-hairline">
            {health.data?.issues.map((it) => (
              <li key={it.check} className="flex items-start gap-3 px-4 py-2.5">
                <span className="mt-0.5 shrink-0">
                  <StatusPill severity={it.passed ? 'good' : it.severity as any}>
                    {it.passed ? 'pass' : it.severity}
                  </StatusPill>
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink">{it.check}</div>
                  <p className="mt-0.5 text-tiny leading-snug text-ink-secondary">{it.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        {/* ── column profile ── */}
        <Card>
          <CardHead
            title="Column profile"
            subtitle={`${health.data?.columns.length} columns · sorted by role`}
            caption="Missingness, cardinality and shape for every column."
          />
          <ColumnTable columns={health.data?.columns ?? []} />
        </Card>
      </div>
    </div>
  )
}

const ROLE_ORDER = ['target', 'driver', 'candidate', 'outcome', 'date', 'identifier', 'other']

function ColumnTable({ columns }: { columns: ColumnProfile[] }) {
  const sorted = [...columns].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name),
  )
  return (
    <div className="thin-scroll max-h-[520px] overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-hairline text-tiny text-ink-muted">
            <th className="px-3 py-2 font-medium">Column</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 text-right font-medium">Missing</th>
            <th className="px-3 py-2 text-right font-medium">Unique</th>
            <th className="px-3 py-2 text-right font-medium">Median</th>
            <th className="px-3 py-2 text-right font-medium">Outliers</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.name} className="border-b border-hairline hover:bg-sunken/60">
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-tiny text-ink">{c.name}</span>
                  {c.note && (
                    <span title={c.note} className="cursor-help">
                      <StatusPill severity={c.note.startsWith('PLANTED LEAKAGE') ? 'critical' : 'warning'}>
                        {c.note.startsWith('PLANTED LEAKAGE') ? 'leakage'
                          : c.note.startsWith('PLANTED NOISE') ? 'noise' : 'collinear'}
                      </StatusPill>
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-1.5 text-tiny text-ink-muted">{c.role}</td>
              <td className="px-3 py-1.5 text-right tnum"
                  style={{ color: c.missing_pct > 20 ? 'var(--status-warning)' : undefined }}>
                {c.missing_pct > 0 ? pct(c.missing_pct, 1) : '—'}
              </td>
              <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{num(c.n_unique)}</td>
              <td className="px-3 py-1.5 text-right tnum text-ink-secondary">
                {byUnit(c.p50, c.unit)}
              </td>
              <td className="px-3 py-1.5 text-right tnum text-ink-secondary">
                {c.n_outliers ? num(c.n_outliers) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
