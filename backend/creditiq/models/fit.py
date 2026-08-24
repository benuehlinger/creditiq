"""PD estimation — discrete-time hazard on account-months.

The frame is the point. Each row is one account-month at risk, and the model
estimates the conditional probability that the account defaults in THAT month
given it has survived to it. That is what a lifetime ECL projection needs; a
model fitted on "did this account ever default" cannot produce a term structure.

The estimator is Newton-Raphson (iteratively reweighted least squares) written
out rather than delegated, for two reasons. It converges in six to eight
iterations on a book this size, which keeps the refit inside the two-second
budget. And the Hessian it forms on the way is exactly the information matrix, so
standard errors, z-statistics and p-values come out of the fit itself instead of
requiring a second pass.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy import stats

from .design import Design
from .spec import ModelSpec


@dataclass
class Coefficient:
    name: str
    estimate: float
    std_error: float
    z_stat: float
    p_value: float
    vif: float
    contribution: float          # share of the fitted linear predictor's variance


@dataclass
class FitResult:
    spec_hash: str
    coefficients: list[Coefficient]
    beta: np.ndarray
    columns: list[str]
    n_train: int
    n_events_train: int
    converged: bool
    iterations: int
    log_likelihood: float
    null_log_likelihood: float
    fit_seconds: float
    separation_warning: str | None = None
    woe_maps: dict = field(default_factory=dict)
    basis_maps: dict = field(default_factory=dict)
    means: np.ndarray | None = None
    stds: np.ndarray | None = None

    @property
    def mcfadden_r2(self) -> float:
        return float(1.0 - self.log_likelihood / self.null_log_likelihood)


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def irls(X: np.ndarray, y: np.ndarray, l2: float = 0.0, max_iter: int = 40,
         tol: float = 1e-8) -> tuple[np.ndarray, np.ndarray, int, bool]:
    """Newton-Raphson for logistic regression. Returns beta, covariance, iters, ok.

    The ridge term is applied to every coefficient EXCEPT the intercept —
    penalising the intercept shifts the fitted base rate, which would break
    calibration for no benefit.
    """
    # The design is stored as float32 to keep the build cheap; the normal
    # equations are accumulated in float64, where the conditioning matters.
    X = np.asarray(X, dtype=np.float64) if X.dtype != np.float64 else X
    n, k = X.shape
    beta = np.zeros(k)
    pen = np.full(k, l2, dtype=float)
    pen[0] = 0.0
    ll_prev = -np.inf
    cov = np.eye(k)
    for it in range(1, max_iter + 1):
        eta = X @ beta
        p = _sigmoid(eta)
        w = np.clip(p * (1.0 - p), 1e-10, None)
        grad = X.T @ (y - p) - pen * beta
        # X'WX, formed once per iteration; this is the dominant cost
        XtWX = (X * w[:, None]).T @ X
        XtWX[np.diag_indices_from(XtWX)] += pen + 1e-9
        try:
            step = np.linalg.solve(XtWX, grad)
        except np.linalg.LinAlgError:
            step = np.linalg.lstsq(XtWX, grad, rcond=None)[0]
        # step halving keeps a separated variable from throwing the fit to infinity
        for _ in range(12):
            cand = beta + step
            pc = _sigmoid(X @ cand)
            ll = float(np.sum(y * np.log(np.clip(pc, 1e-12, 1)) +
                              (1 - y) * np.log(np.clip(1 - pc, 1e-12, 1))))
            if np.isfinite(ll) and ll >= ll_prev - 1e-8:
                break
            step = step / 2.0
        beta = cand
        try:
            cov = np.linalg.inv(XtWX)
        except np.linalg.LinAlgError:
            cov = np.linalg.pinv(XtWX)
        if abs(ll - ll_prev) < tol * (abs(ll) + 1.0):
            return beta, cov, it, True
        ll_prev = ll
    return beta, cov, max_iter, False


def fit(design: Design, spec: ModelSpec) -> FitResult:
    t0 = time.perf_counter()
    X = np.asarray(design.X, dtype=np.float64)
    y = design.y.astype(float)
    l2 = 0.0
    if spec.estimator == "logistic_l2":
        l2 = max(spec.regularization, 1e-6) * len(y) / 1000.0
    if spec.estimator == "logistic_l1":
        beta, cov, iters, ok = _fit_l1(X, y, spec.regularization)
    else:
        beta, cov, iters, ok = irls(X, y, l2=l2)

    eta = X @ beta
    p = _sigmoid(eta)
    ll = float(np.sum(y * np.log(np.clip(p, 1e-12, 1)) +
                      (1 - y) * np.log(np.clip(1 - p, 1e-12, 1))))
    base = y.mean()
    ll0 = float(len(y) * (base * np.log(max(base, 1e-12)) +
                          (1 - base) * np.log(max(1 - base, 1e-12))))

    se = np.sqrt(np.clip(np.diag(cov), 0, None))
    with np.errstate(divide="ignore", invalid="ignore"):
        z = np.where(se > 0, beta / se, 0.0)
    pval = 2.0 * (1.0 - stats.norm.cdf(np.abs(z)))

    # VIF from the design's own correlation structure, excluding the intercept.
    #
    # A pseudo-inverse alone is insufficient and conceals the rank-deficient case. With
    # two exactly duplicated columns the correlation matrix is singular, `pinv`
    # returns a finite pseudo-inverse, and every VIF comes back as 1.00 — the
    # guardrail reporting perfect health on a rank-deficient design. So the
    # eigenspectrum is checked first: a near-zero eigenvalue means an exact linear
    # dependence, and the columns loading on it are the aliased set.
    vifs = np.ones(X.shape[1])
    aliased: list[str] = []
    if X.shape[1] > 2:
        C = np.nan_to_num(np.corrcoef(X[:, 1:], rowvar=False), nan=0.0)
        np.fill_diagonal(C, 1.0)
        try:
            vals, vecs = np.linalg.eigh(C)
            null = vals < 1e-8
            if null.any():
                # loadings on the null space identify the linearly dependent columns
                load = np.abs(vecs[:, null]).max(axis=1)
                for i in np.flatnonzero(load > 0.1):
                    vifs[i + 1] = np.inf
                    aliased.append(design.columns[i + 1])
            # NB: not named `ok` — that is the convergence flag from irls, and
            # shadowing it made `not ok` evaluate an array.
            finite = ~np.isinf(vifs[1:])
            if finite.any():
                diag = np.clip(np.diag(np.linalg.pinv(C)), 1.0, None)
                slot = vifs[1:]
                slot[finite] = diag[finite]
                vifs[1:] = slot
        except np.linalg.LinAlgError:
            pass

    # contribution: each term's share of the linear predictor's variance
    var = np.var(X * beta, axis=0)
    total = var[1:].sum() or 1.0
    contrib = np.concatenate([[0.0], var[1:] / total])

    warn = None
    if aliased:
        warn = ("The design is rank deficient: "
                + ", ".join(sorted(set(aliased))[:6])
                + (" and others" if len(set(aliased)) > 6 else "")
                + " are exact linear combinations of other terms. Their "
                  "coefficients are not identified — the fit splits the effect "
                  "between them arbitrarily. Remove one of the duplicated terms.")
    elif np.any(np.abs(beta[1:]) > 12) or not ok:
        warn = ("A coefficient is very large or the fit did not converge, which "
                "usually means one variable separates the target almost perfectly. "
                "Check the variable screen for leakage before reading these "
                "coefficients.")

    coefs = [
        Coefficient(name=design.columns[i], estimate=float(beta[i]),
                    std_error=float(se[i]), z_stat=float(z[i]),
                    p_value=float(pval[i]), vif=float(vifs[i]),
                    contribution=float(contrib[i]))
        for i in range(len(beta))
    ]
    return FitResult(
        spec_hash=spec.hash(), coefficients=coefs, beta=beta,
        columns=design.columns, n_train=len(y), n_events_train=int(y.sum()),
        converged=ok, iterations=iters, log_likelihood=ll, null_log_likelihood=ll0,
        fit_seconds=time.perf_counter() - t0, separation_warning=warn,
        woe_maps=design.woe_maps, means=design.means, stds=design.stds,
        basis_maps=design.basis_maps,
    )


def _fit_l1(X: np.ndarray, y: np.ndarray, C: float):
    """L1 through scikit-learn. Standard errors after an L1 fit are not
    well-defined — the penalty biases the estimates — so they are reported from
    the unpenalised information matrix at the L1 solution and the UI says so."""
    from sklearn.linear_model import LogisticRegression
    m = LogisticRegression(penalty="l1", solver="liblinear", C=max(C, 1e-4),
                           fit_intercept=False, max_iter=300)
    m.fit(X, y)
    beta = m.coef_.ravel()
    p = _sigmoid(X @ beta)
    w = np.clip(p * (1 - p), 1e-10, None)
    XtWX = (X * w[:, None]).T @ X
    XtWX[np.diag_indices_from(XtWX)] += 1e-9
    try:
        cov = np.linalg.inv(XtWX)
    except np.linalg.LinAlgError:
        cov = np.linalg.pinv(XtWX)
    return beta, cov, m.n_iter_[0] if hasattr(m, "n_iter_") else 0, True


def predict(X: np.ndarray, beta: np.ndarray) -> np.ndarray:
    return _sigmoid(X.astype(np.float64, copy=False) @ beta)


# ── collinearity for terms that emit more than one column ────────────────────
def generalised_vif(X: np.ndarray, groups: dict[str, list[int]]) -> list[dict]:
    """Fox-Monette generalised variance inflation, per TERM.

    The ordinary VIF is defined for one column. A treatment can emit one column
    or eight — a spline basis, a set of bin indicators — and "the variance
    inflation of interest_rate" is then not a single number in the usual sense.

    Fox and Monette (1992) give the generalisation:

        GVIF_j = det(R_jj) x det(R_-j-j) / det(R)

    where R is the correlation matrix of the design's non-intercept columns,
    R_jj is the block belonging to term j and R_-j-j the block belonging to
    everything else. It is the factor by which the joint confidence region for
    term j's coefficients is inflated by the rest of the design.

    GVIF grows with the number of columns, so it is not comparable across terms
    of different size. `GVIF^(1/2 df)` is, and is on the scale of a standard-
    error inflation factor; squaring it puts it back on the familiar VIF scale,
    where a one-column term returns exactly the ordinary VIF.

    This exists because the screening panel used to compute VIF on the RAW tape
    columns, ignoring the treatment entirely. Binned, splined and continuous
    forms of the same variable all reported the same number, and for a binned
    interest rate that number was 20.9 against a true worst-column value of 12.
    """
    if not groups:
        return []
    idx = sorted({i for cols in groups.values() for i in cols})
    if len(idx) < 2:
        return [{"term": t, "df": len(c), "gvif": 1.0, "vif": 1.0,
                 "inflation": 1.0, "aliased": False} for t, c in groups.items()]

    sub = np.asarray(X, dtype=np.float64)[:, idx]
    pos = {c: i for i, c in enumerate(idx)}
    R = np.nan_to_num(np.corrcoef(sub, rowvar=False), nan=0.0)
    np.fill_diagonal(R, 1.0)

    def logdet(M: np.ndarray) -> float:
        if M.size == 0:
            return 0.0
        sign, ld = np.linalg.slogdet(M)
        # A singular block means the term is an exact combination of the others.
        return ld if sign > 0 else -np.inf

    ld_full = logdet(R)
    out: list[dict] = []
    for term, cols in groups.items():
        j = [pos[c] for c in cols if c in pos]
        rest = [i for i in range(len(idx)) if i not in set(j)]
        if not j:
            continue
        ld_j = logdet(R[np.ix_(j, j)])
        ld_rest = logdet(R[np.ix_(rest, rest)]) if rest else 0.0
        if not np.isfinite(ld_full) or not np.isfinite(ld_j) or not np.isfinite(ld_rest):
            out.append({"term": term, "df": len(j), "gvif": float("inf"),
                        "vif": float("inf"), "inflation": float("inf"),
                        "aliased": True})
            continue
        gvif = float(np.exp(ld_j + ld_rest - ld_full))
        gvif = max(gvif, 1.0)
        inflation = gvif ** (1.0 / (2.0 * len(j)))       # standard-error factor
        out.append({"term": term, "df": len(j), "gvif": gvif,
                    # back on the ordinary VIF scale: identical for a 1-df term
                    "vif": float(inflation ** 2), "inflation": float(inflation),
                    "aliased": False})
    out.sort(key=lambda r: -r["vif"])
    return out
