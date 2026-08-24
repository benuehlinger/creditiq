"""The empirical relationship between a variable and the target, at fine resolution.

The buckets are descriptive. The candidate curves drawn through them are NOT: they
are fitted with the estimator the model uses, on the rows the model uses, using
the same spline basis. An earlier version fitted them by weighted least squares on
the twelve bucket means with a raw hinge basis, which is a different estimator on
different data with a different loss function, and reported an R-squared that read
like a model statistic and was not one.

The optimal binning produces six to eight bins, which is the resolution required
for a weight-of-evidence table. Two questions need more resolution than that:

  * Is the relationship linear in the log-odds? If it is, a continuous term of
    one column represents it and the additional bin indicators add nothing.
  * Where does the relationship change slope? Six to eight bins are too coarse to
    locate a knot.

This module estimates neither. It cuts the variable into as many quantile buckets
as the event count supports, reports the log-odds of each with an interval, and
draws two reference curves through them: a straight line and a piecewise-linear
spline at the candidate knots. The comparison is left to the reader.

The log-odds scale is used rather than the rate scale because a logistic
regression is linear in the log-odds. A relationship that is linear on that scale
is the one a continuous term represents exactly; the same relationship plotted as
a rate is curved.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import chi2

from .spline import spline_basis

# Haldane-Anscombe. Adding a half to each cell keeps an empty bin finite and
# biases toward the null rather than producing a log-odds of minus infinity that
# then drives the axis.
HA = 0.5

# Below this many events the log-odds of a bucket is estimated too imprecisely to
# read, and the interval around it spans the plot.
MIN_EVENTS = 20


def _log_odds(events: np.ndarray, n: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    e = events + HA
    ne = (n - events) + HA
    return np.log(e / ne), np.sqrt(1.0 / e + 1.0 / ne)


def _merge_thin(edges: np.ndarray, idx: np.ndarray, y: np.ndarray) -> list[tuple]:
    """Left to right, absorbing bins until each carries enough events."""
    out: list[tuple] = []
    cur_lo = edges[0]
    n = ev = 0
    for k in range(len(edges) - 1):
        m = idx == k
        n += int(m.sum())
        ev += int(y[m].sum())
        if ev >= MIN_EVENTS or k == len(edges) - 2:
            out.append((float(cur_lo), float(edges[k + 1]), n, ev))
            cur_lo = edges[k + 1]
            n = ev = 0
    # A thin tail is folded back into its neighbour rather than shown as a spike.
    if len(out) > 1 and out[-1][3] < MIN_EVENTS:
        lo, _, n0, e0 = out[-2]
        _, hi, n1, e1 = out[-1]
        out[-2:] = [(lo, hi, n0 + n1, e0 + e1)]
    return out


def _log_likelihood(eta: np.ndarray, y: np.ndarray) -> float:
    """Bernoulli log-likelihood, computed stably at both tails."""
    e = np.clip(eta, -35.0, 35.0)
    return float(np.sum(y * e - np.logaddexp(0.0, e)))


def _fit_candidates(v: np.ndarray, y: np.ndarray, knots: list[float],
                    grid: np.ndarray) -> tuple[dict, dict | None]:
    """Fit the two candidate forms with the model's own estimator.

    Both are logistic regressions by the same Newton-Raphson routine the model
    fits with, on the same rows, with the same orthogonalised spline basis. The
    only difference from the model is that these are univariate.

    They are nested — the spline adds columns to the continuous term — so the
    comparison is a likelihood-ratio test rather than a comparison of two
    R-squareds. Goodness of fit is reported as McFadden's pseudo R-squared, which
    is what the model surface already reports.

    The test alone does not decide it. At 300,000 rows a change of 0.0003 in
    pseudo R-squared reaches p = 0.003, so on this data almost any extra column
    is "significant". The decision is therefore made on BIC, whose penalty grows
    with the sample size.

    BIC uses the EVENT COUNT rather than the row count. A logistic model's
    effective sample size is set by the rarer outcome: the commercial book has
    276,413 rows and 381 defaults, and penalising by log(276413) suppresses
    curvature that the 381 events genuinely support. This is the usual
    rare-event convention.
    """
    from ..models.fit import irls          # the model's estimator, not a copy

    n = len(v)
    ybar = float(y.mean())
    ll_null = n * (ybar * np.log(max(ybar, 1e-12))
                   + (1 - ybar) * np.log(max(1 - ybar, 1e-12)))

    n_events = max(int(y.sum()), 2)
    log_n = float(np.log(n_events))

    def fit(X: np.ndarray, Xg: np.ndarray) -> tuple[float, np.ndarray, int]:
        beta, _, _, _ = irls(X, y)
        return _log_likelihood(X @ beta, y), Xg @ beta, X.shape[1]

    # continuous: one standardised column, exactly the model's `continuous` treatment
    mu = float(v.mean())
    sd = float(v.std()) or 1.0
    ll_c, eta_c, k_c = fit(np.column_stack([np.ones(n), (v - mu) / sd]),
                           np.column_stack([np.ones(len(grid)), (grid - mu) / sd]))
    linear = {"pseudo_r2": 1.0 - ll_c / ll_null if ll_null else 0.0,
              "log_likelihood": ll_c, "n_params": k_c,
              "bic": -2.0 * ll_c + k_c * log_n,
              "n_rows": n, "n_events": n_events,
              "fitted": [float(z) for z in eta_c]}

    ks = [k for k in knots if v.min() < k < v.max()]
    if not ks:
        return linear, None
    B, _, meta = spline_basis(v, ks)
    if B.shape[1] <= 1:                      # every hinge was dead: nothing to add
        return linear, None
    Bg, _, _ = spline_basis(grid, ks, fitted=meta)
    ll_s, eta_s, k_s = fit(np.column_stack([np.ones(n), B]),
                           np.column_stack([np.ones(len(grid)), Bg]))

    df = max(k_s - k_c, 1)
    stat = max(2.0 * (ll_s - ll_c), 0.0)
    bic_s = -2.0 * ll_s + k_s * log_n
    spline = {"knots": [float(k) for k in meta["knots"]],
              "pseudo_r2": 1.0 - ll_s / ll_null if ll_null else 0.0,
              "log_likelihood": ll_s, "n_params": k_s,
              "bic": bic_s, "delta_bic": bic_s - linear["bic"],
              "lr_statistic": stat, "lr_df": int(df),
              "lr_p": float(chi2.sf(stat, df)),
              "fitted": [float(z) for z in eta_s]}
    return linear, spline


def numeric_curve(x: pd.Series, y: pd.Series, knots: list[float] | None = None,
                  resolution: int = 30) -> dict:
    v = pd.to_numeric(x, errors="coerce")
    ok = v.notna().to_numpy()
    yy = y.to_numpy(float)
    missing_rate = float(1.0 - ok.mean())
    vv, yv = v.to_numpy(float)[ok], yy[ok]
    if len(vv) < 200 or yv.sum() < MIN_EVENTS:
        return {"kind": "numeric", "points": [], "missing_rate": missing_rate,
                "note": "Too few events to draw an empirical curve."}

    # p1-p99 for the drawing domain. One planted impossible value would otherwise
    # compress every real observation into the left two pixels.
    lo, hi = float(np.nanpercentile(vv, 1)), float(np.nanpercentile(vv, 99))
    if hi <= lo:
        lo, hi = float(vv.min()), float(vv.max() or lo + 1)
    clipped = np.clip(vv, lo, hi)

    qs = np.unique(np.quantile(clipped, np.linspace(0, 1, resolution + 1)))
    if len(qs) < 4:
        qs = np.linspace(lo, hi, 5)
    idx = np.clip(np.digitize(clipped, qs[1:-1]), 0, len(qs) - 2)
    cells = _merge_thin(qs, idx, yv)

    mid = np.array([(a + b) / 2 for a, b, _, _ in cells])
    n = np.array([c[2] for c in cells], dtype=float)
    ev = np.array([c[3] for c in cells], dtype=float)
    lodds, se = _log_odds(ev, n)

    # The candidate curves are fitted on the ROWS, not on the bucket means.
    grid = np.linspace(lo, hi, 120)
    linear, spline = _fit_candidates(clipped, yv, list(knots or []), grid)

    sm = pd.Series(lodds).rolling(3, center=True, min_periods=1).mean().to_numpy()
    reversals = _turning_points(sm, max(2.0 * float(np.median(se)), 0.15))

    return {
        "kind": "numeric",
        "domain": [lo, hi],
        "missing_rate": missing_rate,
        "n": int(n.sum()), "n_events": int(ev.sum()),
        "base_log_odds": float(np.log((ev.sum() + HA) / (n.sum() - ev.sum() + HA))),
        "points": [
            {"x": float(m), "lo": float(a), "hi": float(b), "n": int(c),
             "events": int(e), "rate": float(e / c), "log_odds": float(l),
             "lo95": float(l - 1.96 * s), "hi95": float(l + 1.96 * s)}
            for (a, b, c, e), m, l, s in zip(cells, mid, lodds, se)
        ],
        "grid": [float(z) for z in grid],
        "linear": linear,
        "spline": spline,
        "reversals": reversals,
        "recommendation": _recommend(linear, spline, reversals),
        "resolution": len(cells),
    }


def _turning_points(v: np.ndarray, threshold: float) -> int:
    """How many times the relationship GENUINELY changes direction.

    Counting sign changes in the differences does not work. On thirty bins of
    real data it reports eight reversals for FICO, which is straight enough that
    a line explains 97% of it — every one of those was a bin wobbling inside its
    own confidence interval, and a flag that fires on everything decides nothing.

    So this is a zigzag filter. It tracks the running extreme and only records a
    turn once the move against it clears a threshold set by the estimation error
    itself. A wobble smaller than the interval around the points is not a shape.
    """
    start = ext = float(v[0])
    direction = turns = 0
    for z in v[1:]:
        z = float(z)
        # Test against the running extreme BEFORE moving it. Extending the
        # extreme first makes the move-against-it identically zero, so no turn
        # can ever fire and every variable reads as perfectly monotone.
        if direction >= 0 and ext - z > threshold:
            turns += 1 if direction > 0 else 0
            direction, ext = -1, z
        elif direction <= 0 and z - ext > threshold:
            turns += 1 if direction < 0 else 0
            direction, ext = 1, z
        elif direction >= 0 and z > ext:
            ext = z
            # The OPENING leg has to establish a direction too, or a smooth rise
            # followed by a fall counts as no turn at all: the extreme tracks the
            # rise, nothing exceeds it, and the peak of a single hump is never recorded.
            # It has to clear the threshold first, so one noisy tick at the start
            # does not commit the whole series to a direction.
            if direction == 0 and z - start > threshold:
                direction = 1
        elif direction <= 0 and z < ext:
            ext = z
            if direction == 0 and start - z > threshold:
                direction = -1
    return turns


def _recommend(linear: dict, spline: dict | None, reversals: int) -> dict:
    """Which treatment the evidence supports, and the criterion it rests on.

    The two forms are nested, so a spline always fits at least as well as the
    line it contains and a higher pseudo R-squared on its own establishes
    nothing. The decision is made on BIC — see `_fit_candidates` for why the
    penalty uses the event count — and the likelihood-ratio test is reported
    beside it.
    """
    r2 = linear["pseudo_r2"]
    if spline is None:
        return {"treatment": "continuous", "reason": (
            f"No usable knot lies inside the range of this variable, so only a "
            f"linear term can be tested. It reaches a pseudo R-squared of "
            f"{r2:.3f}.")}

    d = spline["delta_bic"]
    df = spline["lr_df"]
    cols = f"{df} spline column{'' if df == 1 else 's'}"
    if d >= 0:
        return {"treatment": "continuous", "reason": (
            f"The {cols} at the current knots raise pseudo R-squared from "
            f"{r2:.3f} to {spline['pseudo_r2']:.3f}, which does not pay for the "
            f"degrees of freedom: BIC is {d:+.0f} against the linear term. A "
            f"continuous term uses one column."
            + (f" The likelihood-ratio test reaches p = {spline['lr_p']:.1e}, "
               f"which at {linear['n_events']:,} events is not on its own a "
               f"reason to add them." if spline["lr_p"] < 0.01 else ""))}
    if reversals >= 2:
        return {"treatment": "bins", "reason": (
            f"The relationship changes direction {reversals} times by more than "
            f"the uncertainty around the buckets. The spline is supported here "
            f"(BIC {d:+.0f}) but is constrained to bend without reversing; bin "
            f"indicators impose no shape at all.")}
    return {"treatment": "spline", "reason": (
        f"The {cols} at the current knots are supported: BIC improves by "
        f"{-d:.0f} and pseudo R-squared rises from {r2:.3f} to "
        f"{spline['pseudo_r2']:.3f} (chi-squared {spline['lr_statistic']:.1f} on "
        f"{df} df). Weight of evidence is the one-column alternative if the "
        f"column count matters more than the shape.")}


def categorical_curve(x: pd.Series, y: pd.Series, max_levels: int = 25) -> dict:
    """Levels ordered by log-odds, with the volume beside them.

    Ordering by risk rather than alphabetically is the whole point: it turns
    "which of these 40 categories matter" into a shape you can read in one pass,
    and it is what makes a sensible grouping obvious.
    """
    yy = y.to_numpy(float)
    s = x.astype(str).where(x.notna(), "Missing")
    g = pd.DataFrame({"lvl": s, "y": yy}).groupby("lvl")["y"].agg(["size", "sum"])
    g = g.sort_values("size", ascending=False)
    shown, tail = g.iloc[:max_levels], g.iloc[max_levels:]
    rows = [(str(k), int(r["size"]), int(r["sum"])) for k, r in shown.iterrows()]
    if len(tail):
        rows.append((f"Other ({len(tail)} levels)", int(tail["size"].sum()),
                     int(tail["sum"].sum())))
    n = np.array([r[1] for r in rows], float)
    ev = np.array([r[2] for r in rows], float)
    lodds, se = _log_odds(ev, n)
    order = np.argsort(lodds)
    return {
        "kind": "categorical",
        "missing_rate": float((x.isna()).mean()),
        "n": int(n.sum()), "n_events": int(ev.sum()),
        "base_log_odds": float(np.log((ev.sum() + HA) / (n.sum() - ev.sum() + HA))),
        "points": [
            {"level": rows[i][0], "n": int(n[i]), "events": int(ev[i]),
             "rate": float(ev[i] / n[i]), "log_odds": float(lodds[i]),
             "lo95": float(lodds[i] - 1.96 * se[i]),
             "hi95": float(lodds[i] + 1.96 * se[i]),
             "thin": bool(ev[i] < MIN_EVENTS)}
            for i in order
        ],
        "n_levels": int(len(g)),
        "recommendation": {"treatment": "woe", "reason": (
            f"{len(g)} levels. Weight of evidence encodes them in one column, and "
            f"empirical-Bayes shrinkage reduces the influence of levels with few "
            f"observations.")},
    }


# ── continuous target: realised loss given default ──────────────────────────
#
# The PD curves above work on the log-odds of a binary outcome. Realised
# severity is a proportion in [0, 1] observed once per default, so the bucket
# statistic is a MEAN rather than a rate and its standard error comes from the
# within-bucket spread rather than from a binomial variance.
#
# The reference scale is still the logit, because the fractional logit is linear
# in logit(E[y]). A straight line on this scale is what the fitted model assumes.

# Severity buckets are sized by observation count, not event count: on the
# commercial book there are 381 defaults in total, so 30 per bucket is already
# a coarse cut.
MIN_ROWS = 30


def severity_curve(x: pd.Series, y: pd.Series, resolution: int = 12,
                   knots: list[float] | None = None) -> dict:
    """Mean realised severity across the range of a driver, with volume."""
    v = pd.to_numeric(x, errors="coerce")
    ok = v.notna().to_numpy() & y.notna().to_numpy()
    missing_rate = float(1.0 - v.notna().mean())
    vv = v.to_numpy(float)[ok]
    yy = np.clip(y.to_numpy(float)[ok], 0.0, 1.0)
    if len(vv) < 2 * MIN_ROWS:
        return {"kind": "numeric", "points": [], "missing_rate": missing_rate,
                "note": "Too few defaults to show a relationship."}

    lo, hi = float(np.nanpercentile(vv, 1)), float(np.nanpercentile(vv, 99))
    if hi <= lo:
        lo, hi = float(vv.min()), float(vv.max() or lo + 1)
    clipped = np.clip(vv, lo, hi)

    n_buckets = max(3, min(resolution, len(vv) // MIN_ROWS))
    qs = np.unique(np.quantile(clipped, np.linspace(0, 1, n_buckets + 1)))
    if len(qs) < 3:
        return {"kind": "numeric", "points": [], "missing_rate": missing_rate,
                "note": "This driver takes too few distinct values to bucket."}
    idx = np.clip(np.digitize(clipped, qs[1:-1]), 0, len(qs) - 2)

    pts = []
    for b in range(len(qs) - 1):
        mask = idx == b
        n = int(mask.sum())
        if n < 5:
            continue
        vals = yy[mask]
        mean = float(vals.mean())
        se = float(vals.std(ddof=1) / np.sqrt(n)) if n > 1 else 0.0
        pts.append({
            "x": float((qs[b] + qs[b + 1]) / 2), "lo": float(qs[b]), "hi": float(qs[b + 1]),
            "n": n, "mean_lgd": mean, "se": se,
            "lo95": float(max(0.0, mean - 1.96 * se)),
            "hi95": float(min(1.0, mean + 1.96 * se)),
            "zero_share": float((vals <= 1e-9).mean()),
        })
    if len(pts) < 3:
        return {"kind": "numeric", "points": [], "missing_rate": missing_rate,
                "note": "Too few defaults to show a relationship."}

    # The reference curve is fitted with the LGD model's own estimator, on the
    # same defaulted rows, so it is the curve that model would fit for this
    # driver rather than a least-squares line through the bucket means.
    from ..models.lgd import fractional_logit

    mu = float(clipped.mean())
    sd = float(clipped.std()) or 1.0
    Xr = np.column_stack([np.ones(len(clipped)), (clipped - mu) / sd])
    beta = fractional_logit(Xr, np.clip(yy, 1e-6, 1 - 1e-6))
    grid = np.linspace(lo, hi, 80)
    Xg = np.column_stack([np.ones(len(grid)), (grid - mu) / sd])
    fitted = 1.0 / (1.0 + np.exp(-np.clip(Xg @ beta, -35, 35)))
    lin, spl = severity_candidates(clipped, yy, list(knots or []), grid)
    # Deviance R-squared against an intercept-only fractional logit, which is the
    # quasi-likelihood analogue of the pseudo R-squared reported on the PD side.
    def _qll(eta):
        m = 1.0 / (1.0 + np.exp(-np.clip(eta, -35, 35)))
        m = np.clip(m, 1e-9, 1 - 1e-9)
        return float(np.sum(yy * np.log(m) + (1 - yy) * np.log(1 - m)))
    ybar = float(np.clip(yy.mean(), 1e-9, 1 - 1e-9))
    ll0 = _qll(np.full(len(yy), np.log(ybar / (1 - ybar))))
    r2 = 1.0 - _qll(Xr @ beta) / ll0 if ll0 else 0.0

    # Spearman on the underlying observations, which is the rank statistic the
    # candidate list is ordered by.
    rho = float(pd.Series(vv).corr(pd.Series(yy), method="spearman"))

    # The univariate view: how the driver itself is distributed among defaults.
    # A bucket mean cannot be read without knowing whether the driver has a spike
    # at a default value, a long tail, or almost no spread on this population.
    counts, edges = np.histogram(clipped, bins=min(24, max(6, len(vv) // 20)),
                                 range=(lo, hi))
    q = np.nanpercentile(vv, [1, 25, 50, 75, 99])
    return {
        "kind": "numeric",
        "domain": [lo, hi],
        "missing_rate": missing_rate,
        "n": int(len(vv)),
        "mean_lgd": float(yy.mean()),
        "points": pts,
        "grid": [float(z) for z in grid],
        "linear": {"coefficient": float(beta[1]), "intercept": float(beta[0]),
                   "pseudo_r2": r2, "fitted": [float(z) for z in fitted]},
        "spearman": rho if np.isfinite(rho) else 0.0,
        "spread": float(max(p["mean_lgd"] for p in pts) - min(p["mean_lgd"] for p in pts)),
        "resolution": len(pts),
        "grid": [float(z) for z in grid],
        "candidates": {"linear": lin, "spline": spl},
        "distribution": {
            "bins": [{"lo": float(edges[i]), "hi": float(edges[i + 1]), "n": int(counts[i])}
                     for i in range(len(counts))],
            "p1": float(q[0]), "p25": float(q[1]), "median": float(q[2]),
            "p75": float(q[3]), "p99": float(q[4]),
            "mean": float(np.mean(vv)), "sd": float(np.std(vv)),
            "distinct": int(pd.Series(vv).nunique()),
        },
    }


def severity_candidates(v: np.ndarray, y: np.ndarray, knots: list[float],
                       grid: np.ndarray) -> tuple[dict, dict | None]:
    """Fit the linear and spline forms with the LGD model's own estimator.

    Both are fractional logits by the same quasi-likelihood routine the severity
    model is fitted with, on the same defaulted rows, using the same
    orthogonalised spline basis the PD side uses. The curves drawn are the curves
    the model would fit for that term.

