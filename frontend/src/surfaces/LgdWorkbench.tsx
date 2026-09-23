import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type LgdSpecPayload, type PortfolioKey } from '../lib/api'
import { Card, CardHead, Skeleton, ViewTabs } from '../components/ui'
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

  // A tape without realised losses cannot rank drivers against severity, so
  // the screen is never asked; the stage becomes a declaration instead.
  const books = useQuery({ queryKey: ['portfolios'], queryFn: api.portfolios })
  const hasSeverity = books.data?.find((b) => b.key === pk)?.has_severity
  const screen = useQuery({
    queryKey: ['lgdscreen', portfolio, shortlisted.join(',')],
    queryFn: () => api.lgdScreen(portfolio, shortlisted),
    enabled: hasSeverity !== false,
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

  if (hasSeverity === false) {
    return (
      <div className="p-4">
        <ModelBand portfolio={portfolio} />
        <AssumedSeverityPane pk={pk} />
      </div>
    )
  }

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


/** The severity stage for a tape that carries no realised losses.
 *
 *  Nothing can be estimated here, and the pane says so instead of showing an
 *  empty candidate list. The one action is a DECLARED flat severity: entered,
 *  recorded in the specification, hashed like any other choice. Changing it on
 *  a saved pairing forks, like any other specification edit. The loss number
 *  scales one-for-one with the value, which is what the Scenarios stage's
 *  what-if control makes visible. */
function AssumedSeverityPane({ pk }: { pk: PortfolioKey }) {
  const fittedLgd = useUi((s) => s.fittedLgd[pk])
  const setFittedLgd = useUi((s) => s.setFittedLgd)
  const editLgd = useUi((s) => s.editLgd)
  const declared = fittedLgd?.spec.assumed_lgd ?? null
  const [pctText, setPctText] = useState(declared != null ? String(Math.round(declared * 100)) : '55')
  const [err, setErr] = useState<string | null>(null)

  // The gate applies the edited spec with an empty hash; identity is then
  // settled server-side. Cheap - nothing is estimated - so it runs itself.
  useEffect(() => {
    const v = fittedLgd?.spec.assumed_lgd
    if (v == null || fittedLgd?.hash) return
    api.lgdAssume(pk, v)
      .then((r) => setFittedLgd(pk, {
        spec: { drivers: [], categoricals: [], assumed_lgd: v },
        hash: r.hash, name: r.name, fittedAt: new Date().toISOString(),
        meanLgd: r.mean_lgd, nDefaults: 0,
      }))
      .catch((e) => setErr(String((e as Error).message)))
  }, [pk, fittedLgd?.spec.assumed_lgd, fittedLgd?.hash, setFittedLgd])

  const declare = () => {
    const v = Number(pctText) / 100
    if (!(v > 0 && v < 1)) { setErr('Enter a severity between 1 and 99 percent.'); return }
    setErr(null)
    editLgd(pk, () => ({ drivers: [], categoricals: [], assumed_lgd: v }),
            `the assumed severity (${Math.round(v * 100)}%)`,
            { drivers: [], categoricals: [] })
  }

  return (
    <div className="mx-auto max-w-[720px] space-y-3">
      <Card>
        <CardHead title="No realised LGD on this tape"
          subtitle="Declare one to price the book"
          caption="No lgd_realised column was mapped, so nothing can be estimated. Deal documents and rating-agency recovery assumptions are the usual sources for the figure." />
        <div className="space-y-3 px-4 pb-4">
          {declared != null && fittedLgd?.hash ? (
            <div className="rounded-ctl bg-sunken px-3 py-2.5">
              <p className="text-sm font-medium text-ink">
                Severity assumed at {Math.round(declared * 100)}%
              </p>
              <p className="mt-1 text-tiny leading-relaxed text-ink-secondary">
                Stress moves defaults, not severity. Lifetime loss scales
                one-for-one with this figure. Recorded as
                {' '}<span className="font-mono">{fittedLgd.name ?? `assumed ${Math.round(declared * 100)}%`}</span>.
              </p>
            </div>
          ) : (
            null
          )}
          <div className="flex items-center gap-2">
            <input type="number" min={1} max={99} value={pctText}
              onChange={(e) => setPctText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') declare() }}
              className="w-24 rounded-ctl border border-hairline bg-surface px-2 py-1.5 text-sm tnum" />
            <span className="text-sm text-ink-secondary">% of exposure lost at default</span>
            <button onClick={declare}
              className="ml-auto rounded-ctl bg-accent px-3 py-1.5 text-xs font-semibold text-white">
              {declared != null ? 'Change the assumption' : 'Declare this severity'}
            </button>
          </div>
          {err && (
            <p className="text-tiny" style={{ color: 'var(--status-critical)' }}>{err}</p>
          )}
          <p className="text-micro text-ink-muted">
            Flat across accounts and scenarios. Changing it on a saved model
            forks, like any other edit.
          </p>
        </div>
      </Card>
    </div>
  )
}
