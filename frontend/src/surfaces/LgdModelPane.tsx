import { useEffect, useMemo, useState, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, asMap, type SeverityFreq, type LgdBacktest, type LgdDiagnostics,
         type LgdFitResult, type LgdSpecPayload, type PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, Skeleton, StatTile, StatusPill, ViewTabs } from '../components/ui'
import Eq from '../components/Eq'
import { Check, Close } from '../components/icons'
import SeverityOverTime from '../components/SeverityOverTime'
import FitProgress, { LGD_PHASES } from '../components/FitProgress'
import { num, pct, ratio } from '../lib/format'
import { useUi } from '../lib/store'
import { macroTermLabel } from './LgdVariableDetail'

/** LGD model — Fit.
 *
 *  E[LGD | X] = sigmoid(X . beta), estimated by the Papke-Wooldridge fractional
 *  response quasi-likelihood on `lgd_realised`. The estimator is consistent for
 *  the conditional mean of a proportion without assuming the proportion is a
 *  count of Bernoulli trials.
 *
 *  Terms enter linearly. The population is defaulted account-months only, which
 *  on the commercial book is a few hundred rows, so no binning or spline
 *  apparatus is offered here. */
/** The fitted severity model: controls, verdict figures, coefficients,
 *  diagnostics and backtest. The right pane of the LGD workbench when no
 *  driver is open. The candidate list belongs to the workbench. */
