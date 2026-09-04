import { useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type LgdSpecPayload, type PortfolioKey } from '../lib/api'
import { Skeleton, ViewTabs } from '../components/ui'
import SpecificationList, { lgdRows } from '../components/SpecificationList'
import LgdVariableDetail, { LgdTarget } from './LgdVariableDetail'
import LgdModelPane from './LgdModelPane'
import { NONE, useUi } from '../lib/store'
import ModelBand from '../components/ModelBand'
import { ArrowLeft } from '../components/icons'

/**
 * The LGD workbench. The same shape as the PD workbench, on a different
 * population and target: the candidate list is the spine, the right pane is
 * the model, one driver, or the target itself.
 */
type View = 'model' | 'variable' | 'target'

export default function LgdWorkbench() {
  const { portfolio = 'consumer' } = useParams()
  const pk = portfolio as PortfolioKey
  const [params, setParams] = useSearchParams()
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const editLgd = useUi((s) => s.editLgd)
  const shortlisted = useUi((s) => s.macroShortlist[pk]?.lgd ?? NONE) as string[]

  const column = params.get('variable')
  const view: View = column ? 'variable' : params.get('view') === 'target' ? 'target' : 'model'
  const setView = (v: View, col?: string | null) => {
    const next = new URLSearchParams(params)
    next.delete('variable'); next.delete('view')
    if (v === 'variable' && col) next.set('variable', col)
    if (v === 'target') next.set('view', 'target')
    setParams(next, { replace: true })
  }
  useEffect(() => { if (column) setView('model') }, [portfolio])   // eslint-disable-line react-hooks/exhaustive-deps

  const screen = useQuery({
    queryKey: ['lgdscreen', portfolio, shortlisted.join(',')],
    queryFn: () => api.lgdScreen(portfolio, shortlisted),
  })
  const rows = screen.data?.rows ?? []
  const internal = useMemo(() => lgdRows(rows.filter((r) => !r.macro)), [screen.data])
  const macro = useMemo(() => lgdRows(rows.filter((r) => r.macro)), [screen.data])

  // One specification: the store's, seeded from the book's default when
  // nothing has been fitted. The edit goes through the guarded door.
  const spec = fittedLgd?.spec ?? screen.data?.default_spec ?? { drivers: [], categoricals: [] }
  const toggle = (c: string) => {
    const r = rows.find((x) => x.column === c)
    if (!r) return
    const key = r.kind === 'numeric' ? 'drivers' : 'categoricals'
    editLgd(pk, (x: LgdSpecPayload) => ({
      ...x,
      [key]: x[key].includes(c) ? x[key].filter((z) => z !== c) : [...x[key], c],
    }), c, spec)
  }
  // The bar's call to action targets this stage while a driver detail or the
  // target view is open; the pane that fits is not mounted there. Return to
  // the model view so it mounts, reads the flag and runs.
  const cta = useUi((s) => s.cta)
  useEffect(() => {
    if (cta === 'lgd' && view !== 'model') setView('model')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cta])

  const n = spec.drivers.length + spec.categoricals.length
  const known = !column || rows.some((r) => r.column === column)

  if (screen.isLoading || !screen.data) {
    return <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <Skeleton className="h-[600px]" /><Skeleton className="h-[600px]" />
    </div>
  }

  return (
    <div className="p-4">
      <ModelBand portfolio={portfolio} />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <SpecificationList
        internal={internal} macro={macro}
        picked={[...spec.drivers, ...spec.categoricals]}
        onToggle={toggle}
        onAddMacroTop={(cols) =>
          editLgd(pk, (x: LgdSpecPayload) => ({
            ...x,
            drivers: [...x.drivers, ...cols.filter((c) => !x.drivers.includes(c))],
          }), 'the strongest macro terms', spec)}
        selected={column} onSelect={(c) => setView(c === column ? 'model' : 'variable', c)}
        title="Candidate drivers"
        subtitle={`${n} driver${n === 1 ? '' : 's'} in the specification · ${screen.data.n_defaults.toLocaleString()} defaults`}
        statLabel="Rank correlation with realised severity on the defaulted population."
        macroNote="Joined at the default month. These are what make predicted severity respond to a scenario; a model with none returns the same LGD in a downturn as in a boom." />

      <div className="min-w-0 space-y-3">
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
            <ViewTabs value={view === 'target' ? 'target' : 'model'}
              onChange={(v) => setView(v)}
              tabs={[
                { key: 'model' as View, label: 'Model' },
                { key: 'target' as View, label: 'Realised severity',
                  title: 'The distribution of realised severity and how it has moved through time' },
              ]} />
          )}
        </div>
        {column && known ? (
          <LgdVariableDetail portfolio={portfolio} column={column} />
        ) : view === 'target' ? (
          <LgdTarget portfolio={portfolio} />
        ) : (
          <LgdModelPane portfolio={portfolio} spec={spec} onOpenVariable={(c) => setView('variable', c)} />
        )}
      </div>
      </div>
    </div>
  )
}
