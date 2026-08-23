"""Loss given default — a two-stage fractional response model.

Realised severity is not a smooth unimodal quantity. A secured loan that defaults
with equity liquidates whole and loses nothing; the same loan underwater loses
thirty or forty points. Modelling that as one beta distribution produces a
severity curve no recovery analyst recognises, and the boundary mass at zero —
which is most of the distribution on a mortgage book — disappears entirely.

So it is fitted in two stages:

  stage 1   P(loss > 0)        logistic
  stage 2   E[loss | loss > 0] fractional logit, quasi-likelihood

  E[LGD] = P(loss > 0) x E[loss | loss > 0]

The second stage uses the Bernoulli quasi-likelihood on a continuous [0,1]
target, which is the standard fractional-response estimator (Papke and
Wooldridge). It is consistent for the conditional mean without pretending the
fractional outcome is actually binomial.

The whole point is that LGD MOVES WITH THE SCENARIO. A downturn LGD that does not
respond is the most common thing a validator catches, so the macro drivers enter
both stages explicitly.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .fit import _sigmoid, irls

# Drivers per portfolio: collateral position at default, macro at default,
# workout duration, and support.
LGD_DRIVERS: dict[str, list[str]] = {
    "consumer": ["fico_orig", "months_on_book", "unemployment_rate"],
    "mortgage": ["cltv", "current_ltv", "workout_months", "hpi_yoy", "months_on_book"],
    "cre": ["current_ltv", "dscr_reported", "workout_months", "cre_price_index_yoy"],
}
CATEGORICAL_DRIVERS: dict[str, list[str]] = {
    "consumer": [], "mortgage": ["occupancy"], "cre": ["guarantor_flag", "property_type"],
}


@dataclass
class LgdModel:
    portfolio: str
    columns: list[str]
    beta_occurrence: np.ndarray
    beta_severity: np.ndarray
    means: np.ndarray
    stds: np.ndarray
    levels: dict[str, list[str]]
    n_defaults: int
    mean_lgd: float
    zero_loss_share: float
    mean_severity_given_loss: float
    mean_workout_months: float = 12.0
    fit_note: str = ""
    calibration: list[dict] = field(default_factory=list)

    def predict(self, X: np.ndarray) -> np.ndarray:
        p_loss = _sigmoid(X @ self.beta_occurrence)
        sev = _sigmoid(X @ self.beta_severity)
        return np.clip(p_loss * sev, 0.0, 1.0)

    def predict_parts(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return _sigmoid(X @ self.beta_occurrence), _sigmoid(X @ self.beta_severity)


def _matrix(df: pd.DataFrame, portfolio: str, levels: dict[str, list[str]] | None = None,
            means=None, stds=None):
    cols, names = [], []
    for c in LGD_DRIVERS[portfolio]:
        if c not in df.columns:
            continue
        v = pd.to_numeric(df[c], errors="coerce")
        cols.append(v.fillna(v.median()).to_numpy(float)); names.append(c)
    lv = dict(levels or {})
    for c in CATEGORICAL_DRIVERS[portfolio]:
        if c not in df.columns:
            continue
        vals = df[c].astype(str)
        keep = lv.get(c) or sorted(vals.value_counts().index[:6].tolist())
        lv[c] = keep
        for k in keep[1:]:                        # drop-first
            cols.append((vals == k).to_numpy(float)); names.append(f"{c}={k}")
    X = np.column_stack(cols) if cols else np.zeros((len(df), 0))
    if means is None:
        means = X.mean(axis=0)
        stds = X.std(axis=0); stds[stds < 1e-12] = 1.0
    X = np.column_stack([np.ones(len(df)), (X - means) / stds])
    return X, ["intercept", *names], lv, means, stds


def fractional_logit(X: np.ndarray, y: np.ndarray, max_iter: int = 60) -> np.ndarray:
    """Quasi-likelihood fractional logit (Papke-Wooldridge).

    Same score equations as a logistic regression, but the target is a proportion
    in [0,1] rather than a 0/1 outcome. It is consistent for the conditional mean
    without assuming the fraction is a count of Bernoulli trials, which it is not.
    """
    beta = np.zeros(X.shape[1])
    for _ in range(max_iter):
        eta = X @ beta
        mu = _sigmoid(eta)
        w = np.clip(mu * (1 - mu), 1e-8, None)
        z = eta + (y - mu) / w
        XtWX = (X * w[:, None]).T @ X
        XtWX[np.diag_indices_from(XtWX)] += 1e-8
        try:
            nb = np.linalg.solve(XtWX, (X * w[:, None]).T @ z)
        except np.linalg.LinAlgError:
            nb = np.linalg.lstsq(XtWX, (X * w[:, None]).T @ z, rcond=None)[0]
        if np.max(np.abs(nb - beta)) < 1e-9:
            beta = nb
            break
        beta = nb
    return beta


def fit_lgd(df: pd.DataFrame, portfolio: str, mev_panel: pd.DataFrame) -> LgdModel:
    """Fit on the DEFAULTED account-months only — the only rows where a realised
    severity exists."""
    d = df.loc[df["default_flag"] == 1].copy()
    if len(d) < 60:
        raise ValueError(f"{portfolio}: only {len(d)} defaults — too few to fit LGD")

    # macro AT DEFAULT, joined on the default month
    idx = pd.DatetimeIndex(d["performance_date"]).to_period("M").to_timestamp()
    for c in ("unemployment_rate", "hpi_yoy", "cre_price_index_yoy"):
        if c in mev_panel.columns:
            d[c] = mev_panel[c].reindex(idx).to_numpy()

    y = d["lgd_realised"].to_numpy(float).clip(0, 1)
    X, names, lv, means, stds = _matrix(d, portfolio)

    has_loss = (y > 1e-9).astype(float)
    beta_occ, _, _, _ = irls(X, has_loss)

    pos = y > 1e-9
    if pos.sum() < 30:
        beta_sev = np.zeros(X.shape[1])
        beta_sev[0] = np.log(max(y.mean(), 1e-6) / max(1 - y.mean(), 1e-6))
        note = "Too few non-zero severities to fit stage 2; a constant mean is used."
    else:
        beta_sev = fractional_logit(X[pos], np.clip(y[pos], 1e-6, 1 - 1e-6))
        note = ""

    model = LgdModel(
        portfolio=portfolio, columns=names, beta_occurrence=beta_occ,
        beta_severity=beta_sev, means=means, stds=stds, levels=lv,
        n_defaults=int(len(d)), mean_lgd=float(y.mean()),
        zero_loss_share=float((y <= 1e-9).mean()),
        mean_severity_given_loss=float(y[pos].mean()) if pos.any() else float("nan"),
        mean_workout_months=float(d["workout_months"].replace(0, np.nan).mean())
        if "workout_months" in d.columns else 12.0,
        fit_note=note,
    )
    # actual against predicted severity by cohort of predicted LGD
    pred = model.predict(X)
    q = np.unique(np.quantile(pred, np.linspace(0, 1, 6)))
    if len(q) > 2:
        b = np.clip(np.digitize(pred, q[1:-1]), 0, len(q) - 2)
        model.calibration = [
            {"cohort": int(k) + 1, "n": int((b == k).sum()),
             "predicted": float(pred[b == k].mean()),
             "actual": float(y[b == k].mean()),
             "zero_loss_share": float((y[b == k] <= 1e-9).mean())}
            for k in range(len(q) - 1) if (b == k).any()
        ]
    return model


def design_for(df: pd.DataFrame, model: LgdModel) -> np.ndarray:
    X, _, _, _, _ = _matrix(df, model.portfolio, levels=model.levels,
                            means=model.means, stds=model.stds)
    return X
