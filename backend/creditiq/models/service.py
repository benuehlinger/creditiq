"""Fit orchestration: split, fit, score, diagnose, backtest — and cache.

The sample design deserves its own note, because getting it wrong is the most
common way a panel model flatters itself.

  TRAIN / TEST split by ACCOUNT, never by row. The same account appears in
  dozens of rows; a random row split puts the same borrower on both sides and the
  model learns the borrower rather than the risk. The split is by a hash of the
  account id, so it is stable across refits — an account never changes sides when
  a variable is added.

  OUT OF TIME split by PERFORMANCE DATE. This is the one that matters. The model
  is fitted only on months before the boundary and then asked about months it has
  never seen, which is the only honest analogue of putting it into production.

  The binning, the standardisation and the WoE maps are all fitted on TRAIN and
  applied to test and out-of-time. Re-deriving them per slice would leak.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import store
from ..analysis.rates import annualize
from . import backtest as B
from . import runcache
from . import design as D
from . import metrics as M
from .fit import FitResult, fit as run_fit, predict
from .naming import friendly_name
from .spec import ModelSpec

_CACHE: dict[str, "ModelRun"] = {}
MAX_CACHE = 24


@dataclass
class ModelRun:
    spec: ModelSpec
    hash: str
    name: str
    fit: FitResult
    diagnostics: dict
    backtest: dict
    scorecard: dict
    timings: dict
    downsampled: bool
    n_full: int
    created_at: str
    slices: dict = field(default_factory=dict)
    # The scored account-months, kept so the backtest can be RE-COHORTED at a
    # different frequency without refitting. Grouping the mortgage panel costs
    # under two seconds; refitting it costs six. Held as float32 — these are
    # probabilities for a chart, not an input to any further estimation.
    scored: dict = field(default_factory=dict)


_SPLIT_CACHE: dict[tuple, dict] = {}


def _account_split(accounts: np.ndarray, test_fraction: float, seed: int) -> np.ndarray:
    """True where the account belongs to the TEST side.

    Hashed rather than randomly sampled so that an account keeps its side across
    refits — otherwise a coefficient change could be a change in the split rather
    than a change in the model.
    """
    uniq = np.unique(accounts)
    ck = (int(uniq[0]), int(uniq[-1]), len(uniq), round(test_fraction, 6), seed)
    lookup = _SPLIT_CACHE.get(ck)
    if lookup is None:
        salt = str(seed).encode()
        h = np.array([int(hashlib.blake2b(salt + str(int(a)).encode(),
                                          digest_size=8).hexdigest(), 16) % 10_000
                      for a in uniq])
        lookup = dict(zip(uniq.tolist(), (h < int(test_fraction * 10_000)).tolist()))
        _SPLIT_CACHE[ck] = lookup
    # Vectorised lookup. A generator expression here ran once per ROW — 2.3M
    # Python-level calls per refit, which showed up as a measurable slice of the
    # budget in the profile.
    keys = np.fromiter(lookup.keys(), dtype=np.int64, count=len(lookup))
    vals = np.fromiter(lookup.values(), dtype=bool, count=len(lookup))
    order = np.argsort(keys)
    keys, vals = keys[order], vals[order]
    return vals[np.searchsorted(keys, accounts)]


def run(spec: ModelSpec, force: bool = False) -> ModelRun:
    key = spec.hash()
    if not force and key in _CACHE:
        return _CACHE[key]
    if not force:
        # Fitted before, in a previous process. Serving it from disk is what
        # makes "have I run this specification?" answer the same way across a
        # restart. The disk key carries the data fingerprint, so a run fitted
        # on a superseded panel is never found here.
        prev = runcache.load(spec.portfolio, "pd", key)
        if prev is not None:
            if len(_CACHE) >= MAX_CACHE:
                _CACHE.pop(next(iter(_CACHE)))
            _CACHE[key] = prev
            return prev

    t = {}
    t0 = time.perf_counter()
    df = store.analysis_frame(spec.portfolio)
    n_full = len(df)

    oot_from = pd.Timestamp(spec.sample.oot_from)
    in_time = df["performance_date"] < oot_from

    fit_df = df.loc[in_time]
    downsampled = False
    if spec.sample.downsample_rows and len(fit_df) > spec.sample.downsample_rows:
        # Event-preserving: keep every default, thin only the non-events. The
        # intercept is corrected afterwards so the fitted base rate still matches
        # the true one — an uncorrected case-control sample is calibrated to the
        # sample, not the book.
        rng = np.random.default_rng(spec.sample.seed)
        ev = np.flatnonzero(fit_df[spec.target_column].to_numpy() == 1)
        rest = np.flatnonzero(fit_df[spec.target_column].to_numpy() == 0)
        take = rng.choice(rest, size=max(spec.sample.downsample_rows - len(ev), 1000),
                          replace=False)
        fit_df = fit_df.iloc[np.sort(np.concatenate([ev, take]))]
        downsampled = True
    t["prepare"] = time.perf_counter() - t0

    # Masks first, on cheap columns only. Then the binning, standardisation and
    # WoE maps are fitted on TRAIN ALONE and applied to everything else — fitting
    # them on the whole in-time slice would leak the test side into the transform.
    t1 = time.perf_counter()
    train_mask = ~_account_split(fit_df["account_id"].to_numpy(),
                                 spec.sample.test_fraction, spec.sample.seed)
    des_train = D.build(fit_df.loc[train_mask], spec)
    # The full-panel design REUSES those maps, so it costs a digitize rather than
    # a second optimal-binning run. Building it twice from scratch was the single
    # largest cost in the refit.
    des_all = D.build(df, spec, woe_maps=des_train.woe_maps,
                      means=des_train.means, stds=des_train.stds,
                      basis_maps=des_train.basis_maps)
    t["design"] = time.perf_counter() - t1

    t2 = time.perf_counter()
    res = run_fit(des_train, spec)
    t["fit"] = time.perf_counter() - t2

    if downsampled:
        # prior correction for the case-control sample (King & Zeng)
        true_rate = float(df.loc[in_time, spec.target_column].mean())
        samp_rate = float(des_train.y.mean())
        if 0 < true_rate < 1 and 0 < samp_rate < 1:
            res.beta[0] -= np.log((samp_rate / (1 - samp_rate)) /
                                  (true_rate / (1 - true_rate)))

    # score every account-month in the FULL panel
    t3 = time.perf_counter()
    p_all = predict(des_all.X, res.beta)
    t["score"] = time.perf_counter() - t3

    all_in_time = des_all.dates < np.datetime64(oot_from)
    all_test = _account_split(des_all.accounts, spec.sample.test_fraction,
                              spec.sample.seed)
    slices = {
        "train": all_in_time & ~all_test,
        "test": all_in_time & all_test,
        "oot": ~all_in_time,
    }

    t4 = time.perf_counter()
    diag = {}
    for name, mask in slices.items():
        y_, p_ = des_all.y[mask], p_all[mask]
        if y_.sum() < 5:
            continue
        diag[name] = {
            "n": int(mask.sum()), "events": int(y_.sum()),
            "auc": M.auc(y_, p_), "gini": M.gini(y_, p_),
            "ks": M.ks(y_, p_)[0], "ks_at_score": M.ks(y_, p_)[1],
            "brier": M.brier(y_, p_), "log_loss": M.log_loss(y_, p_),
            "actual_annual": float(annualize(y_.mean())),
            "predicted_annual": float(annualize(p_.mean())),
        }
    ref = "test" if "test" in diag else "train"
    m_ref = slices[ref]
    diag["roc"] = M.roc_curve(des_all.y[m_ref], p_all[m_ref])
    diag["ks_curve"] = M.ks_curve(des_all.y[m_ref], p_all[m_ref])
    diag["calibration"] = M.calibration(des_all.y[m_ref], p_all[m_ref])
    diag["gains"] = M.gains_table(des_all.y[m_ref], p_all[m_ref])
    diag["mcfadden_r2"] = res.mcfadden_r2
    diag["reference_slice"] = ref
    t["diagnostics"] = time.perf_counter() - t4

    t5 = time.perf_counter()
    seg_col = next((c for c in df.columns
                    if c in getattr(store.load(spec.portfolio).spec,
                                    "categorical_betas", {})), None)
    cohorts = B.by_cohort(des_all.dates, des_all.y, p_all)
    bt = {
        "cohorts": cohorts,
        # The numbers behind the cohort chart, split at the out-of-time
        # boundary. A validator reads these before the picture.
        "errors": B.error_summary(cohorts, spec.sample.oot_from),
        "rank_order": B.rank_order_stability(des_all.dates, des_all.y, p_all),
        "score_psi": B.score_psi(des_all.dates, p_all),
        "vintages": B.vintage_curves(df, spec.target_column),
        "oot_from": spec.sample.oot_from,
        # What one point on the time axis IS, so the chart can say so.
        "period_freq": B.COHORT_FREQ_LABEL,
        "segment_column": seg_col,
        "segments": B.segment_backtest(df, des_all.y, p_all, seg_col) if seg_col else [],
    }
    t["backtest"] = time.perf_counter() - t5

    beta_by_name = dict(zip(res.columns, res.beta))
    sc = M.scorecard(woe_maps=res.woe_maps, beta=beta_by_name)
    t["total"] = time.perf_counter() - t0

    out = ModelRun(
        spec=spec, hash=key, name=spec.label or friendly_name(key), fit=res,
        diagnostics=diag, backtest=bt,
        scored={"dates": np.asarray(des_all.dates), "y": des_all.y.astype(np.int8),
                "oot_from": spec.sample.oot_from,
                "p": p_all.astype(np.float32)},
        scorecard={"base_score": sc.base_score, "base_odds": sc.base_odds,
                   "pdo": sc.pdo, "factor": sc.factor, "offset": sc.offset,
                   "points": sc.points},
        timings={k: round(v, 3) for k, v in t.items()},
        downsampled=downsampled, n_full=n_full,
        created_at=pd.Timestamp.utcnow().isoformat(timespec="seconds"),
        slices={k: int(v.sum()) for k, v in slices.items()},
    )
    if len(_CACHE) >= MAX_CACHE:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = out
    runcache.save(spec.portfolio, "pd", key, out)
    return out


def cached(hash_: str) -> ModelRun | None:
    hit = _CACHE.get(hash_)
    if hit is not None:
        return hit
    # The hash alone does not say which portfolio it belongs to, so the disk
    # fallback has to look in each book's directory. Three stat calls.
    from ..data.portfolios import PORTFOLIOS
    for p in PORTFOLIOS:
        prev = runcache.load(p, "pd", hash_)
        if prev is not None:
            _CACHE[hash_] = prev
            return prev
    return None


def clear() -> None:
    _CACHE.clear()
    D.clear_woe_cache()
