import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLoadVersion } from '../lib/loadVersion'
import { usd } from '../lib/format'
import { api, type PortfolioKey } from '../lib/api'
import { useUi } from '../lib/store'
import { useModelIdentity, useProgress } from '../lib/progress'
import { StatusPill } from './ui'
import { ratio } from '../lib/format'

/**
 * The model, frozen at the top of every screen that works on it.
 *
 * A Model ID covers a PD specification and an LGD specification together,
 * because both produced the loss number. So the band has three cells: the
 * model, its PD half, its LGD half. Each half carries its own identity and the
 * one or two figures it is judged on, with a status. The detail behind each
 * figure is on the tabs below; this is the part that has to stay in view while
 * the analyst scrolls through coefficients and backtests.
 *
 * Statuses here are the same thresholds the verdict uses, computed once.
 */
type Sev = 'good' | 'warning' | 'serious' | 'critical'

export default function ModelBand({ portfolio }: { portfolio: string }) {
  const pk = portfolio as PortfolioKey
  const fitted = useUi((s) => s.fitted[pk])
  const lgd = useUi((s) => s.fittedLgd[pk])
  const loaded = useUi((s) => s.loaded[pk])
  const ident = useModelIdentity(portfolio)
  const progress = useProgress(portfolio)

  // The saved models on this book, for switching in place. Opening one from
  // here keeps the current screen and updates it to that model's results.
  const [open, setOpen] = useState(false)
  const pop = useRef<HTMLDivElement>(null)
  const versions = useQuery({ queryKey: ['versions', portfolio],
                              queryFn: () => api.versions(portfolio), enabled: open })
  const load = useLoadVersion(portfolio, { stay: true })
  const draft = useUi((s) => s.draft[pk])
  const restoreDraft = useUi((s) => s.restoreDraft)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  // The PD fit, from the same cache the model pane reads. No second request.
  const pd = useQuery({
    queryKey: ['model', fitted?.hash],
    queryFn: () => api.model(fitted!.hash),
    enabled: !!fitted?.hash, staleTime: Infinity, retry: false,
  }).data

  // ── PD figures and status ────────────────────────────────────────────────
  const aucT = pd?.diagnostics.test?.auc, aucO = pd?.diagnostics.oot?.auc
  const drop = aucT != null && aucO != null ? aucT - aucO : null
  const rat = pd?.backtest.errors?.out_of_time?.ratio
  const psiPts = pd?.backtest.score_psi ?? []
  const psi = psiPts.length ? psiPts[psiPts.length - 1].psi : null
  const pdSev: Sev | null = !pd ? null
    : (aucO != null && aucO < 0.65) || (drop ?? 0) > 0.10 || (rat != null && Math.abs(rat - 1) > 0.25) || (psi ?? 0) >= 0.25
      ? 'critical'
    : (drop ?? 0) > 0.05 || (rat != null && Math.abs(rat - 1) > 0.10) || (psi ?? 0) >= 0.10
      ? 'warning'
    : 'good'
  const pdWord = pdSev === 'good' ? 'fit for purpose' : pdSev === 'warning' ? 'review' : 'not fit for purpose'

  // ── LGD figures and status ───────────────────────────────────────────────
  const lgdFitted = !!lgd?.hash
  const lgdSev: Sev | null = !lgdFitted || lgd?.rmse == null ? null
    : Math.abs(lgd.bias ?? 0) > 0.05 ? 'critical'
    : Math.abs(lgd.bias ?? 0) > 0.02 ? 'warning'
    : 'good'
  const lgdWord = lgdSev === 'good' ? 'calibrated' : lgdSev === 'warning' ? 'review' : 'biased'

  const cell = 'min-w-0 px-5 py-3'
  const label = 'text-tiny uppercase tracking-wider text-ink-muted'

  // After a fork or an edit the fitted identity describes the PREVIOUS
  // specification. Keeping its name in the headline while the bar above said
  // "Working draft" had the two disagreeing about what is on screen; the name
  // and hash are withheld until a refit gives the draft an identity of its own.
  const provisional = !loaded && (progress.pdStale || progress.lgdStale)

  return (
    <div className="sticky top-0 z-20 -mx-4 -mt-4 mb-3 bg-page px-4 pt-4 pb-3">
      <div className="grid divide-x divide-hairline rounded-card border border-hairline bg-raised lg:grid-cols-[1.2fr_1fr_1fr]">
        {/* the model */}
        <div className={`relative ${cell}`} ref={pop}>
          <div className={label}>Model</div>
          <div className="mt-1 flex items-baseline gap-3">
            {/* The name opens the list of saved models on this book. Choosing
                one loads it here, on this screen, so two models can be read
                against each other without leaving the page. */}
            <button onClick={() => setOpen((o) => !o)}
              title="Switch to another saved model on this book, on this screen"
              className="group inline-flex items-baseline gap-2 text-left text-2xl font-semibold leading-none text-ink hover:text-accent">
              {provisional ? 'Working draft' : loaded?.name ?? ident.name ?? 'Unnamed'}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                   className="self-center opacity-40 group-hover:opacity-100">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {open && (
              <div className="absolute left-4 top-full z-30 mt-1 w-[30rem] rounded-card border border-hairline bg-raised shadow-pop">
                <div className="flex items-baseline justify-between border-b border-hairline px-3 py-2">
                  <span className="text-tiny font-medium text-ink">Saved models on this book</span>
                  <span className="text-micro text-ink-muted">Opens in place. An unsaved draft is replaced.</span>
                </div>
                <ul className="thin-scroll max-h-72 overflow-y-auto py-1">
                  {draft && (
                    <li className="border-b border-hairline">
                      <button onClick={() => { setOpen(false); restoreDraft(pk) }}
                        className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs hover:bg-sunken">
                        <span className="w-40 truncate font-medium text-ink">Working draft</span>
                        <StatusPill severity="warning">unsaved</StatusPill>
                        <span className="ml-auto text-ink-muted">
                          put aside when {loaded?.name ?? 'this model'} was opened
                        </span>
                      </button>
                    </li>
                  )}
                  {(versions.data ?? []).map((v) => {
                    const current = v.hash === (loaded?.hash ?? ident.hash)
                    const auc = v.metrics?.auc_test as number | undefined
                    const ecl = v.ecl?.ecl_severely_adverse as number | undefined
                    return (
                      <li key={v.hash}>
                        <button disabled={current || load.isPending}
                          onClick={() => { setOpen(false); load.mutate(v.hash) }}
                          className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs hover:bg-sunken disabled:cursor-default ${
                            current ? 'bg-accent-soft' : ''}`}>
                          <span className="w-40 truncate font-medium text-ink">{v.name}</span>
                          <StatusPill severity={v.status === 'champion' ? 'good' : 'warning'}>
                            {v.status}
                          </StatusPill>
                          <span className="ml-auto tnum text-ink-secondary">
                            {auc != null ? `AUC ${auc.toFixed(3)}` : ''}
                          </span>
                          <span className="w-16 text-right tnum text-ink-secondary">
                            {ecl != null ? usd(ecl) : ''}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                  {versions.data && versions.data.length === 0 && (
                    <li className="px-3 py-3 text-xs text-ink-muted">No saved models on this book yet.</li>
                  )}
                </ul>
              </div>
            )}
            {loaded && progress.mode !== 'edited' ? (
              <StatusPill severity="good">saved</StatusPill>
            ) : progress.chain.fit === 'current' ? (
              <StatusPill severity="warning">not saved</StatusPill>
            ) : null}
          </div>
          <p className="mt-1.5 truncate text-xs text-ink-secondary">
            {provisional ? (
              <>the specification changed · a refit gives it a Model ID</>
            ) : (
              <>
                <span className="font-mono text-ink-muted">{loaded?.hash ?? ident.hash ?? '—'}</span>
                {loaded && progress.mode === 'edited' && <> · edited since opened</>}
                {!loaded && !ident.complete && <> · a Model ID needs both halves fitted</>}
              </>
            )}
          </p>
        </div>

        {/* the PD half */}
        <div className={cell} title={pd ? `AUC ${ratio(aucT)} on test and ${ratio(aucO)} out of time. Level ${rat?.toFixed(2)}× out of time. Score PSI ${psi?.toFixed(2)} latest.` : undefined}>
          <div className={label}>PD</div>
          {fitted ? (
            <>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-base text-ink">{fitted.hash}</span>
                {progress.pdStale
                  ? <StatusPill severity="warning">out of date</StatusPill>
                  : pdSev && <StatusPill severity={pdSev}>{pdWord}</StatusPill>}
              </div>
              <p className="mt-1.5 tnum text-xs text-ink-secondary">
                {/* Two AUCs, named. "0.769 → 0.745" read as a before-and-after
                    of some recalculation; they are the same fit measured on
                    two samples. */}
                {pd ? <>AUC {ratio(aucT)} test · {ratio(aucO)} out of time{rat != null && <> · level {rat.toFixed(2)}×</>}{psi != null && <> · PSI {psi.toFixed(2)}</>}</>
                    : <span className="skeleton inline-block h-3 w-40 align-middle" />}
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-xs text-ink-muted">not fitted</p>
          )}
        </div>

        {/* the LGD half */}
        <div className={cell} title={lgdFitted && lgd?.rmse != null ? `Root mean square error ${lgd.rmse.toFixed(3)} on realised severity, bias ${(lgd.bias ?? 0) >= 0 ? '+' : ''}${(lgd.bias ?? 0).toFixed(3)}. Deviance R² ${lgd.devianceR2?.toFixed(3)}.` : undefined}>
          <div className={label}>LGD</div>
          {lgdFitted ? (
            <>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-base text-ink">{lgd!.hash}</span>
                {progress.lgdStale
                  ? <StatusPill severity="warning">out of date</StatusPill>
                  : lgdSev && <StatusPill severity={lgdSev}>{lgdWord}</StatusPill>}
              </div>
              <p className="mt-1.5 tnum text-xs text-ink-secondary">
                {lgd!.rmse != null
                  ? <>RMSE {lgd!.rmse.toFixed(3)} · bias {(lgd!.bias ?? 0) >= 0 ? '+' : ''}{(lgd!.bias ?? 0).toFixed(3)} · mean {(lgd!.meanLgd * 100).toFixed(1)}%</>
                  : <>{lgd!.spec.drivers.length + lgd!.spec.categoricals.length} drivers · mean {(lgd!.meanLgd * 100).toFixed(1)}%</>}
              </p>
            </>
          ) : lgd?.spec && (lgd.spec.drivers.length || lgd.spec.categoricals.length) ? (
            <p className="mt-1.5 text-xs text-ink-muted">
              {lgd.spec.drivers.length + lgd.spec.categoricals.length} drivers selected · not fitted
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-ink-muted">not fitted</p>
          )}
        </div>
      </div>
    </div>
  )
}
