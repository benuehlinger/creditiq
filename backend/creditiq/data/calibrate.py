"""Calibration harness for the generative engine.

Two numbers decide whether a synthetic portfolio is credible:

  1. The realised default rate must sit in the band a practitioner expects for
     that asset class. Too high and the book looks like a subprime disaster; too
     low and there is nothing to model.

  2. AUC must land in 0.72-0.82. This is the number that gives the demo away. A
     synthetic dataset that scores 0.97 tells the room instantly that the
     features were reverse-engineered from the target. The frailty term is what
     holds AUC down, and this harness is how we tune it.

`measure` fits the same kind of model the platform will fit, so the AUC reported
here is the AUC the demo will show — not an optimistic proxy.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from .generate import generate
from .spec import PortfolioSpec

TARGET_AUC = (0.72, 0.82)
TARGET_RATE = {"consumer": (3.0, 6.0), "mortgage": (0.5, 2.0), "cre": (1.0, 3.0)}


@dataclass
class Diagnostics:
    portfolio: str
    rows: int
    accounts: int
    annual_default_rate: float
    auc_in_time: float
    auc_out_of_time: float
    avg_life_months: float
    terminal_mix: dict[str, float]
    rate_by_year: pd.Series
    rate_in_band: bool
    auc_in_band: bool

    def summary(self) -> str:
        lo, hi = TARGET_RATE[self.portfolio]
        rate_ok = "OK " if self.rate_in_band else "OUT"
        auc_ok = "OK " if self.auc_in_band else "OUT"
        mix = "  ".join(f"{k}={v:.1%}" for k, v in self.terminal_mix.items())
        return (f"{self.portfolio:9s} rows={self.rows:>9,}  accts={self.accounts:>6,}  "
                f"life={self.avg_life_months:5.1f}m\n"
                f"          default {self.annual_default_rate:5.2f}%/yr "
                f"[{rate_ok} target {lo}-{hi}]   "
                f"AUC in-time {self.auc_in_time:.3f} / OOT {self.auc_out_of_time:.3f} "
                f"[{auc_ok} target {TARGET_AUC[0]}-{TARGET_AUC[1]}]\n"
                f"          terminal: {mix}")


def design_matrix(panel: pd.DataFrame, accounts: pd.DataFrame,
                  spec: PortfolioSpec) -> tuple[pd.DataFrame, np.ndarray]:
    """The observables an analyst would actually have. Frailty is NOT included —
    it is unobserved by construction, which is the whole point of it."""
    static_cols = [c for c in spec.numeric_betas if c in accounts.columns]
    cat_cols = list(spec.categorical_betas)
    df = panel.merge(accounts[["account_id", *static_cols, *cat_cols, "interest_rate"]],
                     on="account_id", how="left")
    X = df[static_cols + ["interest_rate"]].astype(float).copy()
    # Seasoning enters as a piecewise-linear spline, not a single linear term.
    # The hazard's age profile is a hump; a linear month count cannot represent it
    # and leaves age confounded with whatever else drifts over the book's life.
    mob = df["months_on_book"].to_numpy(float)
    X["months_on_book"] = mob
    X["log_months_on_book"] = np.log1p(mob)
    for knot in (6, 12, 24, 36, 60, 96, 144):
        X[f"mob_gt_{knot}"] = np.maximum(mob - knot, 0.0)
    for c in spec.numeric_betas:                     # time-varying drivers
        col = spec.observed_aliases.get(c, c)         # what the TAPE shows
        if col in panel.columns:
            X[col] = df[col].astype(float)
    # the macro drivers the model is allowed to see
    for c in spec.mev_keys:
        if c in df.columns:
            X[c] = df[c].astype(float)
    for c in cat_cols:
        d = pd.get_dummies(df[c], prefix=c, drop_first=True, dtype=float)
        X = pd.concat([X, d], axis=1)
    X = X.fillna(X.median(numeric_only=True))
    return X, df["default_flag"].to_numpy()


def measure(spec: PortfolioSpec, seed: int = 1, oot_from: str = "2023-01-01",
            sample: int = 400_000) -> Diagnostics:
    res = generate(spec, seed=seed)
    panel, accounts = res.panel, res.accounts
    X, y = design_matrix(panel, accounts, spec)

    rng = np.random.default_rng(seed)
    if len(X) > sample:                              # fitting a 1.2M-row logit is
        take = rng.choice(len(X), sample, replace=False)   # not needed to read AUC
    else:
        take = np.arange(len(X))
    dates = panel["performance_date"].to_numpy()
    oot = dates >= np.datetime64(oot_from)

    def fit_auc(train_mask, test_mask):
        tr = np.intersect1d(take, np.flatnonzero(train_mask))
        te = np.intersect1d(take, np.flatnonzero(test_mask))
        if y[tr].sum() < 20 or y[te].sum() < 20:
            return float("nan")
        m = LogisticRegression(max_iter=400, C=1.0)
        Xtr = X.iloc[tr]
        mu, sd = Xtr.mean(), Xtr.std().replace(0, 1)
        m.fit((Xtr - mu) / sd, y[tr])
        return roc_auc_score(y[te], m.predict_proba((X.iloc[te] - mu) / sd)[:, 1])

    auc_it = fit_auc(~oot, ~oot)
    auc_oot = fit_auc(~oot, oot)

    n_term = int(panel.default_flag.sum() + panel.prepaid_flag.sum()
                 + panel.matured_flag.sum())
    mix = {
        "default": float(panel.default_flag.sum()) / max(n_term, 1),
        "payoff": float(panel.prepaid_flag.sum()) / max(n_term, 1),
        "matured": float(panel.matured_flag.sum()) / max(n_term, 1),
    }
    rate = float(panel.default_flag.mean() * 1200)
    lo, hi = TARGET_RATE[spec.key]
    return Diagnostics(
        portfolio=spec.key, rows=len(panel), accounts=int(panel.account_id.nunique()),
        annual_default_rate=rate, auc_in_time=auc_it, auc_out_of_time=auc_oot,
        avg_life_months=len(panel) / max(panel.account_id.nunique(), 1),
        terminal_mix=mix,
        rate_by_year=panel.groupby(panel.performance_date.dt.year)
                          .default_flag.mean().mul(1200).round(2),
        rate_in_band=lo <= rate <= hi,
        auc_in_band=TARGET_AUC[0] <= auc_it <= TARGET_AUC[1],
    )


def _rate_only(spec: PortfolioSpec, seed: int) -> float:
    return float(generate(spec, seed=seed).panel.default_flag.mean() * 1200)


def tune_intercept(spec: PortfolioSpec, target: float | None = None,
                   seed: int = 1, iters: int = 14, scale_n: int = 12_000,
                   verbose: bool = True) -> float:
    """Bisect the roll intercept until the realised default rate hits `target`.

    Tuning runs on a reduced account count — the default RATE is a per-account-
    month property and barely moves with portfolio size, while the runtime does.
    The result is verified at full size by the caller.
    """
    from dataclasses import replace
    lo_t, hi_t = TARGET_RATE[spec.key]
    target = target if target is not None else (lo_t + hi_t) / 2
    small = replace(spec, n_accounts=min(scale_n, spec.n_accounts))

    lo, hi = spec.intercept - 4.0, spec.intercept + 2.0
    best, best_err = spec.intercept, float("inf")
    for i in range(iters):
        mid = (lo + hi) / 2
        rate = _rate_only(replace(small, intercept=mid), seed)
        err = abs(rate - target)
        if err < best_err:
            best, best_err = mid, err
        if verbose:
            print(f"    iter {i:2d}  intercept {mid:7.3f} -> {rate:6.2f}%/yr "
                  f"(target {target:.2f})")
        if rate > target:
            hi = mid
        else:
            lo = mid
        if err / target < 0.01:
            break
    return best


def tune_frailty(spec: PortfolioSpec, target_auc: float = 0.775, seed: int = 1,
                 candidates: tuple[float, ...] = (0.5, 0.7, 0.9, 1.1, 1.4, 1.8),
                 verbose: bool = True) -> tuple[float, float]:
    """Find the frailty scale that puts AUC in the credible band.

    Frailty is unobserved borrower quality. It is the RIGHT lever for AUC because
    it says something true — part of credit outcome is not in the data — rather
    than weakening a driver whose economics we believe. Raising it lowers AUC
    without touching a single coefficient's meaning.

    The intercept is re-tuned at each candidate, because more frailty variance
    raises the mean hazard through Jensen's inequality and would otherwise drag
    the default rate along with it.
    """
    from dataclasses import replace
    best = (spec.frailty_sd, spec.intercept, float("inf"))
    for f in candidates:
        cand = replace(spec, frailty_sd=f)
        icept = tune_intercept(cand, seed=seed, verbose=False)
        d = measure(replace(cand, intercept=icept), seed=seed)
        err = abs(d.auc_in_time - target_auc)
        if verbose:
            print(f"    frailty {f:4.2f}  intercept {icept:7.3f}  "
                  f"AUC {d.auc_in_time:.3f}  rate {d.annual_default_rate:5.2f}%")
        if err < best[2]:
            best = (f, icept, err)
    return best[0], best[1]
