import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, type PortfolioKey, type VersionRecord } from './api'
import { useUi } from './store'

/** Restore a saved model into the workspace.
 *
 *  The stored specification is applied to the store, not the stored results. Each
 *  surface then re-estimates from that specification when it mounts, so the
 *  diagnostics, backtest, LGD coefficients and projection on screen are produced
 *  by the specification rather than read from a record of an earlier run. A
 *  difference between the replayed Model ID and the stored one would indicate
 *  that the inputs or the engine had changed since it was saved. */
export function useLoadVersion(portfolio: string) {
  const pk = portfolio as PortfolioKey
  const nav = useNavigate()
  const setFitted = useUi((s) => s.setFitted)
  const setFittedLgd = useUi((s) => s.setFittedLgd)
  const setLoaded = useUi((s) => s.setLoaded)
  const setTreatment = useUi((s) => s.setTreatment)
  const setKnots = useUi((s) => s.setKnots)
  const clearVariables = useUi((s) => s.clearVariables)
  const toggleVariable = useUi((s) => s.toggleVariable)

  return useMutation({
    mutationFn: (hash: string) => api.version(hash),
    onSuccess: (v: VersionRecord) => {
      const spec = v.spec as any
      clearVariables(pk)
      for (const variable of spec.variables ?? []) {
        toggleVariable(pk, variable.column)
        if (variable.treatment) setTreatment(pk, variable.column, variable.treatment)
        setKnots(pk, variable.column, variable.knots ?? undefined)
      }
      setFitted(pk, {
        request: {
          portfolio: v.portfolio,
          variables: spec.variables ?? [],
          mevs: spec.mevs ?? [],
          estimator: spec.estimator, regularization: spec.regularization,
          seasoning_spline: spec.seasoning_spline, vintage_effect: spec.vintage_effect,
          test_fraction: spec.sample?.test_fraction, oot_from: spec.sample?.oot_from,
          downsample_rows: spec.sample?.downsample_rows,
          lgd: spec.lgd ?? null, parent_hash: v.hash,
        },
        hash: v.hash, name: v.name, fittedAt: v.created_at,
        variablesAtFit: (spec.variables ?? []).map((x: any) => x.column),
      })
      // hash is left empty: the specification is known, the fit has not run yet.
      // Each model surface re-estimates on mount and fills it in.
      setFittedLgd(pk, spec.lgd
        ? { spec: spec.lgd, hash: '', fittedAt: '', meanLgd: NaN, nDefaults: 0 }
        : null)
      setLoaded(pk, { hash: v.hash, name: v.name, status: v.status,
                      loadedAt: new Date().toISOString() })
      nav(`/${portfolio}/pd/fit`)
    },
  })
}
