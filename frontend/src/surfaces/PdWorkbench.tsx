import { useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type PortfolioKey, type ScreenRow } from '../lib/api'
import { Skeleton, ViewTabs } from '../components/ui'
import SpecificationList, { macroRows, pdRows } from '../components/SpecificationList'
import CorrelationPanel from '../components/CorrelationPanel'
import VariableDetail from './VariableDetail'
import ModelPane from './ModelPane'
import { NONE, useUi } from '../lib/store'
import ModelBand from '../components/ModelBand'
import { ArrowLeft } from '../components/icons'
import { columns, toggleTerm } from '../lib/spec'

/**
 * The PD model workbench: one screen for the whole loop.
 *
 * Model development is not two stages. It is one loop: look at a variable,
 * add it, fit, read the coefficients, click the weak one, rebin it, refit.
 * Splitting that across an Explore stage and a Fit stage produced a steady
 * stream of the same complaint in different forms: the fit vanished on the
 * way to Explore, variables had to be added on the other screen, the tabs had
 * nowhere natural to live, and a change made on one stage had to be noticed
 * on the other.
 *
 * So the candidate list is the spine and never moves. The right pane is
 * whichever of three things the analyst is looking at:
 *
 *   model       the fit, its verdict, coefficients, diagnostics and backtest
 *   variable    one candidate in full, opened by clicking it
 *   collinear   the correlation structure across the selected variables
 *
 * The view is in the URL, so it survives a reload and can be linked.
 */
type View = 'model' | 'variable' | 'collinearity'

export default function PdWorkbench() {
  const { portfolio = 'consumer' } = useParams()
  const pk = portfolio as PortfolioKey
  const [params, setParams] = useSearchParams()

  const spec = useUi((s) => s.pdSpec[pk])
  const editPd = useUi((s) => s.editPd)
  const shortlisted = useUi((s) => s.macroShortlist[pk]?.pd ?? NONE) as string[]
  const picked = columns(spec)

  // The open variable is in the URL. Absent means the model pane.
  const column = params.get('variable')
  const view: View = column ? 'variable'
    : params.get('view') === 'multicollinearity' ? 'collinearity' : 'model'
  const setView = (v: View, col?: string | null) => {
    const next = new URLSearchParams(params)
    next.delete('variable'); next.delete('view')
    if (v === 'variable' && col) next.set('variable', col)
    if (v === 'collinearity') next.set('view', 'multicollinearity')
    setParams(next, { replace: true })
  }
  // Switching books drops the open variable: it belongs to the other panel.
  useEffect(() => { if (column) setView('model') }, [portfolio])   // eslint-disable-line react-hooks/exhaustive-deps

  const screen = useQuery({ queryKey: ['screen', portfolio], queryFn: () => api.screen(portfolio) })
  const catalog = useQuery({ queryKey: ['mevcat'], queryFn: api.mevCatalog })
  const macroLib = useQuery({ queryKey: ['macrolib', portfolio],
                              queryFn: () => api.macroLibrary(portfolio) })

  // Every macro term this book can carry: the catalogue's level terms, plus
  // anything promoted out of the transformation search. A transformed term is
  // a different quantity from the same variable in levels, so both appear.
  const macroTerms = useMemo(() => [
    ...(catalog.data?.by_portfolio?.[portfolio] ?? []).map((k) => ({
      col: `${k}@level@0`, label: k })),
    ...shortlisted.map((col) => {
      const c = macroLib.data?.rows.find((r) => r.column === col)
      return { col, label: c
        ? `${c.key} ${c.transform_label}${c.lag_months ? ` ·${c.lag_months}m` : ''}` : col }
    }),
  ], [catalog.data, portfolio, shortlisted, macroLib.data])

  const listInternal = useMemo(() => {
    const rows = screen.data?.rows ?? []
    const maxIv = Math.max(...rows.map((r) => Math.min(r.iv || 0, 1.2)), 0.1)
    return pdRows(rows, maxIv)
  }, [screen.data])
  const listMacro = useMemo(() => macroRows(macroTerms, macroLib.data?.rows, 'pd'),
                            [macroTerms, macroLib.data])

  // The bar's call to action targets this stage while a variable detail or
  // the collinearity view is open. The pane that performs the action is not
  // mounted in those views, so first return to the model view; the pane then
  // reads the flag and runs the fit.
  const cta = useUi((s) => s.cta)
  useEffect(() => {
    if (cta === 'pd' && view !== 'model') setView('model')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cta])

  // An open variable that is not a real column (a stale link) falls back to
  // the model rather than rendering an empty detail pane.
  const known = !column || (screen.data?.rows ?? []).some((r: ScreenRow) => r.column === column)

  if (screen.isLoading) {
    return <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <Skeleton className="h-[600px]" /><Skeleton className="h-[600px]" />
    </div>
  }

  return (
    <div className="p-4">
      <ModelBand portfolio={portfolio} />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <SpecificationList
        internal={listInternal} macro={listMacro}
        picked={[...picked, ...spec.mevs]}
        onToggle={(c) => editPd(pk, (x) => toggleTerm(x, c), c)}
        onAddMacroTop={(cols) =>
          editPd(pk, (x) => cols.reduce((acc, c) => toggleTerm(acc, c), x),
                 'the strongest macro terms')}
        selected={column} onSelect={(c) => setView(c === column ? 'model' : 'variable', c)}
        title="Candidates"
        subtitle={`${picked.length} variable${picked.length === 1 ? '' : 's'} · ${spec.mevs.length} macro term${spec.mevs.length === 1 ? '' : 's'} in the specification`}
        statLabel="Information value for an internal variable; correlation with the target for a macro term."
        macroNote="Only Federal Reserve supervisory variables are offered, because they are the only ones with a published forward path. Build transformed and lagged candidates on the Macro stage."
      />

      <div className="min-w-0 space-y-3">
        {/* Where the right pane is. A variable shows its name and a way back;
            otherwise the two lenses on the model. */}
        <div className="flex items-center gap-3">
          {column && known ? (
            <>
              <button onClick={() => setView('model')}
                className="inline-flex items-center gap-1.5 rounded-ctl border border-hairline px-2.5 py-1 text-xs text-ink-secondary hover:text-ink">
                <ArrowLeft /> Model
              </button>
              <span className="font-mono text-sm text-ink">{column}</span>
            </>
          ) : (
            <ViewTabs value={view === 'collinearity' ? 'collinearity' : 'model'}
              onChange={(v) => setView(v)}
              tabs={[
                { key: 'model' as View, label: 'Model' },
                { key: 'collinearity' as View, label: 'Multicollinearity',
                  title: 'Correlation and variance inflation across the selected variables' },
              ]} />
          )}
        </div>

        {column && known ? (
          <VariableDetail portfolio={portfolio} column={column} />
        ) : view === 'collinearity' ? (
          <CorrelationPanel portfolio={portfolio} />
        ) : (
          <ModelPane portfolio={portfolio}
                     onOpenVariable={(c) => setView('variable', c)} />
        )}
      </div>
      </div>
    </div>
  )
}
