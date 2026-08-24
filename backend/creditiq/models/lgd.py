"""Loss given default — a fractional logit on realised severity.

The target is `lgd_realised`, a proportion in [0, 1] observed on defaulted
account-months. It is fitted with the Papke-Wooldridge fractional response
estimator: the Bernoulli quasi-likelihood applied to a continuous target. The
estimator is consistent for the conditional mean E[LGD | X] without the
assumption that the proportion is a count of Bernoulli trials.

    E[LGD | X] = sigmoid(X . beta)

Macro drivers are joined at the default month, so predicted severity responds to
the scenario. This is the property that makes the LGD term contribute to a
stressed loss number rather than acting as a constant multiplier.

A two-stage form — P(loss > 0) times E[loss | loss > 0] — models the mass of
defaults that resolve with no loss explicitly. It is available in the literature
and was implemented here previously. It is not used at present: the single
fractional logit is the simpler specification and is sufficient for the
conditional mean. The zero-loss share is reported as a descriptive statistic so
the size of the boundary mass remains visible.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .fit import _sigmoid
from .spec import (CATEGORICAL_DRIVERS, LGD_DRIVERS, LGD_MACRO,  # noqa: F401
                   LgdSpec)

@dataclass
class LgdModel:
    portfolio: str
    spec: LgdSpec
    columns: list[str]
    beta: np.ndarray
    means: np.ndarray
    stds: np.ndarray
    levels: dict[str, list[str]]
    n_defaults: int
    mean_lgd: float
    zero_loss_share: float
    mean_severity_given_loss: float
    # Binning and spline-basis maps from the FIT, reused at score time. Deriving
    # them again on the rows being scored produces different columns for the same
    # coefficients.
    maps: dict = field(default_factory=dict)
    mean_workout_months: float = 12.0
    fit_note: str = ""
    calibration: list[dict] = field(default_factory=list)
    coefficients: list[dict] = field(default_factory=list)
    covariance: np.ndarray | None = None
    severity_histogram: list[dict] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)

    def predict(self, X: np.ndarray) -> np.ndarray:
        return np.clip(_sigmoid(X @ self.beta), 0.0, 1.0)


def _matrix(df: pd.DataFrame, spec: LgdSpec, levels: dict[str, list[str]] | None = None,
            means=None, stds=None, maps: dict[str, dict] | None = None):
    """Build the severity design, applying each driver's treatment.

    Three treatments, on a fractional target:

      bins         bin, then one indicator per bin less a reference. k-1 columns.
      continuous   the standardised variable. One column, linear in the logit.
      spline       an orthogonalised piecewise-linear basis at the knots.

    There is deliberately no weight-of-evidence treatment. Weight of evidence is
    a log-odds ratio between a bin's event and non-event shares, which needs a
    BINARY target; severity is a proportion, and there are no non-events to take
    a share of. A CATEGORICAL always takes `bins`, one indicator per level less a
    reference — see the `or cat` below.

    At SCORE time — signalled by `means` — every fitted driver must be present
    and every binning and basis map is reused from the fit. Re-deriving a binning
    on the rows being scored would apply the coefficients to different columns.
    """
    from ..analysis.severity_binning import _logit, bin_severity
    from ..analysis.spline import quantile_knots, spline_basis

    scoring = means is not None
    if scoring:
        missing = [c for c in (*spec.drivers, *spec.categoricals)
                   if c not in df.columns]
        if missing:
            raise ValueError(
                f"{spec.portfolio} LGD: fitted on {', '.join(missing)}, which "
                f"the frame being scored does not carry. The projection must "
                f"attach every driver the model was fitted on.")

    y = np.clip(pd.to_numeric(df.get("lgd_realised", pd.Series(dtype=float)),
                              errors="coerce").to_numpy(float), 0.0, 1.0) \
        if "lgd_realised" in df.columns else None

    m_out: dict[str, dict] = dict(maps or {})
    cols, names = [], []
    lv = dict(levels or {})

    for c in (*spec.drivers, *spec.categoricals):
        if c not in df.columns:
            continue
        x = df[c]
        t = spec.treatment_of(c)
        cat = c in spec.categoricals

        if t == "bins" or cat:
            key = m_out.get(c)
            if key is None:
                if y is None:
                    raise ValueError(f"cannot bin {c!r} without a target")
                b = bin_severity(x, pd.Series(y, index=df.index),
                                 max_bins=spec.max_bins, edges=spec.edges_of(c))
                key = {"kind": b.kind, "edges": b.edges, "book": b.book_mean,
                       "labels": [z.label for z in b.bins],
                       "levels": [z.levels for z in b.bins],
                       "weights": [z.weight for z in b.bins],
                       "means": [z.mean for z in b.bins]}
                m_out[c] = key
            idx = _bin_index(x, key)
            # k-1 indicators, first bin as reference; two bins emit a flag
            k = len(key["labels"])
            flag = k == 2
            for bi in range(1, k):
                cols.append((idx == bi).astype(float))
                names.append(f"{c}_flag" if flag else f"{c}={key['labels'][bi]}")
        elif t == "spline":
            v = pd.to_numeric(x, errors="coerce")
            vals = v.fillna(v.median()).to_numpy(float)
            fitted = m_out.get(f"__basis__{c}")
            ks = spec.knots_of(c) or quantile_knots(vals, spec.n_knots)
            B, sub, meta = spline_basis(vals, ks, fitted=fitted)
            m_out[f"__basis__{c}"] = meta
            for j in range(B.shape[1]):
                cols.append(B[:, j])
                names.append(f"{c}_{sub[j]}")
        else:
            v = pd.to_numeric(x, errors="coerce")
            cols.append(v.fillna(v.median()).to_numpy(float))
            names.append(c)

    X = np.column_stack(cols) if cols else np.zeros((len(df), 0))
    if means is None:
        means = X.mean(axis=0)
        stds = X.std(axis=0)
        stds[stds < 1e-12] = 1.0
    if X.shape[1] != len(means):
        raise ValueError(
            f"{spec.portfolio} LGD: the design has {X.shape[1]} columns and the "
            f"fitted model has {len(means)}. A binning or basis map did not carry "
            f"through from the fit.")
    X = np.column_stack([np.ones(len(df)), (X - means) / stds])
    return X, ["intercept", *names], lv, means, stds, m_out


def _bin_index(x: pd.Series, key: dict) -> np.ndarray:
    """Which bin each row falls in, using the binning FITTED on the training rows."""
    if key["kind"] == "numeric":
        edges = key["edges"] or []
        v = pd.to_numeric(x, errors="coerce").fillna(-np.inf).to_numpy(float)
        return np.clip(np.digitize(v, edges), 0, max(len(key["labels"]) - 1, 0))
    lut = {}
    for i, lev in enumerate(key["levels"]):
        for z in (lev or []):
            lut[str(z)] = i
    # An unseen level scores at the book mean: weight zero, which is the bin
    # whose weight is closest to zero rather than an arbitrary reference bin.
    fallback = int(np.argmin(np.abs(np.asarray(key["weights"], float))))
    return x.astype(str).map(lambda z: lut.get(z, fallback)).to_numpy(int)


def fractional_logit_fit(X: np.ndarray, y: np.ndarray,
                         max_iter: int = 60) -> tuple[np.ndarray, np.ndarray]:
    """Fractional logit with a ROBUST covariance.

    The estimator is a quasi-MLE: the Bernoulli likelihood is used for its score
    equations, not because the target is Bernoulli. The naive covariance from
    that likelihood assumes Var(y|x) = mu(1-mu), which is false for a proportion
    — realised severity has a mass at zero and another at one, and its variance
    is nothing like the binomial form. Standard errors from the naive Hessian are
    therefore wrong, usually too small, which is exactly the direction that makes
    a term look significant when it is not.

    The sandwich estimator makes no variance assumption:

        A = sum x x' mu(1-mu)          the expected Hessian, the bread
        B = sum x x' (y - mu)^2        the outer product of the scores, the meat
        V = A^-1 B A^-1

    Papke and Wooldridge specify it with the estimator; it is not optional here.
    """
    beta = fractional_logit(X, y, max_iter=max_iter)
    mu = np.clip(_sigmoid(X @ beta), 1e-9, 1 - 1e-9)
    w = mu * (1 - mu)
    A = (X * w[:, None]).T @ X
    r2 = (y - mu) ** 2
    B = (X * r2[:, None]).T @ X
    try:
        Ai = np.linalg.pinv(A)
    except np.linalg.LinAlgError:
        return beta, np.full((X.shape[1], X.shape[1]), np.nan)
    return beta, Ai @ B @ Ai


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


def candidates(df: pd.DataFrame, portfolio: str,
               mev_panel: pd.DataFrame | None = None) -> dict[str, list[dict]]:
    """What an LGD model on this book is ALLOWED to see.

    Only columns present on defaulted rows with enough non-missing values to
    estimate anything, split into numeric and categorical. The macro block is
    listed separately because it is the part that makes downturn LGD respond,
    and a severity model without it is the single most common finding a
    validator writes up.
    """
    d = df.loc[df["default_flag"] == 1]
    if mev_panel is not None:
        # The macro block does not exist on the tape — it is joined at the default
        # month. Scanning columns without attaching it first hides exactly the
        # drivers that make downturn LGD respond.
        d = attach_macro(d.copy(), mev_panel)
    n = len(d)
    skip = {"default_flag", "lgd_realised", "account_id", "prepaid_flag",
            "matured_flag", "recovery_amount", "loss_amount", "exposure_at_default"}
    numeric, categorical = [], []
    for c in d.columns:
        if c in skip or c.startswith("_truth"):
            continue
        col = d[c]
        filled = float(col.notna().mean()) if n else 0.0
        if pd.api.types.is_numeric_dtype(col):
            if filled < 0.5 or col.nunique(dropna=True) < 3:
                continue
            numeric.append({"column": c, "filled": filled, "kind": "numeric",
                            "macro": c in LGD_MACRO})
        elif col.dtype == object or str(col.dtype) == "category":
            k = int(col.nunique(dropna=True))
            if not 2 <= k <= 12:                # a 144-level metro is not an LGD driver
                continue
            categorical.append({"column": c, "filled": filled, "kind": "categorical",
                                "levels": k, "macro": False})
    return {"numeric": sorted(numeric, key=lambda r: r["column"]),
            "categorical": sorted(categorical, key=lambda r: r["column"]),
            "n_defaults": n}


def attach_macro(d: pd.DataFrame, mev_panel: pd.DataFrame,
                 extra: tuple[str, ...] = ()) -> pd.DataFrame:
    """Macro AT DEFAULT, joined on the default month.

    Not the macro as of today, and not the macro at origination. A severity is
    realised in the conditions of the month the loan failed in, which is the
    mechanism by which downturn LGD exists.

    `extra` carries transformed candidates from the macro search, named
    `key@transform@lag`. They are built through the same `apply_mev_transform`
    the PD model and the scenario projection use, so a term selected there means
    the same quantity here.
    """
    idx = pd.DatetimeIndex(d["performance_date"]).to_period("M").to_timestamp()
    for c in LGD_MACRO:
        if c in mev_panel.columns:
            d[c] = mev_panel[c].reindex(idx).to_numpy()
    if extra:
        from ..analysis.mev_search import Candidate
        from .design import apply_mev_transform
        for col in extra:
            cand = Candidate.parse(col)
            if cand is None or cand.key not in mev_panel.columns:
                continue
            s = apply_mev_transform(mev_panel[cand.key], cand.transform)
            if cand.lag_months:
                s = s.shift(cand.lag_months)
            d[col] = s.reindex(idx).to_numpy()
    return d


def fit_lgd(df: pd.DataFrame, spec: LgdSpec | str,
            mev_panel: pd.DataFrame) -> LgdModel:
    """Fit on the DEFAULTED account-months only — the only rows where a realised
    severity exists."""
    if isinstance(spec, str):                      # legacy call site: portfolio key
        spec = LgdSpec.default_for(spec)
    portfolio = spec.portfolio
    d = df.loc[df["default_flag"] == 1].copy()
    if len(d) < 60:
        raise ValueError(f"{portfolio}: only {len(d)} defaults — too few to fit LGD")

    d = attach_macro(d, mev_panel, tuple(c for c in spec.drivers if "@" in c))
    dropped = [c for c in (*spec.drivers, *spec.categoricals) if c not in d.columns]

    y = d["lgd_realised"].to_numpy(float).clip(0, 1)
    X, names, lv, means, stds, maps = _matrix(d, spec)

    pos = y > 1e-9
    beta, cov = fractional_logit_fit(X, np.clip(y, 1e-6, 1 - 1e-6))
    note = f"Not present on this tape, so excluded: {', '.join(dropped)}." \
        if dropped else ""

    model = LgdModel(
        portfolio=portfolio, spec=spec, columns=names, beta=beta,
        means=means, stds=stds, levels=lv, maps=maps,
        n_defaults=int(len(d)), mean_lgd=float(y.mean()),
        zero_loss_share=float((y <= 1e-9).mean()),
        mean_severity_given_loss=float(y[pos].mean()) if pos.any() else float("nan"),
        mean_workout_months=float(d["workout_months"].replace(0, np.nan).mean())
        if "workout_months" in d.columns else 12.0,
        fit_note=note, dropped=dropped,
    )
    # Reported per standard deviation of the driver, because the design matrix is
    # standardised. A positive coefficient raises predicted severity. Standard
    # errors are robust — see `fractional_logit_fit`.
    se = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    from scipy import stats as _st
    model.covariance = cov
    model.coefficients = [
        {"column": c, "coefficient": float(beta[i]),
         "std_error": float(se[i]) if np.isfinite(se[i]) else None,
         "z": float(beta[i] / se[i]) if se[i] > 1e-12 else None,
         "p_value": float(2 * _st.norm.sf(abs(beta[i] / se[i])))
         if se[i] > 1e-12 else None}
        for i, c in enumerate(names)]
    edges = np.linspace(0.0, 1.0, 21)
    counts, _ = np.histogram(y[y > 1e-9], bins=edges)
    model.severity_histogram = (
        [{"lo": 0.0, "hi": 0.0, "n": int((y <= 1e-9).sum()), "zero": True}]
        + [{"lo": float(edges[i]), "hi": float(edges[i + 1]), "n": int(counts[i]),
            "zero": False} for i in range(len(counts))]
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
    X, _, _, _, _, _ = _matrix(df, model.spec, levels=model.levels,
                               means=model.means, stds=model.stds, maps=model.maps)
    return X