export default function LgdModelPane({ portfolio, spec, onOpenVariable }: {
  portfolio: string
  /** THE specification — the same object the workbench's candidate list edits.
   *  This pane used to keep its own copy, synced by an effect whose
   *  dependencies missed driver changes; the list would say "5 drivers in the
   *  specification" while the pane fitted an empty one and errored "select at
   *  least one driver". One spec, owned by the parent, no copy to go stale. */
  spec: LgdSpecPayload
  onOpenVariable?: (column: string) => void
}) {
  const pk = portfolio as PortfolioKey
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const setFittedLgd = useUi((s) => s.setFittedLgd)

  const cand = useQuery({ queryKey: ['lgdcand', portfolio], queryFn: () => api.lgdCandidates(portfolio) })



  // What the last fit did. A refit of an unchanged specification returns an
  // identical model — correctly — so nothing on screen moves and the button
  // reads as broken.
  const [outcome, setOutcome] = useState<string | null>(null)
  // The previous result, held in a ref rather than read from `fit.data`.
  // `onSuccess` closes over the render that created it, so `fit.data` there is
  // whatever it was when the mutation was defined — undefined — and every
  // refit reported itself as a first fit.
  const prevFit = useRef<LgdFitResult | null>(null)
  const qc = useQueryClient()

  // The fitted model, as a QUERY keyed on the severity hash. Switching among
  // challengers changes the hash, the query fetches or serves from cache, and
  // switching BACK is instant with no request — comparing two models must not
  // cost a re-estimation each way. This also deletes the effect that
  // re-estimated "when behind", along with the sync race it carried.
  const fitQuery = useQuery({
    queryKey: ['lgdfit', portfolio, fittedLgd?.hash],
    queryFn: () => api.lgdFit(portfolio, fittedLgd!.spec),
    enabled: !!fittedLgd?.hash,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
  })
  // The store's metrics ALWAYS follow the fit on screen. The old guard only
  // refreshed when rmse was missing, so metrics recorded against a previous
  // panel survived a data rebuild and the band described a fit that no longer
  // existed. Refreshing on every result is idempotent — the value check stops
  // the loop.
  useEffect(() => {
    const r = fitQuery.data
    if (!r || !fittedLgd || fittedLgd.hash !== r.hash) return
    if (fittedLgd.rmse === r.diagnostics.rmse
        && fittedLgd.devianceR2 === r.diagnostics.deviance_r2) return
    setFittedLgd(pk, {
      ...fittedLgd, name: r.name, meanLgd: r.mean_lgd, nDefaults: r.n_defaults,
      rmse: r.diagnostics.rmse,
      bias: r.diagnostics.mean_predicted - r.diagnostics.mean_actual,
      devianceR2: r.diagnostics.deviance_r2,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitQuery.data?.hash])

  // The explicit Refit of an edited draft. The result seeds the query cache
  // under its new hash, so the query above takes over without a second fetch.
  const fit = useMutation({
    mutationFn: () => api.lgdFit(portfolio, spec),
    onSuccess: (r) => {
      qc.setQueryData(['lgdfit', portfolio, r.hash], r)
      const prev = prevFit.current
      prevFit.current = r
      setOutcome(!prev ? `Fitted on ${r.n_defaults.toLocaleString()} resolved workouts.`
        : prev.hash === r.hash
          ? 'Refitted. The specification did not change, so the result is identical.'
          : `Refitted: ${prev.columns.length} terms → ${r.columns.length}. `
            + `Deviance R² ${prev.diagnostics.deviance_r2.toFixed(3)}`
            + ` → ${r.diagnostics.deviance_r2.toFixed(3)}.`)
      setFittedLgd(pk, {
        spec: r.spec, hash: r.hash, name: r.name, fittedAt: new Date().toISOString(),
        meanLgd: r.mean_lgd, nDefaults: r.n_defaults,
        rmse: r.diagnostics.rmse,
        bias: r.diagnostics.mean_predicted - r.diagnostics.mean_actual,
        devianceR2: r.diagnostics.deviance_r2,
      })
    },
  })
  // The query serves the stored model; the mutation bridges a draft refit
  // until its result lands in the store and the query takes over.
  const res = fitQuery.data ?? fit.data
  const busy = fit.isPending || fitQuery.isFetching
  // The model bar's call to action, clicked while the LGD stage is on screen.
  // A store flag, not a window event: this pane is unmounted while a driver
  // detail or the target view is open, and an event fired then had no
  // listener. The flag waits for the pane to mount and is consumed once.
  const cta = useUi((s) => s.cta)
  const setCta = useUi((s) => s.setCta)
  useEffect(() => {
    if (cta !== 'lgd') return
    setCta(null)
    if (!busy) fit.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cta])
  // Keep the progress card for a moment after the response, so the bar is
  // seen to complete rather than vanishing at 92%.
  const [justFitted, setJustFitted] = useState(false)
  useEffect(() => {
    if (busy) { setJustFitted(true); return }
    if (!justFitted) return
    const t = setTimeout(() => setJustFitted(false), 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  // Whether the fit on screen still describes the specification on screen.
  //
  // This page carries its own driver list, so a driver can be toggled here and
  // the old fit stays displayed — coefficients, diagnostics and backtest all
  // describing a model that is no longer selected. The stage auto-fits on
  // arrival, so in the normal flow Refit has nothing to do and reads as a dead
  // button; the one time it matters, nothing said so.
  const canonical = (sp: LgdSpecPayload | undefined) => sp && JSON.stringify({
    d: [...sp.drivers].sort(), c: [...sp.categoricals].sort(),
    t: Object.entries(asMap(sp.treatments)).sort(),
    e: Object.entries(asMap(sp.edges)).sort(),
    k: Object.entries(asMap(sp.knots)).sort(),
    n: sp.n_knots, m: sp.max_bins,
  })
  const stale = !!res && canonical(spec) !== canonical(res.spec)
  // The one remaining automatic fit: a virgin book, where the screen proposes
  // a default specification and nothing has ever been estimated. Everything
  // else is either served by the query (a model with a hash) or waits for the
  // Refit button (an edited draft, whose hash is cleared by the edit).
  // No automatic first fit. A virgin book used to fit the proposed default
  // specification on arrival, so a severity model existed that nobody chose —
  // and everything downstream (the band, the scenarios gate) then treated it
  // as the analyst's model. The proposal stays visible as pre-selected
  // drivers in the list; becoming a model requires the one click that makes
  // it a decision.

  const sens = useQuery({
    queryKey: ['lgdsens', portfolio, res?.hash],
    queryFn: () => api.lgdSensitivity(portfolio, spec),
    enabled: !!res && res.macro_drivers.length > 0,
  })

  const [tab, setTab] = useState<'spec' | 'diagnostics' | 'backtest'>('spec')
  const [ootFrom, setOotFrom] = useState('2022-01-01')
  // Monthly by default, matching the PD backtest. Whether a month is READABLE
  // depends on how many workouts the book resolves; the chart reports how many
  // periods were too thin to average rather than quietly omitting them.
  const [btFreq, setBtFreq] = useState<SeverityFreq>('MS')
  const backtest = useQuery({
    queryKey: ['lgdbacktest', portfolio, res?.hash, ootFrom, btFreq],
    queryFn: () => api.lgdBacktest(portfolio, spec, ootFrom, btFreq),
    enabled: !!res && tab === 'backtest',
  })

  const nSelected = spec.drivers.length + spec.categoricals.length
  const hasMacro = useMemo(
    () => spec.drivers.some((d) => cand.data?.numeric.find((c) => c.column === d)?.macro),
    [spec.drivers, cand.data])

  if (cand.isLoading || !cand.data) return <Skeleton className="h-[560px]" />

  return (
    <div className="space-y-3">
      <Card>
        <CardHead
          title="LGD model: Fit"
          subtitle={`Fractional logit on realised severity · ${num(cand.data.n_defaults)} defaulted account-months`}
          caption={
            <>
              <Eq tex="\mathbb{E}[\,\mathrm{LGD}\mid X\,] = \sigma(X\beta)" />
              , estimated by fractional-response quasi-likelihood (Papke and
              Wooldridge). Terms enter linearly. Macro drivers are joined at the
              default month, which is what lets predicted severity respond to a
              scenario.
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-4 border-t border-hairline px-4 py-2.5">
          <span className="text-tiny text-ink-secondary">
            {nSelected} driver{nSelected === 1 ? '' : 's'} in the specification
          </span>
          {!hasMacro && (
            <StatusPill severity="warning">
              No macro driver selected. Predicted LGD will not change across scenarios
            </StatusPill>
          )}
          {stale && (
            <span className="ml-auto flex items-center gap-1.5 text-tiny"
                  style={{ color: 'var(--status-warning)' }}
                  title="The drivers selected here no longer match the ones this model was estimated on. The coefficients, diagnostics and backtest below describe the previous specification.">
              <span>!</span>
              <span>the specification changed. This fit is out of date</span>
            </span>
          )}
          <button onClick={() => fit.mutate()} disabled={busy || nSelected === 0}
            className={`rounded-ctl px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${
              stale ? '' : 'ml-auto'}`}
            style={{ background: stale ? 'var(--status-warning)' : 'var(--accent)' }}
            title={res && !stale
              ? 'Re-estimate on the same specification. The result will be identical, because the drivers have not changed since it was fitted.'
              : 'Estimate the severity model on the drivers selected here.'}>
            {busy ? 'Fitting…' : res ? 'Refit' : 'Fit LGD'}
          </button>
        </div>

        {outcome && !busy && !stale && (
          <div className="flex items-center gap-2 border-t border-hairline px-4 py-1.5 text-micro text-ink-secondary">
            <span style={{ color: 'var(--status-good)' }}><Check /></span>
            <span>{outcome}</span>
            <button onClick={() => setOutcome(null)}
              className="ml-auto text-ink-muted hover:text-ink" title="Dismiss"><Close /></button>
          </div>
        )}
        {fit.isError && (
          <div className="border-t border-hairline px-4 py-2 text-xs"
               style={{ color: 'var(--status-critical)' }}>{String(fit.error)}</div>
        )}
      </Card>

        {(busy || justFitted) && (
          <FitProgress done={!busy}
            phases={LGD_PHASES(res?.n_defaults ?? cand.data?.n_defaults)} />
        )}

        {!res ? (
          <Card>
            <EmptyState title="No severity model on this book yet"
              action={<button onClick={() => fit.mutate()} disabled={busy}
                className="mt-2 rounded-ctl bg-accent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60">
                {busy ? 'Fitting…' : 'Fit the LGD model'}
              </button>}>
              A starting set of drivers is pre-selected in the list as a proposal —
              nothing is fitted until you say so. Click a driver first to see its
              relationship with realised severity, adjust the selection, then fit.
            </EmptyState>
          </Card>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <StatTile label="Defaults" value={num(res.n_defaults)} />
              <StatTile label="Mean realised LGD" value={pct(res.mean_lgd * 100, 1)} />
              <StatTile label="Resolved with no loss" value={pct(res.zero_loss_share * 100, 1)}
                explain="Defaults where recovery covered the balance in full. Reported as a descriptive statistic; the fitted model estimates the conditional mean and does not model this point separately." />
              <StatTile label="Mean workout" value={`${ratio(res.mean_workout_months, 1)} m`} />
            </div>

            {res.note && (
              <div className="rounded-card border border-hairline px-4 py-2.5 text-xs text-ink-secondary">
                {res.note}
              </div>
            )}

            <ViewTabs value={tab} onChange={setTab} tabs={[
              { key: 'spec', label: 'Specification' },
              { key: 'diagnostics', label: 'Fit diagnostics' },
              { key: 'backtest', label: 'Backtesting' },
            ]} />

            {tab === 'spec' && (
              <>
                <Coefficients rows={res.coefficients} spec={spec}
                              references={res.references}
                              onOpenVariable={onOpenVariable} />
                {sens.data && sens.data.sensitivity.length > 0 && <MacroResponse data={sens.data} />}
              </>
            )}
            {tab === 'diagnostics' && <FitDiagnostics d={res.diagnostics} />}
            {tab === 'backtest' && (
              <Backtest data={backtest.data} loading={backtest.isFetching}
                        ootFrom={ootFrom} onOot={setOotFrom}
                        freq={btFreq} onFreq={setBtFreq} />
            )}
          </div>
        )}
    </div>
  )
}

function Coefficients({ rows, spec, references, onOpenVariable }: {
  rows: LgdFitResult['coefficients']; spec: LgdSpecPayload
  references?: Record<string, string>
  onOpenVariable?: (column: string) => void
}) {
  const stars = (p: number | null) =>
    p == null ? '' : p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : ''
  return (
    <Card>
      <CardHead
        title="Fitted specification"
        subtitle={`${rows.length} terms · robust standard errors`}
        caption="Each coefficient is the change in the logit of predicted severity for a one standard deviation change in that term. Standard errors use the sandwich estimator, because the quasi-likelihood variance assumption does not hold for a proportion."
        right={<span className="text-micro text-ink-muted">*** p&lt;0.001 · ** p&lt;0.01 · * p&lt;0.05</span>}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-y border-hairline text-tiny text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Term</th>
              <th className="px-3 py-2 text-left font-medium">Enters as</th>
              <th className="px-3 py-2 text-right font-medium">Coefficient</th>
              <th className="px-3 py-2 text-right font-medium">Std. error</th>
              <th className="px-3 py-2 text-right font-medium">z</th>
              <th className="px-3 py-2 text-right font-medium">p-value</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const base = r.column.replace(/_(flag|basis\d+)$/, '').split('=')[0]
              // A categorical always enters as one indicator per level less a
              // reference — the `bins` path. It was labelled "weight", left over
              // from a weight-of-evidence treatment that severity cannot have:
              // weight of evidence is a log-odds ratio needing a binary target,
              // and a proportion has no non-events to take a share of.
              const t = r.column === 'intercept' ? ''
                : spec.categoricals.includes(base) ? 'indicator'
                : spec.treatments?.[base] ?? 'continuous'
              // An indicator coefficient is the shift RELATIVE to the bin that
              // has no column. The table states which bin that is, or the
              // coefficients read as absolute effects.
              const ref = references?.[base]
              // The same click-through the PD specification card has. A term
              // that is a driver on this book opens its severity curve; a
              // macro term or a derived column has no detail page.
              const linkable = onOpenVariable
                && (spec.drivers.includes(base) || spec.categoricals.includes(base))
                && !base.includes('@')
              return (
                <tr key={r.column} className="border-b border-hairline">
                  <td className="px-3 py-1.5 font-mono text-tiny" title={r.column}>
                    {linkable ? (
                      <button onClick={() => onOpenVariable!(base)}
                        title={`Open ${base}: severity curve, binning and stability`}
                        className="text-left hover:text-accent hover:underline">
                        {macroTermLabel(r.column)}
                      </button>
                    ) : macroTermLabel(r.column)}
                  </td>
                  <td className="px-3 py-1.5 text-tiny text-ink-muted">
                    {t}
                    {ref && (t === 'indicator' || t === 'bins') && (
                      <span className="text-ink-muted" title={`Reference level: ${ref}. Each indicator's coefficient is the shift in severity relative to this level.`}
                      > · vs {ref}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum">{ratio(r.coefficient, 3)}</td>
                  <td className="px-3 py-1.5 text-right tnum text-ink-muted">
                    {r.std_error == null ? '—' : ratio(r.std_error, 3)}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum">
                    {r.z == null ? '—' : ratio(r.z, 2)}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum text-ink-muted">
                    {r.p_value == null ? '—'
                      : r.p_value < 1e-4 ? '<0.0001' : r.p_value.toFixed(4)}
                    <span className="ml-0.5 text-ink">{stars(r.p_value)}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    {/* The same flag the PD specification card carries. For an
                        indicator, "not significant" means that level is not
                        distinguishable from the reference — grounds to merge
                        bins, not necessarily to drop the variable. */}
                    {r.column !== 'intercept' && r.p_value != null && r.p_value > 0.05 && (
                      <StatusPill severity="warning">not significant</StatusPill>
                    )}
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

function MacroResponse({ data }: {
  data: { base: number; sensitivity: { driver: string; sd: number; up: number; down: number }[] }
}) {
  return (
    <Card>
      <CardHead
        title="Macro response"
        subtitle={`Mean predicted LGD is ${pct(data.base * 100, 1)} at the current macro path`}
        caption="Each macro driver moved one standard deviation in each direction, with all other drivers held. The range column states the response in percentage points of severity."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-y border-hairline text-tiny text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Macro driver</th>
              <th className="px-3 py-2 text-right font-medium">1 sd</th>
              <th className="px-3 py-2 text-right font-medium">−1 sd</th>
              <th className="px-3 py-2 text-right font-medium">+1 sd</th>
              <th className="px-3 py-2 text-right font-medium">Range</th>
            </tr>
          </thead>
          <tbody>
            {data.sensitivity.map((r) => (
              <tr key={r.driver} className="border-b border-hairline">
                <td className="px-3 py-1.5 font-mono text-tiny" title={r.driver}>
                  {macroTermLabel(r.driver)}
                </td>
                <td className="px-3 py-1.5 text-right tnum text-ink-muted">{ratio(r.sd, 2)}</td>
                <td className="px-3 py-1.5 text-right tnum">{pct(r.down * 100, 1)}</td>
                <td className="px-3 py-1.5 text-right tnum">{pct(r.up * 100, 1)}</td>
                <td className="px-3 py-1.5 text-right tnum font-medium">
                  {pct(Math.abs(r.up - r.down) * 100, 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function Calibration({ rows }: {
  rows: { cohort: number; n: number; predicted: number; actual: number; zero_loss_share: number }[]
}) {
  if (!rows.length) return null
  return (
    <Card>
      <CardHead
        title="Calibration"
        subtitle="Defaults grouped into cohorts of predicted severity"
        caption="Predicted against actual mean severity within each cohort."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-y border-hairline text-tiny text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Cohort</th>
              <th className="px-3 py-2 text-right font-medium">Defaults</th>
              <th className="px-3 py-2 text-right font-medium">Predicted</th>
              <th className="px-3 py-2 text-right font-medium">Actual</th>
              <th className="px-3 py-2 text-right font-medium">Difference</th>
              <th className="px-3 py-2 text-right font-medium">No loss</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cohort} className="border-b border-hairline">
                <td className="px-3 py-1.5">{r.cohort}</td>
                <td className="px-3 py-1.5 text-right tnum text-ink-muted">{num(r.n)}</td>
                <td className="px-3 py-1.5 text-right tnum">{pct(r.predicted * 100, 1)}</td>
                <td className="px-3 py-1.5 text-right tnum">{pct(r.actual * 100, 1)}</td>
                <td className="px-3 py-1.5 text-right tnum">
                  {pct((r.actual - r.predicted) * 100, 1)}
                </td>
                <td className="px-3 py-1.5 text-right tnum text-ink-muted">
                  {pct(r.zero_loss_share * 100, 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}


/** Diagnostics for a FRACTIONAL response model.
 *
 *  Not AUC, KS or a lift curve. Those measure separation between two classes and
 *  realised severity has no classes. What matters for a conditional mean on
 *  [0, 1] is whether the ordering is right, whether the LEVEL is right — that is
 *  the part that reaches the loss number — and whether the link is the right
 *  one at all. */
function FitDiagnostics({ d }: { d: LgdDiagnostics }) {
  const link = d.link_test
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Deviance R²" value={ratio(d.deviance_r2, 3)}
          explain="One minus the fitted quasi-log-likelihood over the intercept-only one. The fractional analogue of McFadden's pseudo R-squared." />
        <StatTile label="Rank correlation" value={ratio(d.spearman, 3)}
          explain="Spearman between predicted and realised severity. This is the discrimination measure for a fractional target; an AUC would require two classes, and there are none." />
        <StatTile label="Mean absolute error" value={pct(d.mae * 100, 1)}
          explain="Average absolute gap between predicted and realised severity, in percentage points." />
        <StatTile label="Root mean squared error" value={pct(d.rmse * 100, 1)} />
      </div>

      <Card>
        <CardHead
          title="Link test"
          subtitle="RESET-style specification check"
          caption="The fitted linear predictor and its square are re-fitted as the only two terms. A significant coefficient on the square indicates the link does not describe the conditional mean, usually because a driver needs a non-linear form. Specified with the estimator by Papke and Wooldridge."
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-xs">
          <StatusPill severity={link.ok === false ? 'warning' : 'good'}>
            {link.ok === false ? 'Specification rejected' : 'No evidence against the link'}
          </StatusPill>
          <span className="text-ink-secondary">
            Squared term {ratio(link.coefficient, 4)} · z {ratio(link.z, 2)} ·
            {' '}p {link.p_value == null ? '—' : link.p_value.toFixed(4)}
          </span>
          {link.ok === false && (
            <span className="text-ink-muted">
              Try a spline or a binning on the driver with the strongest curvature.
            </span>
          )}
        </div>
      </Card>

      <Card>
        <CardHead
          title="Calibration"
          subtitle={`Predicted ${pct(d.mean_predicted * 100, 1)} against actual ${pct(d.mean_actual * 100, 1)} overall`}
          caption="Defaults grouped into deciles of predicted severity, with a 95% interval on each actual mean. A model can order defaults correctly and still be wrong on the level, and the level is what enters the loss calculation."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-y border-hairline text-tiny text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Decile</th>
                <th className="px-3 py-2 text-right font-medium">Defaults</th>
                <th className="px-3 py-2 text-right font-medium">Predicted</th>
                <th className="px-3 py-2 text-right font-medium">Actual</th>
                <th className="px-3 py-2 text-right font-medium">95% interval</th>
                <th className="px-3 py-2 text-right font-medium">No loss</th>
                <th className="px-3 py-2 text-right font-medium">Full loss</th>
              </tr>
            </thead>
            <tbody>
              {d.calibration.map((c) => {
                const inside = c.predicted >= c.actual_lo95 && c.predicted <= c.actual_hi95
                return (
                  <tr key={c.cohort} className="border-b border-hairline">
                    <td className="px-3 py-1.5">{c.cohort}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-muted">{num(c.n)}</td>
                    <td className="px-3 py-1.5 text-right tnum">{pct(c.predicted * 100, 1)}</td>
                    <td className="px-3 py-1.5 text-right tnum">{pct(c.actual * 100, 1)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-muted"
                        style={{ color: inside ? undefined : 'var(--status-warning)' }}
                        title={inside ? 'The prediction falls inside the interval on the actual mean.'
                          : 'The prediction falls outside the interval on the actual mean for this decile.'}>
                      {pct(c.actual_lo95 * 100, 0)}–{pct(c.actual_hi95 * 100, 0)}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-muted">
                      {pct(c.zero_loss_share * 100, 0)}
                    </td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-muted">
                      {pct(c.total_loss_share * 100, 0)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHead
          title="Pearson residuals against fitted"
          subtitle="Grouped, with a 95% interval on each group mean"
          caption="Residual divided by the square root of μ(1−μ). The estimator assumes nothing about the variance, so a pattern here indicates the mean function is misspecified. Expect a flat band around zero."
        />
        <div className="overflow-x-auto px-4 py-3">
          <div className="flex items-end gap-1" style={{ height: 110 }}>
            {d.residuals.map((r, i) => {
              const hi = Math.max(...d.residuals.map((z) => Math.abs(z.residual)), 0.2)
              const h = (Math.abs(r.residual) / hi) * 48
              return (
                <div key={i} className="flex flex-1 flex-col items-center justify-center"
                     style={{ height: '100%' }}
                     title={`predicted ${pct(r.predicted * 100, 1)} · mean residual ${ratio(r.residual, 3)} · ${num(r.n)} defaults`}>
                  <div className="flex w-full flex-1 items-end justify-center">
                    {r.residual > 0 && (
                      <div className="w-full rounded-t-sm"
                           style={{ height: `${h}%`, background: 'var(--status-warning)' }} />
                    )}
                  </div>
                  <div className="h-px w-full bg-hairline" />
                  <div className="flex w-full flex-1 items-start justify-center">
                    {r.residual <= 0 && (
                      <div className="w-full rounded-b-sm"
                           style={{ height: `${h}%`, background: 'var(--series-1)' }} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="pt-1 text-center text-micro text-ink-muted">
            predicted severity, low to high
          </p>
        </div>
      </Card>
    </div>
  )
}

/** Out-of-time backtest. Severity is thin, so the split has to be reported. */
function Backtest({ data, loading, ootFrom, onOot, freq, onFreq }: {
  data: LgdBacktest | undefined; loading: boolean
  ootFrom: string; onOot: (v: string) => void
  freq: SeverityFreq; onFreq: (f: SeverityFreq) => void
}) {
  return (
    <div className="space-y-3">
      <Card>
        <CardHead
          title="Out of time"
          subtitle="Refit on defaults before the boundary, scored on the ones after it"
          caption="Severity is estimated on defaulted rows only, so an out-of-time split leaves a small test set and every statistic from it carries a wide interval. Counts are reported beside the numbers."
          right={
            <label className="flex items-center gap-1.5 text-tiny text-ink-muted">
              from
              <input type="month" value={ootFrom.slice(0, 7)}
                onChange={(e) => onOot(`${e.target.value}-01`)}
                className="rounded-ctl border border-hairline bg-sunken px-2 py-1 text-xs text-ink" />
            </label>
          }
        />
        {loading && (
          <p className="px-4 py-6 text-center text-xs text-ink-muted">Refitting…</p>
        )}
        {data && !data.usable && (
          <div className="px-4 py-3">
            <StatusPill severity="warning">Split too thin to test</StatusPill>
            <p className="max-w-[88ch] mt-1.5 text-xs leading-relaxed text-ink-secondary">{data.note}</p>
          </div>
        )}
        {data?.usable && data.train && data.test && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-hairline text-tiny text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium" />
                  <th className="px-3 py-2 text-right font-medium">Defaults</th>
                  <th className="px-3 py-2 text-right font-medium">Actual mean</th>
                  <th className="px-3 py-2 text-right font-medium">Predicted mean</th>
                  <th className="px-3 py-2 text-right font-medium">MAE</th>
                  <th className="px-3 py-2 text-right font-medium">Rank corr.</th>
                  <th className="px-3 py-2 text-right font-medium">Deviance R²</th>
                </tr>
              </thead>
              <tbody>
                {([['In time', data.train], ['Out of time', data.test]] as const).map(
                  ([label, r]) => (
                    <tr key={label} className="border-b border-hairline">
                      <td className="px-3 py-1.5 text-ink">{label}</td>
                      <td className="px-3 py-1.5 text-right tnum text-ink-muted">{num(r!.n)}</td>
                      <td className="px-3 py-1.5 text-right tnum">{pct(r!.mean_actual * 100, 1)}</td>
                      <td className="px-3 py-1.5 text-right tnum">{pct(r!.mean_predicted * 100, 1)}</td>
                      <td className="px-3 py-1.5 text-right tnum">{pct(r!.mae * 100, 1)}</td>
                      <td className="px-3 py-1.5 text-right tnum">{ratio(r!.spearman, 3)}</td>
                      <td className="px-3 py-1.5 text-right tnum">{ratio(r!.deviance_r2, 3)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="max-w-[88ch] px-4 py-2 text-micro leading-relaxed text-ink-muted">
              The gap between the two rows is what the model loses on a period it
              was not fitted on. On {num(data.test.n)} defaults the interval around
              every figure in the second row is wide.
            </p>
          </div>
        )}
      </Card>

      {data?.usable && data.by_period && data.by_period.length > 0 && (
        <Card>
          <CardHead
            title="Actual against predicted severity, through time"
            subtitle={`${data.periods_kept ?? 0} ${data.period_freq ?? 'period'}s plotted`}
            caption="The band is the 95% interval of the realised cohort mean. A predicted mean outside it is a calibration miss for that cohort, not sampling noise."
          />
          <SeverityOverTime
            d={{
              portfolio: '', freq: data.freq ?? 'MS',
              period_freq: data.period_freq ?? 'period',
              n_defaults: (data.train?.n ?? 0) + (data.test?.n ?? 0),
              mean: data.test?.mean_actual ?? 0,
              periods_total: data.periods_total ?? data.by_period.length,
              periods_kept: data.periods_kept ?? data.by_period.length,
              periods_dropped: data.periods_dropped ?? 0,
              min_resolutions: data.min_resolutions ?? 8,
              points: data.by_period,
            }}
            freq={freq} onFreq={onFreq} busy={loading} oot={data.oot_from} />
        </Card>
      )}

      {data?.by_year && data.by_year.length > 0 && (
        <Card>
          <CardHead title="Mean severity by year"
            subtitle="Actual against predicted, in and out of the fitting window"
            caption="A single headline figure averages drift away. This shows whether the model tracks the level through the cycle or only on average." />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-hairline text-tiny text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Year</th>
                  <th className="px-3 py-2 text-right font-medium">Defaults</th>
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-right font-medium">Predicted</th>
                  <th className="px-3 py-2 text-right font-medium">Difference</th>
                  <th className="px-3 py-2 text-left font-medium">Window</th>
                </tr>
              </thead>
              <tbody>
                {data.by_year.map((r) => (
                  <tr key={r.year} className="border-b border-hairline">
                    <td className="px-3 py-1.5 tnum">{r.year}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-muted">{num(r.n)}</td>
                    <td className="px-3 py-1.5 text-right tnum">{pct(r.actual * 100, 1)}</td>
                    <td className="px-3 py-1.5 text-right tnum">{pct(r.predicted * 100, 1)}</td>
                    <td className="px-3 py-1.5 text-right tnum">
                      {pct((r.predicted - r.actual) * 100, 1)}
                    </td>
                    <td className="px-3 py-1.5 text-tiny text-ink-muted">
                      {r.in_sample ? 'in time' : 'out of time'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
