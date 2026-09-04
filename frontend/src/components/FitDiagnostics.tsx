import { useMemo } from 'react'
import type { FitResponse } from '../lib/api'
import { Card, CardHead, StatusPill } from './ui'
import EChart from '../charts/EChart'
import Legend from '../charts/Legend'
import { baseOption, crosshairTooltip, barSeries, lineSeries, markTooltip, escapeHtml, xName, yName } from '../charts/base'
import { accent, deemphasis, ink, mode, series } from '../design/tokens'
import { useUi } from '../lib/store'
import { num, pct, ratio } from '../lib/format'

export default function FitDiagnostics({ r }: { r: FitResponse }) {
  const theme = useUi((s) => s.theme)
  const m = mode()
  const k = ink(m)
  const ref = r.diagnostics.reference_slice

  const roc = useMemo(() => ({
    ...baseOption(),
    grid: { left: 44, right: 16, top: 12, bottom: 34 },
    tooltip: crosshairTooltip((v) => v.toFixed(3)),
    xAxis: { ...(baseOption().xAxis as object), type: 'value' as const, min: 0, max: 1,
             name: 'False positive rate', nameLocation: 'middle' as const, nameGap: 22,
             nameTextStyle: { color: k.muted, fontSize: 10 },
             axisLabel: { color: k.muted, fontSize: 10 } },
    yAxis: { ...(baseOption().yAxis as object), type: 'value' as const, min: 0, max: 1,
             axisLabel: { color: k.muted, fontSize: 10 } },
    series: [
      lineSeries({ name: 'Model', color: accent(), area: true,
        data: r.diagnostics.roc.map((p) => [p.fpr, p.tpr] as [number, number]) }),
      // the no-skill reference: a chance model, in the de-emphasis grey
      lineSeries({ name: 'No skill', color: deemphasis(m), dashed: true,
        data: [[0, 0], [1, 1]] as [number, number][] }),
    ],
  }), [r, theme])

  const ksOpt = useMemo(() => ({
    ...baseOption(),
    grid: { left: 44, right: 16, top: 12, bottom: 30 },
    tooltip: crosshairTooltip((v) => v.toFixed(3)),
    xAxis: { ...(baseOption().xAxis as object), type: 'value' as const,
             axisLabel: { color: k.muted, fontSize: 10,
                          formatter: (v: number) => v.toFixed(3) } },
    yAxis: { ...(baseOption().yAxis as object), type: 'value' as const, min: 0, max: 1,
             axisLabel: { color: k.muted, fontSize: 10 } },
    series: [
      lineSeries({ name: 'Cumulative bad', color: series(2, m),
        data: r.diagnostics.ks_curve.map((p) => [p.score, p.cum_bad] as [number, number]) }),
      lineSeries({ name: 'Cumulative good', color: series(0, m),
        data: r.diagnostics.ks_curve.map((p) => [p.score, p.cum_good] as [number, number]) }),
    ],
  }), [r, theme])

  const calib = useMemo(() => {
    const b = r.diagnostics.calibration.bins
    return {
      ...baseOption(),
      grid: { left: 48, right: 16, top: 12, bottom: 34 },
      tooltip: crosshairTooltip((v) => `${v.toFixed(2)}%`),
      xAxis: { ...(baseOption().xAxis as object), type: 'value' as const,
               name: 'Predicted (% / yr)', nameLocation: 'middle' as const, nameGap: 22,
               nameTextStyle: { color: k.muted, fontSize: 10 },
               axisLabel: { color: k.muted, fontSize: 10 } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               axisLabel: { color: k.muted, fontSize: 10 } },
      series: [
        lineSeries({ name: 'Perfect calibration', color: deemphasis(m), dashed: true,
          data: b.length ? [[b[0].predicted_annual, b[0].predicted_annual],
                            [b.at(-1)!.predicted_annual, b.at(-1)!.predicted_annual]] as [number, number][] : [] }),
        { ...lineSeries({ name: 'Observed', color: accent(), showSymbol: true,
            data: b.map((x) => [x.predicted_annual, x.observed_annual] as [number, number]) }) },
      ],
    }
  }, [r, theme])

  const gains = useMemo(() => {
    const g = r.diagnostics.gains
    return {
      ...baseOption(),
      grid: { left: 48, right: 16, top: 12, bottom: 44 },
      tooltip: markTooltip((p: any) => {
        const row = g[p.dataIndex]
        return `<div style="font-size:11px;color:${k.muted}">Decile ${escapeHtml(p.name)}</div>` +
          `<div style="font-weight:600">${p.value.toFixed(2)}× the book's default rate</div>` +
          `<div style="font-size:11px;color:${k.muted}">${num(row.events)} defaults in ${num(row.n)} rows · ` +
          `${row.event_rate_annual.toFixed(2)}%/yr realised</div>`
      }),
      xAxis: { ...(baseOption().xAxis as object), type: 'category' as const,
               data: g.map((x) => String(x.decile)),
               ...xName('Decile of predicted probability (1 = highest predicted risk)', 28),
               axisLabel: { color: k.muted, fontSize: 10 } },
      yAxis: { ...(baseOption().yAxis as object), type: 'value' as const,
               ...yName('Realised rate ÷ book rate', 34),
               axisLabel: { color: k.muted, fontSize: 10, formatter: (v: number) => `${v}×` } },
      // One series, one colour. The old one-hue ramp across the bars encoded
      // the decile index a second time — the x axis already carries it — and
      // an unexplained colour gradient reads as a hidden variable.
      series: [{
        ...barSeries({
          name: 'Realised ÷ book rate', maxWidth: 22, color: accent(),
          data: g.map((x) => x.lift),
        }),
        markLine: {
          symbol: 'none', silent: true,
          lineStyle: { color: deemphasis(m), width: 1, type: 'dashed' as const },
          label: { show: true, position: 'insideEndTop' as const, fontSize: 9,
                   color: k.muted, formatter: 'book rate (1.0×)' },
          data: [{ yAxis: 1 }],
        },
      }],
    }
  }, [r, theme])

  const cal = r.diagnostics.calibration

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <Card>
          <CardHead title="ROC curve" subtitle={`${ref} slice`}
            caption="True positive rate against false positive rate across all thresholds. The diagonal represents no discrimination." />
          <Legend items={[{ name: 'Model', color: accent() },
                          { name: 'No skill', color: deemphasis(m) }]} />
          <EChart option={roc} height={210} ariaLabel="ROC curve"
            table={{ columns: ['False positive rate', 'True positive rate'],
                     rows: r.diagnostics.roc.map((p) => [Number(p.fpr.toFixed(4)), Number(p.tpr.toFixed(4))]) }} />
        </Card>

        <Card>
          <CardHead title="Kolmogorov-Smirnov" subtitle={`Maximum separation ${ratio(r.diagnostics[ref as 'test']?.ks)}`}
            caption="The widest gap between the cumulative good and bad distributions, and the score where it happens." />
          <Legend items={[{ name: 'Cumulative bad', color: series(2, m) },
                          { name: 'Cumulative good', color: series(0, m) }]} />
          <EChart option={ksOpt} height={210} ariaLabel="KS separation curve"
            table={{ columns: ['Score', 'Cumulative bad', 'Cumulative good', 'Separation'],
                     rows: r.diagnostics.ks_curve.map((p) => [Number(p.score.toFixed(5)),
                       Number(p.cum_bad.toFixed(4)), Number(p.cum_good.toFixed(4)), Number(p.sep.toFixed(4))]) }} />
        </Card>

        <Card>
          <CardHead title="Decile lift" subtitle={`${ref} slice · accounts ranked by predicted probability, split into ten equal groups`}
            caption="Each bar is one decile's realised default rate divided by the whole book's, on the same slice. A value of 1.0× is the book average; a well-ranking model concentrates defaults in the first deciles and depletes the last." />
          <Legend kind="rect" items={[
            { name: 'Realised rate ÷ book rate', color: accent() },
            { name: 'Book average (1.0×)', color: deemphasis(m) },
          ]} />
          <EChart option={gains} height={210} ariaLabel="Decile lift" externalLegend
            table={{ columns: ['Decile', 'Rows', 'Events', 'Event rate (%/yr)', 'Lift', 'Cumulative capture (%)'],
                     rows: r.diagnostics.gains.map((g) => [g.decile, g.n, g.events,
                       Number(g.event_rate_annual.toFixed(3)), Number(g.lift.toFixed(3)),
                       Number(g.cumulative_capture_pct.toFixed(1))]) }} />
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHead title="Calibration"
            subtitle={`Hosmer-Lemeshow ${cal.hl_statistic.toFixed(1)} on ${cal.hl_dof} d.f., p = ${cal.hl_p_value.toFixed(4)}`}
            caption="Predicted against observed, by decile of predicted probability. Points on the dashed line are perfectly calibrated."
            right={<span className="cursor-help" title={cal.hl_note}>
              <StatusPill severity="warning">read the table, not the p-value</StatusPill>
            </span>} />
          <EChart option={calib} height={220} ariaLabel="Calibration curve"
            table={{ columns: ['Decile', 'Rows', 'Predicted (%/yr)', 'Observed (%/yr)', 'Events'],
                     rows: cal.bins.map((b) => [b.bin, b.n, Number(b.predicted_annual.toFixed(3)),
                       Number(b.observed_annual.toFixed(3)), b.events]) }} />
        </Card>

        <Card>
          <CardHead title="Slice comparison"
            caption="Test is a held-out sample of accounts from the fitting period. Out of time is a later period the model was not fitted on. The difference between them indicates how the model transfers across periods." />
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-hairline text-tiny text-ink-muted">
                <th className="px-4 py-2 font-medium">Slice</th>
                <th className="px-3 py-2 text-right font-medium">Rows</th>
                <th className="px-3 py-2 text-right font-medium">Events</th>
                <th className="px-3 py-2 text-right font-medium">AUC</th>
                <th className="px-3 py-2 text-right font-medium">KS</th>
                <th className="px-3 py-2 text-right font-medium">Brier</th>
                <th className="px-3 py-2 text-right font-medium">Actual</th>
                <th className="px-3 py-2 text-right font-medium">Predicted</th>
              </tr>
            </thead>
            <tbody>
              {(['train', 'test', 'oot'] as const).map((s) => {
                const d = r.diagnostics[s]
                if (!d) return null
                return (
                  <tr key={s} className="border-b border-hairline">
                    <td className="px-4 py-1.5 text-ink">
                      {s === 'oot' ? 'Out of time' : s === 'test' ? 'Test' : 'Train'}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{num(d.n)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{num(d.events)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink">{d.auc.toFixed(4)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{d.ks.toFixed(4)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{d.brier.toFixed(5)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{pct(d.actual_annual)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-secondary">{pct(d.predicted_annual)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  )
}