The SPLINE ITSELF needs no adjustment. A spline basis is a transformation of
    the covariate, not of the response: it changes X and leaves the link and the
    variance assumption alone, so `E[y|x] = sigmoid(B(x).beta)` is as valid here
    as in a binary logit. The same `spline_basis` the PD side uses is used here.

    What DOES change is everything built on the likelihood, because a quasi-
    likelihood is not one:

      SELECTION   BIC is derived from a genuine likelihood. Applied to a
                  quasi-log-likelihood unscaled it under-penalises extra columns
                  whenever the data are overdispersed — which severity is, badly,
                  because a distribution with mass at 0 and at 1 is far more
                  variable than mu(1-mu). It is divided by the estimated
                  dispersion here.

      TESTING     2 x the quasi-log-likelihood difference is NOT chi-squared, so
                  a likelihood-ratio test is not available. The spline block is
                  tested with a WALD statistic built from the sandwich
                  covariance, which is valid under quasi-likelihood.

    The PD side uses a real logistic likelihood, so it uses a real
    likelihood-ratio test and an unscaled BIC. The two are deliberately different.
    """
    from ..models.lgd import fractional_logit, fractional_logit_fit
    from .spline import spline_basis

    n = len(v)
    log_n = float(np.log(max(n, 2)))
    yc = np.clip(y, 1e-6, 1 - 1e-6)

    def qll(eta: np.ndarray, target: np.ndarray) -> float:
        m = np.clip(1.0 / (1.0 + np.exp(-np.clip(eta, -30, 30))), 1e-9, 1 - 1e-9)
        return float(np.sum(target * np.log(m) + (1 - target) * np.log(1 - m)))

    ybar = float(np.clip(y.mean(), 1e-9, 1 - 1e-9))
    ll0 = qll(np.full(n, np.log(ybar / (1 - ybar))), y)

    def dispersion(X: np.ndarray, b: np.ndarray) -> float:
        """Pearson chi-squared over the residual degrees of freedom.

        The scale parameter the quasi-likelihood leaves free. One means the
        binomial variance holds; severity runs well above it.
        """
        mu = np.clip(1.0 / (1.0 + np.exp(-np.clip(X @ b, -30, 30))), 1e-9, 1 - 1e-9)
        chi2_p = float(np.sum((y - mu) ** 2 / (mu * (1 - mu))))
        return max(chi2_p / max(n - X.shape[1], 1), 1e-9)

    def fit(X: np.ndarray, Xg: np.ndarray):
        b = fractional_logit(X, yc)
        return qll(X @ b, y), Xg @ b, X.shape[1], b

    mu = float(v.mean())
    sd = float(v.std()) or 1.0
    Xc = np.column_stack([np.ones(n), (v - mu) / sd])
    ll_c, eta_c, k_c, b_c = fit(Xc, np.column_stack([np.ones(len(grid)),
                                                     (grid - mu) / sd]))
    phi_c = dispersion(Xc, b_c)
    linear = {"deviance_r2": 1.0 - ll_c / ll0 if ll0 else 0.0,
              "log_likelihood": ll_c, "n_params": k_c,
              "dispersion": phi_c,
              "bic": -2.0 * ll_c / phi_c + k_c * log_n, "n": n,
              "fitted": [float(1 / (1 + np.exp(-np.clip(z, -30, 30)))) for z in eta_c]}

    ks = [k for k in knots if v.min() < k < v.max()]
    if not ks:
        return linear, None
    B, _, meta = spline_basis(v, ks)
    if B.shape[1] <= 1:
        return linear, None
    Bg, _, _ = spline_basis(grid, ks, fitted=meta)
    Xs = np.column_stack([np.ones(n), B])
    ll_s, eta_s, k_s, b_s = fit(Xs, np.column_stack([np.ones(len(grid)), Bg]))
    phi_s = dispersion(Xs, b_s)
    # BIC on the same dispersion for both models, so the comparison is like for
    # like. Taking each model's own phi would let the larger one buy a better
    # score by fitting the noise it is being penalised for.
    bic_c = -2.0 * ll_c / phi_s + k_c * log_n
    bic_s = -2.0 * ll_s / phi_s + k_s * log_n

    # Joint WALD test on the spline columns, with the sandwich covariance. The
    # quasi-likelihood-ratio statistic is not chi-squared, so it is not offered.
    _, cov = fractional_logit_fit(Xs, yc)
    j = list(range(2, k_s))                      # the hinge columns beyond value
    wald = wald_p = None
    if j:
        bj = b_s[j]
        Vj = cov[np.ix_(j, j)]
        try:
            wald = float(bj @ np.linalg.pinv(Vj) @ bj)
            wald_p = float(chi2.sf(max(wald, 0.0), len(j)))
        except np.linalg.LinAlgError:
            wald = wald_p = None

    return {**linear, "bic": bic_c, "dispersion": phi_s}, {
        "knots": [float(k) for k in meta["knots"]],
        "deviance_r2": 1.0 - ll_s / ll0 if ll0 else 0.0,
        "log_likelihood": ll_s, "n_params": k_s,
        "dispersion": phi_s,
        "bic": bic_s, "delta_bic": bic_s - bic_c,
        "wald": wald, "wald_df": len(j), "wald_p": wald_p,
        "fitted": [float(1 / (1 + np.exp(-np.clip(z, -30, 30)))) for z in eta_s],
    }


def auto_knots_severity(x: pd.Series, y: pd.Series, n_knots: int = 3,
                        resolution: int = 40) -> dict:
    """Place knots where they most improve the severity fit.

    The same greedy-plus-refinement search the PD side uses, scored on the
    fractional quasi-likelihood over grouped buckets. The buckets are coarser
    here because the population is: a few hundred defaults will not support a
    hundred-bucket grid.
    """
    from ..models.lgd import fractional_logit

    v = pd.to_numeric(x, errors="coerce")
    ok = v.notna().to_numpy() & y.notna().to_numpy()
    vv = v.to_numpy(float)[ok]
    yv = np.clip(y.to_numpy(float)[ok], 0.0, 1.0)
    if len(vv) < 80:
        return {"knots": [], "note": "Too few defaults to search for knot positions."}

    lo, hi = float(np.nanpercentile(vv, 1)), float(np.nanpercentile(vv, 99))
    if hi <= lo:
        return {"knots": [], "note": "This driver has no usable range."}
    clipped = np.clip(vv, lo, hi)

    edges = np.unique(np.quantile(clipped, np.linspace(0, 1, resolution + 1)))
    if len(edges) < 6:
        return {"knots": [], "note": "This driver takes too few distinct values."}
    idx = np.clip(np.digitize(clipped, edges[1:-1]), 0, len(edges) - 2)
    keep = np.bincount(idx, minlength=len(edges) - 1) > 0
    mid = ((edges[:-1] + edges[1:]) / 2.0)[keep]
    n = np.bincount(idx, minlength=len(edges) - 1).astype(float)[keep]
    mean = np.array([yv[idx == b].mean() for b in range(len(edges) - 1)
                     if (idx == b).any()])
    mean = np.clip(mean, 1e-6, 1 - 1e-6)

    span = hi - lo
    ones = np.ones_like(mid)

    def basis(ks: list[float]) -> np.ndarray:
        return np.column_stack([ones, mid, *[np.maximum(mid - k, 0.0) for k in ks]])

    def score(ks: list[float]) -> float:
        # weighted fractional logit on the bucket means, weighted by bucket size
        X = basis(ks)
        w = np.repeat(np.arange(len(mid)), n.astype(int))
        b = fractional_logit(X[w], mean[w])
        eta = np.clip(X @ b, -30, 30)
        m = np.clip(1 / (1 + np.exp(-eta)), 1e-9, 1 - 1e-9)
        return float(np.sum(n * (mean * np.log(m) + (1 - mean) * np.log(1 - m))))

    candidates = [float(q) for q in
                  np.unique(np.quantile(clipped, np.round(np.arange(0.1, 0.91, 0.05), 4)))
                  if lo < q < hi]
    far = lambda k, ch: all(abs(k - c) > 0.08 * span for c in ch)

    chosen: list[float] = []
    for _ in range(max(int(n_knots), 0)):
        best, best_ll = None, -np.inf
        for k in candidates:
            if not far(k, chosen):
                continue
            ll = score(sorted([*chosen, k]))
            if ll > best_ll:
                best, best_ll = k, ll
        if best is None:
            break
        chosen.append(best)
        chosen.sort()

    for _ in range(2):
        moved = False
        for i in range(len(chosen)):
            others = [c for j, c in enumerate(chosen) if j != i]
            cur = score(sorted(chosen))
            best, best_ll = chosen[i], cur
            for k in candidates:
                if not far(k, others):
                    continue
                ll = score(sorted([*others, k]))
                if ll > best_ll + 1e-9:
                    best, best_ll = k, ll
            if best != chosen[i]:
                chosen[i] = best
                chosen.sort()
                moved = True
        if not moved:
            break

    qs = np.linspace(0, 1, int(n_knots) + 2)[1:-1]
    quantile = [float(z) for z in np.unique(np.quantile(clipped, qs))
                if lo < z < hi] if n_knots else []
    return {
        "knots": [float(k) for k in sorted(chosen)],
        "quantile_knots": quantile,
        "n_defaults": int(len(vv)), "n_buckets": int(len(mid)),
        "gain_over_quantile": float(score(sorted(chosen)) - score(quantile))
        if chosen and quantile else 0.0,
        "note": "",
    }


def severity_by_level(x: pd.Series, y: pd.Series, max_levels: int = 20) -> dict:
    """Mean realised severity per level, ordered by severity, with volume."""
    yy = np.clip(y.to_numpy(float), 0.0, 1.0)
    s = x.astype(str).where(x.notna(), "Missing")
    frame = pd.DataFrame({"lvl": s, "y": yy})
    g = frame.groupby("lvl")["y"].agg(["size", "mean", "std"])
    g = g.sort_values("size", ascending=False).iloc[:max_levels]
    pts = []
    for lvl, r in g.iterrows():
        n = int(r["size"])
        se = float((r["std"] or 0.0) / np.sqrt(n)) if n > 1 else 0.0
        pts.append({"level": str(lvl), "n": n, "mean_lgd": float(r["mean"]), "se": se,
                    "lo95": float(max(0.0, r["mean"] - 1.96 * se)),
                    "hi95": float(min(1.0, r["mean"] + 1.96 * se)),
                    "thin": bool(n < MIN_ROWS)})
    pts.sort(key=lambda p: p["mean_lgd"])
    return {
        "kind": "categorical",
        "missing_rate": float(x.isna().mean()),
        "n": int(len(yy)), "mean_lgd": float(yy.mean()),
        "points": pts, "n_levels": int(frame["lvl"].nunique()),
        "distribution": {"distinct": int(frame["lvl"].nunique())},
        "spread": float(pts[-1]["mean_lgd"] - pts[0]["mean_lgd"]) if pts else 0.0,
    }


# ── automatic knot placement ─────────────────────────────────────────────────
#
# Quantile knots put a knot where the DATA is dense. That is a reasonable
# default and it ignores the response entirely: on a variable whose relationship
# bends once, at a point where the data happens to be thin, quantile placement
# will put four knots in the straight run and none at the bend.
#
# Placement by search puts a knot where the FIT improves. The procedure is the
# forward pass of MARS restricted to one variable: add the candidate knot that
# most improves the fit, repeat to the requested count, then sweep each knot once
# against its neighbours to correct for the order they were added in.
#
# The search scores on GROUPED data — the fine buckets, with their event and
# non-event counts — rather than on individual rows. A binomial likelihood on
# grouped counts is exact when the covariates are constant within a group and a
# close approximation when they vary as little as they do inside a fine quantile
# bucket. That makes a candidate evaluation microseconds instead of 200ms, so a
# search over 37 positions for 4 knots is instant rather than half a minute. The
# winner is then re-fitted on the full rows with the model's own estimator, and
# that is the number reported.

# Candidate positions: a quantile grid, kept away from the tails where a hinge
# has too few observations on one side to be estimated.
KNOT_GRID = np.round(np.arange(0.05, 0.951, 0.025), 4)
# Two knots closer than this share of the range are the same knot for practical
# purposes, and putting both in produces a near-singular basis.
MIN_SEPARATION = 0.04


def _grouped_logistic(B: np.ndarray, ev: np.ndarray, n: np.ndarray,
                      max_iter: int = 30) -> float:
    """Binomial IRLS on grouped counts. Returns the log-likelihood."""
    beta = np.zeros(B.shape[1])
    ne = n - ev
    for _ in range(max_iter):
        eta = np.clip(B @ beta, -30, 30)
        mu = 1.0 / (1.0 + np.exp(-eta))
        w = n * np.clip(mu * (1 - mu), 1e-9, None)
        z = eta + (ev - n * mu) / w
        A = (B * w[:, None]).T @ B
        A[np.diag_indices_from(A)] += 1e-9
        try:
            nb = np.linalg.solve(A, (B * w[:, None]).T @ z)
        except np.linalg.LinAlgError:
            return -np.inf
        if np.max(np.abs(nb - beta)) < 1e-9:
            beta = nb
            break
        beta = nb
    eta = np.clip(B @ beta, -30, 30)
    return float(np.sum(ev * eta - n * np.logaddexp(0.0, eta)))


def auto_knots(x: pd.Series, y: pd.Series, n_knots: int = 4,
               resolution: int = 120) -> dict:
    """Place `n_knots` knots where they most improve the fit.

    Returns the chosen positions, the quantile placement they are compared
    against, and the improvement in log-likelihood over a straight line — all on
    the grouped approximation. The Explore stage re-fits the winner on the full
    rows before reporting a pseudo R-squared or a BIC.
    """
    v = pd.to_numeric(x, errors="coerce")
    ok = v.notna().to_numpy()
    vv = v.to_numpy(float)[ok]
    yv = y.to_numpy(float)[ok]
    if len(vv) < 500 or yv.sum() < MIN_EVENTS:
        return {"knots": [], "note": "Too few events to search for knot positions."}

    lo, hi = float(np.nanpercentile(vv, 1)), float(np.nanpercentile(vv, 99))
    if hi <= lo:
        return {"knots": [], "note": "This variable has no usable range."}
    clipped = np.clip(vv, lo, hi)

    # Group into fine buckets once. Everything below reads these counts.
    edges = np.unique(np.quantile(clipped, np.linspace(0, 1, resolution + 1)))
    if len(edges) < 6:
        return {"knots": [], "note": "This variable takes too few distinct values."}
    idx = np.clip(np.digitize(clipped, edges[1:-1]), 0, len(edges) - 2)
    n = np.bincount(idx, minlength=len(edges) - 1).astype(float)
    ev = np.bincount(idx, weights=yv, minlength=len(edges) - 1).astype(float)
    keep = n > 0
    mid = ((edges[:-1] + edges[1:]) / 2.0)[keep]
    n, ev = n[keep], ev[keep]

    candidates = [float(q) for q in np.unique(np.quantile(clipped, KNOT_GRID))
                  if lo < q < hi]
    span = hi - lo
    ones = np.ones_like(mid)

    def basis(ks: list[float]) -> np.ndarray:
        return np.column_stack([ones, mid, *[np.maximum(mid - k, 0.0) for k in ks]])

    def far_enough(k: float, chosen: list[float]) -> bool:
        return all(abs(k - c) > MIN_SEPARATION * span for c in chosen)

    ll_line = _grouped_logistic(basis([]), ev, n)
    chosen: list[float] = []
    for _ in range(max(int(n_knots), 0)):
        best, best_ll = None, -np.inf
        for k in candidates:
            if not far_enough(k, chosen):
                continue
            ll = _grouped_logistic(basis(sorted([*chosen, k])), ev, n)
            if ll > best_ll:
                best, best_ll = k, ll
        if best is None:
            break
        chosen.append(best)
        chosen.sort()

    # One refinement sweep: the greedy pass commits each knot before it knows
    # where the later ones will go, so the first is often placed to cover a bend
    # that a subsequent knot handles better.
    for _ in range(2):
        moved = False
        for i in range(len(chosen)):
            others = [c for j, c in enumerate(chosen) if j != i]
            best, best_ll = chosen[i], _grouped_logistic(basis(sorted(chosen)), ev, n)
            for k in candidates:
                if not far_enough(k, others):
                    continue
                ll = _grouped_logistic(basis(sorted([*others, k])), ev, n)
                if ll > best_ll + 1e-9:
                    best, best_ll = k, ll
            if best != chosen[i]:
                chosen[i] = best
                chosen.sort()
                moved = True
        if not moved:
            break

    ll_best = _grouped_logistic(basis(sorted(chosen)), ev, n) if chosen else ll_line
    qs = np.linspace(0, 1, int(n_knots) + 2)[1:-1]
    quantile = [float(z) for z in np.unique(np.quantile(clipped, qs))
                if lo < z < hi] if n_knots else []
    ll_quantile = _grouped_logistic(basis(quantile), ev, n) if quantile else ll_line
    return {
        "knots": [float(k) for k in sorted(chosen)],
        "quantile_knots": quantile,
        "n_buckets": int(len(mid)),
        "n_candidates": len(candidates),
        # Improvement in log-likelihood over a straight line, on the grouped
        # approximation. Reported so the search can be judged rather than trusted.
        "gain_over_line": float(ll_best - ll_line),
        "gain_over_quantile": float(ll_best - ll_quantile),
        "note": "",
    }
