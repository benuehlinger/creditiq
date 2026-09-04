import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, type PortfolioKey, type VersionRecord } from './api'
import { useUi } from './store'
import { fromRequest } from './spec'

/** Restore a saved model into the workspace.
 *
 *  The stored specification is applied to the store, not the stored results. Each
 *  surface then re-estimates from that specification when it mounts, so the
 *  diagnostics, backtest, LGD coefficients and projection on screen are produced
 *  by the specification rather than read from a record of an earlier run. A
 *  difference between the replayed Model ID and the stored one would indicate
 *  that the inputs or the engine had changed since it was saved. */
export function useLoadVersion(portfolio: string, opts: { stay?: boolean } = {}) {
  const pk = portfolio as PortfolioKey
  const nav = useNavigate()
  const setFitted = useUi((s) => s.setFitted)
  const setFittedLgd = useUi((s) => s.setFittedLgd)
  const setLoaded = useUi((s) => s.setLoaded)
  const setPdSpec = useUi((s) => s.setPdSpec)
  const stashDraft = useUi((s) => s.stashDraft)

  return useMutation({
    mutationFn: (hash: string) => api.version(hash),
    onSuccess: (v: VersionRecord) => {
      // Whatever was being worked on is kept, so it can be come back to.
      stashDraft(pk)
      const spec = v.spec as any
      // Restore the WHOLE specification in one move. Replaying it variable by
      // variable restored only the settings the loop happened to know about —
      // treatments and knots, never bin edges, bin counts, the estimator or the
      // out-of-time boundary — so an opened version was not the version.
      setPdSpec(pk, fromRequest({
        variables: spec.variables ?? [],
        mevs: spec.mevs ?? [],
        estimator: spec.estimator,
        oot_from: spec.sample?.oot_from,
        downsample_rows: spec.sample?.downsample_rows,
      }, v.portfolio))
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
        pdHash: (v.metrics?.pd_hash as string | undefined),
        variablesAtFit: (spec.variables ?? []).map((x: any) => x.column),
      })
      // hash is left empty: the specification is known, the fit has not run yet.
      // Each model surface re-estimates on mount and fills it in.
      // The record carries the severity half's hash and the metrics it was
      // saved with. The hash is set from the record: a saved version IS
      // fitted, on both halves, and leaving it empty made every screen report
      // the severity model as missing and the projection as using a
      // substituted default, when it was using this model's own
      // specification. The severity pane still re-estimates on its next visit
      // and replaces the stored figures with replayed ones.
      setFittedLgd(pk, spec.lgd
        ? { spec: spec.lgd, hash: v.metrics?.lgd_hash ?? '', fittedAt: v.created_at,
            meanLgd: v.metrics?.lgd_mean_actual ?? NaN,
            nDefaults: v.metrics?.lgd_n ?? 0,
            rmse: v.metrics?.lgd_rmse ?? undefined,
            bias: v.metrics?.lgd_bias ?? undefined,
            devianceR2: v.metrics?.lgd_deviance_r2 ?? undefined }
        : null)
      setLoaded(pk, { hash: v.hash, name: v.name, status: v.status,
                      loadedAt: new Date().toISOString() })
      // From the Versions page, opening a model goes to it. From the model
      // band, opening one stays on the current screen and that screen updates
      // to the model's results, which is how two models get compared on the
      // same page.
      if (!opts.stay) nav(`/${portfolio}/pd`)
    },
  })
}
