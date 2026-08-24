import { useEffect, useMemo, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type SeverityFreq, type LgdBacktest, type LgdCandidate, type LgdDiagnostics,
         type LgdFitResult, type LgdSpecPayload, type PortfolioKey } from '../lib/api'
import { Card, CardHead, EmptyState, Skeleton, StatTile, StatusPill } from '../components/ui'
import SeverityOverTime from '../components/SeverityOverTime'
import { num, pct, ratio } from '../lib/format'
import { useUi } from '../lib/store'
import { macroTermLabel } from './LgdExploreSurface'

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
export default function LgdSurface() {
  const { portfolio = 'consumer' } = useParams()
  const pk = portfolio as PortfolioKey
  const nav = useNavigate()
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const setFittedLgd = useUi((s) => s.setFittedLgd)
  const loaded = useUi((s) => s.loaded[pk])
  const forkFromLoaded = useUi((s) => s.forkFromLoaded)

  const cand = useQuery({ queryKey: ['lgdcand', portfolio], queryFn: () => api.lgdCandidates(portfolio) })
  const [spec, setSpec] = useState<LgdSpecPayload>({ drivers: [], categoricals: [] })
  const [pendingEdit, setPendingEdit] = useState<null | (() => void)>(null)

  useEffect(() => {
    if (fittedLgd) { setSpec(fittedLgd.spec); return }
    if (cand.data) setSpec({ drivers: [...cand.data.default_spec.drivers],
                             categoricals: [...cand.data.default_spec.categoricals] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cand.data, portfolio, fittedLgd?.hash,
      JSON.stringify(fittedLgd?.spec.treatments ?? {})])

  // A saved model has been opened, or its specification was set on the Explore
  // stage: estimate it so the coefficients, macro response and calibration are
  // populated on arrival.
  useEffect(() => {
    const n = spec.drivers.length + spec.categoricals.length
    if (n && !fit.data && !fit.isPending && (loaded || fittedLgd?.hash === '')) fit.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.hash, fittedLgd?.hash, spec.drivers.length, spec.categoricals.length])

  /** A saved model is immutable, so an edit while one is open creates a new
   *  Model ID with the open one recorded as its parent. */
  const guard = (change: () => void) => {
    if (loaded) { setPendingEdit(() => change); return }
    change()
  }

  const toggle = (kind: 'drivers' | 'categoricals', col: string) =>
    guard(() => setSpec((s) => ({
      ...s,
      [kind]: s[kind].includes(col) ? s[kind].filter((c) => c !== col) : [...s[kind], col],
    })))

  // What the last fit did. A refit of an unchanged specification returns an
  // identical model — correctly — so nothing on screen moves and the button
  // reads as broken.
  const [outcome, setOutcome] = useState<string | null>(null)
  // The previous result, held in a ref rather than read from `fit.data`.
  // `onSuccess` closes over the render that created it, so `fit.data` there is
  // whatever it was when the mutation was defined — undefined — and every
  // refit reported itself as a first fit.
  const prevFit = useRef<LgdFitResult | null>(null)
  const fit = useMutation({
    mutationFn: () => api.lgdFit(portfolio, spec),
    onSuccess: (r) => {
      const prev = prevFit.current
      prevFit.current = r
      setOutcome(!prev ? `Fitted on ${r.n_defaults.toLocaleString()} resolved workouts.`
        : prev.hash === r.hash
          ? 'Refitted. The specification did not change, so the result is identical.'
          : `Refitted: ${prev.columns.length} terms → ${r.columns.length}. `
            + `Deviance R² ${prev.diagnostics.deviance_r2.toFixed(3)}`
            + ` → ${r.diagnostics.deviance_r2.toFixed(3)}.`)
      setFittedLgd(pk, {
        spec: r.spec, hash: r.hash, fittedAt: new Date().toISOString(),
        meanLgd: r.mean_lgd, nDefaults: r.n_defaults,
      })
    },
  })
  const res = fit.data

  // Whether the fit on screen still describes the specification on screen.
  //
  // This page carries its own driver list, so a driver can be toggled here and
  // the old fit stays displayed — coefficients, diagnostics and backtest all
  // describing a model that is no longer selected. The stage auto-fits on
  // arrival, so in the normal flow Refit has nothing to do and reads as a dead
  // button; the one time it matters, nothing said so.
  const canonical = (sp: LgdSpecPayload | undefined) => sp && JSON.stringify({
    d: [...sp.drivers].sort(), c: [...sp.categoricals].sort(),
    t: Object.entries(sp.treatments ?? {}).sort(),
    e: Object.entries(sp.edges ?? {}).sort(),
    k: Object.entries(sp.knots ?? {}).sort(),
    n: sp.n_knots, m: sp.max_bins,
  })
  const stale = !!res && canonical(spec) !== canonical(res.spec)
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

  if (cand.isLoading || !cand.data) return <div className="p-4"><Skeleton className="h-[560px]" /></div>

  return (
    <div className="space-y-3 p-4">
      {pendingEdit && (
        <ForkDialog
          name={loaded?.name ?? ''}
          onCancel={() => setPendingEdit(null)}
          onConfirm={() => { forkFromLoaded(pk); pendingEdit(); setPendingEdit(null) }}
        />
      )}

      <Card>
        <CardHead
          title="LGD model — Fit"
          subtitle={`Fractional logit on realised severity · ${num(cand.data.n_defaults)} defaulted account-months`}
          caption="E[LGD] = sigmoid(X·β), estimated by fractional response quasi-likelihood (Papke and Wooldridge). Terms enter linearly. Macro drivers are joined at the default month, which is what allows predicted severity to respond to a scenario."
        />
        <div className="flex flex-wrap items-center gap-4 border-t border-hairline px-4 py-2.5">
          <span className="text-tiny text-ink-secondary">
            {nSelected} driver{nSelected === 1 ? '' : 's'} in the specification
          </span>
          <button onClick={() => nav(`/${portfolio}/lgd/explore`)}
            className="text-tiny text-ink-muted underline hover:text-ink">
            Review them in Explore
          </button>
          {!hasMacro && (
            <StatusPill severity="warning">
              No macro driver selected — predicted LGD will not change across scenarios
            </StatusPill>
          )}
          {stale && (
            <span className="ml-auto flex items-center gap-1.5 text-tiny"
                  style={{ color: 'var(--status-warning)' }}
                  title="The drivers selected here no longer match the ones this model was estimated on. Everything below — coefficients, diagnostics, backtest — describes the previous specification.">
              <span>!</span>
              <span>the specification changed — this fit is out of date</span>
            </span>
          )}
          <button onClick={() => fit.mutate()} disabled={fit.isPending || nSelected === 0}
            className={`rounded-ctl px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${
              stale ? '' : 'ml-auto'}`}
            style={{ background: stale ? 'var(--status-warning)' : 'var(--accent)' }}
            title={res && !stale
              ? 'Re-estimate on the same specification. The result will be identical — the drivers have not changed since it was fitted.'
              : 'Estimate the severity model on the drivers selected here.'}>
            {fit.isPending ? 'Fitting…' : res ? 'Refit' : 'Fit LGD'}
          </button>
        </div>

        {outcome && !fit.isPending && !stale && (
          <div className="flex items-center gap-2 border-t border-hairline px-4 py-1.5 text-micro text-ink-secondary">
            <span style={{ color: 'var(--status-good)' }}>✓</span>
            <span>{outcome}</span>
            <button onClick={() => setOutcome(null)}
              className="ml-auto text-ink-muted hover:text-ink" title="Dismiss">×</button>
          </div>
        )}
        {fit.isError && (
          <div className="border-t border-hairline px-4 py-2 text-xs"
               style={{ color: 'var(--status-critical)' }}>{String(fit.error)}</div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
        <DriverPicker data={cand.data} spec={spec} onToggle={toggle} />

        {!res ? (
          <EmptyState title="Not fitted">
            Select the drivers and fit. Candidates are ranked by their relationship
            with realised severity on the Explore stage.
          </EmptyState>
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

            <div className="flex items-center gap-1">
              {([['spec', 'Specification'], ['diagnostics', 'Fit diagnostics'],
                 ['backtest', 'Backtesting']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`rounded-ctl px-3 py-1 text-xs font-medium transition-colors ${
                    tab === k ? 'bg-accent-soft text-ink'
                              : 'text-ink-muted hover:text-ink-secondary'}`}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'spec' && (
              <>
                <Coefficients rows={res.coefficients} spec={spec} />
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
    </div>
  )
}

function ForkDialog({ name, onCancel, onConfirm }:
  { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
         onClick={onCancel}>
      <div className="max-w-md rounded-card border border-hairline bg-raised p-5"
           onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ink">This creates a new Model ID</h3>
        <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">{name}</span> is saved. Saved models
          are not edited in place. This change produces a new specification with a new
          hash and a new name, recording {name} as its parent. {name} is unchanged.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel}
            className="rounded-ctl border border-hairline px-3 py-1.5 text-xs text-ink-secondary">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
            Create a new model
          </button>
        </div>
      </div>
    </div>
  )
}

function DriverPicker({ data, spec, onToggle }: {
  data: { numeric: LgdCandidate[]; categorical: LgdCandidate[] }
  spec: LgdSpecPayload
  onToggle: (kind: 'drivers' | 'categoricals', col: string) => void
}) {
  const macro = data.numeric.filter((c) => c.macro)
  const rest = data.numeric.filter((c) => !c.macro)
  const Row = ({ c, kind }: { c: LgdCandidate; kind: 'drivers' | 'categoricals' }) => {
    const on = spec[kind].includes(c.column)
    return (
      <button onClick={() => onToggle(kind, c.column)}
        className={`flex w-full items-center gap-2 px-3 py-1 text-left text-tiny ${
          on ? 'bg-accent/10 text-ink' : 'text-ink-secondary hover:bg-sunken'}`}>
        <span className={`h-3 w-3 shrink-0 rounded-sm border ${
          on ? 'border-accent bg-accent' : 'border-hairline'}`} />
        <span className="truncate font-mono">{c.column}</span>
        {c.levels != null && <span className="text-ink-muted">{c.levels}L</span>}
        {c.caution && (
          <span className="ml-auto shrink-0 text-micro text-ink-muted"
                title="The name suggests an operational identifier rather than a risk driver.">
            id?
          </span>
        )}
        {c.filled < 0.95 && (
          <span className="ml-auto shrink-0 text-micro text-ink-muted"
                title="Share of defaulted rows where this column is populated.">
            {pct(c.filled * 100, 0)}
          </span>
        )}
      </button>
    )
  }
  return (
    <Card className="self-start">
      <CardHead title="Specification"
        caption="Columns available on defaulted rows. Macro drivers are listed first because they determine how predicted severity responds to a scenario." />
      <div className="thin-scroll max-h-[620px] overflow-auto py-1">
        <p className="px-3 pb-1 pt-2 text-micro uppercase tracking-wide text-ink-muted">
          Macro at default
        </p>
        {macro.map((c) => <Row key={c.column} c={c} kind="drivers" />)}
        <p className="px-3 pb-1 pt-3 text-micro uppercase tracking-wide text-ink-muted">
          Loan and collateral
        </p>
        {rest.map((c) => <Row key={c.column} c={c} kind="drivers" />)}
        <p className="px-3 pb-1 pt-3 text-micro uppercase tracking-wide text-ink-muted">
          Categorical
        </p>
        {data.categorical.map((c) => <Row key={c.column} c={c} kind="categoricals" />)}
      </div>
    </Card>
  )
}

function Coefficients({ rows, spec }: {
  rows: LgdFitResult['coefficients']; spec: LgdSpecPayload
}) {
  const stars = (p: number | null) =>
    p == null ? '' : p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : ''
  return (
    <Card>
      <CardHead
        title="Fitted specification"
        subtitle={`${rows.length} terms · robust standard errors`}
        caption="Each coefficient is the change in the logit of predicted severity for a one standard deviation change in that term. Standard errors are the sandwich estimator: the quasi-likelihood assumes Var(y|x) = μ(1−μ), which is false for a proportion, so the naive errors would be too small and every term would look more significant than it is."
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
              return (
                <tr key={r.column} className="border-b border-hairline/60">
                  <td className="px-3 py-1.5 font-mono text-tiny" title={r.column}>
                    {macroTermLabel(r.column)}
                  </td>
                  <td className="px-3 py-1.5 text-tiny text-ink-muted">{t}</td>
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
              <tr key={r.driver} className="border-b border-hairline/60">
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
        caption="Predicted against actual mean severity within each cohort. This tests the level of the prediction, which is the quantity that enters the loss calculation, rather than its ordering."
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
              <tr key={r.cohort} className="border-b border-hairline/60">
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
          explain="Average absolute gap between predicted and realised severity, in percentage points — the unit the answer is quoted in." />
        <StatTile label="Root mean squared error" value={pct(d.rmse * 100, 1)} />
      </div>

      <Card>
        <CardHead
          title="Link test"
          subtitle="RESET-style specification check"
          caption="The fitted linear predictor and its square are re-fitted as the only two terms. A significant coefficient on the square says the logit link with these terms does not describe the conditional mean — usually because a driver needs a non-linear form. Papke and Wooldridge specify this test with the estimator."
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
          caption="Defaults grouped into deciles of predicted severity, with a 95% interval on each actual mean. A severity model can order defaults correctly and still be wrong on the level, and the level is what enters the loss calculation."
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
                  <tr key={c.cohort} className="border-b border-hairline/60">
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
          caption="Residual divided by the square root of μ(1−μ). The estimator assumes nothing about the variance, so a pattern here indicates the MEAN function is misspecified rather than the variance. A flat band around zero is what a correct specification looks like."
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
          caption="Severity is estimated on defaulted rows only, so an out-of-time split leaves a test set of tens rather than thousands and every statistic from it carries a wide interval. The counts are reported beside the numbers."
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
            <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">{data.note}</p>
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
                    <tr key={label} className="border-b border-hairline/60">
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
            <p className="px-4 py-2 text-micro leading-relaxed text-ink-muted">
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
            caption="A severity model is judged on the LEVEL it produces, and a level can drift while every rank stays correct. The band is the 95% interval of the realised cohort mean; a predicted mean outside it is a calibration miss for that cohort rather than sampling noise."
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
                  <tr key={r.year} className="border-b border-hairline/60">
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
