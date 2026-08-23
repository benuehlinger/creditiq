"""Fit diagnostics and backtesting statistics.

Everything here is computed, never approximated, except where a docstring says
otherwise. The backtesting section is the one that matters: a single AUC on a
random split says almost nothing about whether a credit model will survive. What
matters is how it behaves across PERFORMANCE DATES, which is the axis a portfolio
actually moves along.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats

from ..analysis.rates import annualize


# ── discrimination ───────────────────────────────────────────────────────────
def auc(y: np.ndarray, p: np.ndarray) -> float:
    """Area under the ROC curve, via the rank (Mann-Whitney) identity.

    Ranking is O(n log n) against O(n^2) for the pairwise definition, which
    matters because this runs for every backtest cohort over the whole panel.

    `scipy.stats.rankdata` does the ranking. A hand-written numpy version was
    tried on the assumption that scipy's per-call overhead mattered, and it was
    three times SLOWER — averaging ties needs a pass over runs of equal values,
    and that pass is C in scipy and a Python loop by hand. Ties must be averaged:
    breaking them arbitrarily would credit the model for an ordering it never
    produced.
    """
    y = np.asarray(y).astype(bool)
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    r = stats.rankdata(p)
    return float((r[y].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def gini(y: np.ndarray, p: np.ndarray) -> float:
    return 2.0 * auc(y, p) - 1.0


def auc_and_ks(y: np.ndarray, p: np.ndarray) -> tuple[float, float, float]:
    """AUC, KS and the KS score from ONE sort.

    The backtest computes both statistics for every cohort. Calling `auc` and
    `ks` separately sorts the same array twice, and sorting was the single
    largest line in the refit profile.
    """
    y = np.asarray(y).astype(bool)
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan"), float("nan"), float("nan")
    p = np.asarray(p, dtype=float)
    order = np.argsort(p, kind="stable")
    ys, ps = y[order], p[order]
    cum_bad = np.cumsum(ys) / n1
    cum_good = np.cumsum(~ys) / n0
    d = np.abs(cum_bad - cum_good)
    i = int(np.argmax(d))
    # Mann-Whitney from the same ordering, with ties averaged.
    ranks = np.empty(len(ps), dtype=np.float64)
    ranks[order] = stats.rankdata(ps)
    a = float((ranks[y].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))
    return a, float(d[i]), float(ps[i])


def ks(y: np.ndarray, p: np.ndarray) -> tuple[float, float]:
    """Kolmogorov-Smirnov separation and the score at which it occurs."""
    y = np.asarray(y).astype(bool)
    if y.sum() == 0 or (~y).sum() == 0:
        return float("nan"), float("nan")
    order = np.argsort(p)
    ys, ps = y[order], np.asarray(p)[order]
    cum_bad = np.cumsum(ys) / max(ys.sum(), 1)
    cum_good = np.cumsum(~ys) / max((~ys).sum(), 1)
    d = np.abs(cum_bad - cum_good)
    i = int(np.argmax(d))
    return float(d[i]), float(ps[i])


def roc_curve(y: np.ndarray, p: np.ndarray, points: int = 120) -> list[dict]:
    y = np.asarray(y).astype(bool)
    order = np.argsort(-np.asarray(p))
    ys = y[order]
    tp = np.cumsum(ys) / max(ys.sum(), 1)
    fp = np.cumsum(~ys) / max((~ys).sum(), 1)
    idx = np.unique(np.linspace(0, len(ys) - 1, points).astype(int))
    return [{"fpr": 0.0, "tpr": 0.0}] + [
        {"fpr": float(fp[i]), "tpr": float(tp[i])} for i in idx]


def ks_curve(y: np.ndarray, p: np.ndarray, points: int = 120) -> list[dict]:
    y = np.asarray(y).astype(bool)
    order = np.argsort(np.asarray(p))
    ys, ps = y[order], np.asarray(p)[order]
    cb = np.cumsum(ys) / max(ys.sum(), 1)
    cg = np.cumsum(~ys) / max((~ys).sum(), 1)
    idx = np.unique(np.linspace(0, len(ys) - 1, points).astype(int))
    return [{"score": float(ps[i]), "cum_bad": float(cb[i]),
             "cum_good": float(cg[i]), "sep": float(abs(cb[i] - cg[i]))} for i in idx]


# ── calibration ──────────────────────────────────────────────────────────────
def calibration(y: np.ndarray, p: np.ndarray, bins: int = 10) -> dict:
    """Predicted against observed, by decile of predicted probability, plus the
    Hosmer-Lemeshow statistic.

    Hosmer-Lemeshow has a well-known weakness that is worth stating rather than
    hiding: on a very large sample it rejects almost any model, because the
    statistic scales with n. On 1.7M account-months it will essentially always be
    significant. The DECILE TABLE is the thing to read; the p-value is reported
    for completeness with that caveat attached.
    """
    y = np.asarray(y).astype(float)
    p = np.asarray(p, dtype=float)
    q = np.unique(np.quantile(p, np.linspace(0, 1, bins + 1)))
    if len(q) < 3:
        return {"bins": [], "hl_statistic": float("nan"), "hl_p_value": float("nan"),
                "hl_note": "too few distinct predicted values to bin"}
    idx = np.clip(np.digitize(p, q[1:-1]), 0, len(q) - 2)
    rows, hl = [], 0.0
    for b in range(len(q) - 1):
        m = idx == b
        n = int(m.sum())
        if n == 0:
            continue
        obs = float(y[m].sum())
        exp = float(p[m].sum())
        pred = float(p[m].mean())
        act = obs / n
        if 0 < exp < n:
            hl += (obs - exp) ** 2 / (exp * (1 - exp / n))
        rows.append({"bin": b + 1, "n": n, "predicted": pred, "observed": act,
                     "predicted_annual": float(annualize(pred)),
                     "observed_annual": float(annualize(act)),
                     "events": int(obs)})
    dof = max(len(rows) - 2, 1)
    return {
        "bins": rows, "hl_statistic": float(hl),
        "hl_p_value": float(1.0 - stats.chi2.cdf(hl, dof)), "hl_dof": dof,
        "hl_note": ("Hosmer-Lemeshow scales with sample size and will reject almost "
                    "any model on a panel this large. Read the decile table; the "
                    "p-value is reported for completeness."),
    }


def brier(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def log_loss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(np.asarray(p, dtype=float), 1e-12, 1 - 1e-12)
    y = np.asarray(y, dtype=float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


# ── lift and gains ───────────────────────────────────────────────────────────
def gains_table(y: np.ndarray, p: np.ndarray, groups: int = 10) -> list[dict]:
    y = np.asarray(y).astype(float)
    order = np.argsort(-np.asarray(p))
    ys, ps = y[order], np.asarray(p)[order]
    n = len(ys)
    total_events = ys.sum() or 1.0
    cuts = np.linspace(0, n, groups + 1).astype(int)
    out, cum = [], 0.0
    for g in range(groups):
        sl = slice(cuts[g], cuts[g + 1])
        cnt = cuts[g + 1] - cuts[g]
        if cnt == 0:
            continue
        ev = float(ys[sl].sum())
        cum += ev
        out.append({
            "decile": g + 1, "n": int(cnt), "events": int(ev),
            "event_rate": ev / cnt, "event_rate_annual": float(annualize(ev / cnt)),
            "mean_predicted": float(ps[sl].mean()),
            "capture_pct": ev / total_events * 100.0,
            "cumulative_capture_pct": cum / total_events * 100.0,
            "lift": (ev / cnt) / (total_events / n) if cnt else float("nan"),
        })
    return out


# ── scorecard ────────────────────────────────────────────────────────────────
@dataclass
class Scorecard:
    base_score: int
    base_odds: float
    pdo: int
    factor: float
    offset: float
    points: list[dict]

    def score(self, p: np.ndarray) -> np.ndarray:
        odds = np.clip(p, 1e-9, 1 - 1e-9)
        ln_odds = np.log((1 - odds) / odds)          # odds of GOOD, the convention
        return self.offset + self.factor * ln_odds


def scorecard(base_score: int = 600, base_odds: float = 50.0, pdo: int = 20,
              woe_maps: dict | None = None, beta: dict | None = None) -> Scorecard:
    """The points transformation.

    Points double the odds of being good every `pdo` points, anchored so that
    `base_score` corresponds to `base_odds` to one. This is the expected artifact
    and it is a pure monotone transformation of the probability — it adds no
    information, it makes the model legible to people who do not read log-odds.
    """
    factor = pdo / np.log(2.0)
    offset = base_score - factor * np.log(base_odds)
    points: list[dict] = []
    if woe_maps and beta:
        n_vars = max(len(woe_maps), 1)
        for col, m in woe_maps.items():
            b = beta.get(f"{col}_woe", 0.0)
            labels = m.get("labels") or list((m.get("map") or {}).keys())
            woes = m.get("woe") or list((m.get("map") or {}).values())
            for lab, w in zip(labels, woes):
                points.append({
                    "variable": col, "bin": str(lab), "woe": float(w),
                    # each bin's contribution, with the intercept spread evenly
                    "points": round(-(b * float(w)) * factor + offset / n_vars),
                })
    return Scorecard(base_score, base_odds, pdo, factor, offset, points)


# ── stability ────────────────────────────────────────────────────────────────
def psi_scores(expected: np.ndarray, actual: np.ndarray, bins: int = 10) -> float:
    """Score-distribution PSI. Population drift in the model's OUTPUT, which is
    what a monitoring pack reports."""
    e, a = np.asarray(expected, float), np.asarray(actual, float)
    if len(e) < 50 or len(a) < 50:
        return float("nan")
    edges = np.unique(np.quantile(e, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        return 0.0
    edges[0], edges[-1] = -np.inf, np.inf
    pe = np.histogram(e, edges)[0] / len(e)
    pa = np.histogram(a, edges)[0] / len(a)
    pe = np.where(pe == 0, 0.5 / len(e), pe)
    pa = np.where(pa == 0, 0.5 / len(a), pa)
    return float(np.sum((pa - pe) * np.log(pa / pe)))


def jeffreys_interval(events: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Jeffreys credible interval for a default rate.

    Used instead of the normal approximation because a rating grade in a single
    quarter can have a handful of defaults, or none, and the normal interval is
    either nonsense or exactly zero width there. Jeffreys stays sensible at the
    boundary, which is where calibration testing actually lives.
    """
    if n <= 0:
        return float("nan"), float("nan")
    a, b = events + 0.5, n - events + 0.5
    lo = 0.0 if events == 0 else float(stats.beta.ppf(alpha / 2, a, b))
    hi = 1.0 if events == n else float(stats.beta.ppf(1 - alpha / 2, a, b))
    return lo, hi
