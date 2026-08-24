"""Backtesting by performance date.

A single AUC on a random split is close to worthless for a credit model. The
question is never "does it separate" — it is "does it still separate, and is it
still calibrated, in a period it has never seen". So every statistic here is
computed per PERFORMANCE-DATE COHORT, which is the axis the portfolio actually
moves along.

The out-of-time boundary is marked on every chart. Finding a cohort or a segment
where the model underperforms, and saying so, is more persuasive than a clean
chart.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..analysis.rates import annualize
from . import metrics as M

# Cohorts are QUARTERS, not months. A monthly cohort on the mortgage book rests
# on about seven defaults, and an AUC or a calibration test on seven events
# reports noise. `min_n` below enforces the same thing from the other side.
#
# The name is published with the payload so the interface can LABEL its axis
# from the data rather than from a constant someone has to keep in step. An axis
# reading "Performance month" over quarterly cohorts is how this was noticed.
COHORT_FREQ = "QS"
COHORT_FREQ_LABEL = "quarter"
VINTAGE_FREQ = "YS"


def by_cohort(dates: np.ndarray, y: np.ndarray, p: np.ndarray,
              freq: str = COHORT_FREQ, min_n: int = 400) -> list[dict]:
    """Actual against predicted, plus discrimination, for each cohort."""
    df = pd.DataFrame({"d": pd.to_datetime(dates), "y": y, "p": p})
    out = []
    for period, g in df.groupby(pd.Grouper(key="d", freq=freq)):
        n = len(g)
        if n < min_n:
            continue
        ev = int(g["y"].sum())
        act, pred = ev / n, float(g["p"].mean())
        lo, hi = M.jeffreys_interval(ev, n)
        a_, ks_, _ = M.auc_and_ks(g["y"].to_numpy(), g["p"].to_numpy())
        out.append({
            "period": period.strftime("%Y-%m-%d"), "n": n, "events": ev,
            "actual": act, "predicted": pred,
            "actual_annual": float(annualize(act)),
            "predicted_annual": float(annualize(pred)),
            "actual_lo_annual": float(annualize(lo)),
            "actual_hi_annual": float(annualize(hi)),
            # a predicted rate outside the Jeffreys interval of the realised rate
            # is a calibration miss for that cohort, not sampling noise
            "calibrated": bool(lo <= pred <= hi),
            "auc": a_, "ks": ks_,
        })
    for r in out:
        r["gini"] = (2 * r["auc"] - 1) if r["auc"] == r["auc"] else float("nan")
    return out


def rank_order_stability(dates: np.ndarray, y: np.ndarray, p: np.ndarray,
                         deciles: int = 5, freq: str = COHORT_FREQ,
                         min_n: int = 800) -> dict:
    """Does the riskiest decile stay the riskiest, every single period?

    Scored globally so the bands mean the same thing in every cohort — scoring
    within each period would re-rank the book each quarter and hide exactly the
    failure this is looking for.
    """
    df = pd.DataFrame({"d": pd.to_datetime(dates), "y": y, "p": p})
    edges = np.quantile(p, np.linspace(0, 1, deciles + 1))
    df["band"] = np.clip(np.digitize(p, edges[1:-1]), 0, deciles - 1)
    rows, breaks = [], 0
    periods = 0
    for period, g in df.groupby(pd.Grouper(key="d", freq=freq)):
        if len(g) < min_n:
            continue
        periods += 1
        rates = g.groupby("band")["y"].mean().reindex(range(deciles))
        vals = rates.to_numpy(dtype=float)
        ok = np.all(np.diff(vals[~np.isnan(vals)]) >= -1e-12)
        if not ok:
            breaks += 1
        rows.append({"period": period.strftime("%Y-%m-%d"), "monotone": bool(ok),
                     "rates_annual": [None if np.isnan(v) else float(annualize(v))
                                      for v in vals]})
    return {"deciles": deciles, "periods": periods, "breaks": breaks,
            "share_monotone": (periods - breaks) / periods if periods else float("nan"),
            "rows": rows}


def score_psi(dates: np.ndarray, p: np.ndarray, baseline_months: int = 12,
              freq: str = COHORT_FREQ) -> list[dict]:
    """Population stability of the SCORE itself, against the opening window."""
    df = pd.DataFrame({"d": pd.to_datetime(dates), "p": p})
    start = df["d"].min()
    base = df.loc[df["d"] < start + pd.DateOffset(months=baseline_months), "p"].to_numpy()
    out = []
    for period, g in df.groupby(pd.Grouper(key="d", freq=freq)):
        if len(g) < 200:
            continue
        out.append({"period": period.strftime("%Y-%m-%d"),
                    "psi": M.psi_scores(base, g["p"].to_numpy()), "n": len(g)})
    return out


def characteristic_psi(df: pd.DataFrame, columns: list[str],
                       baseline_months: int = 12, freq: str = VINTAGE_FREQ) -> list[dict]:
    """Characteristic-level stability (CSI) — which INPUT moved, when the score
    moved. A score PSI tells you something changed; this tells you what."""
    d = df[["performance_date", *columns]].copy()
    start = d["performance_date"].min()
    base_mask = d["performance_date"] < start + pd.DateOffset(months=baseline_months)
    out = []
    for period, g in d.groupby(pd.Grouper(key="performance_date", freq=freq)):
        if len(g) < 500:
            continue
        row = {"period": period.strftime("%Y-%m-%d"), "n": int(len(g))}
        for c in columns:
            if not pd.api.types.is_numeric_dtype(d[c]):
                continue
            row[c] = M.psi_scores(d.loc[base_mask, c].dropna().to_numpy(),
                                  g[c].dropna().to_numpy())
        out.append(row)
    return out


def vintage_curves(df: pd.DataFrame, target: str = "default_flag",
                   max_mob: int = 84) -> list[dict]:
    """Cumulative default rate by months on book, by origination vintage.

    The standard cohort view. Vintages are ORDERED, so the UI colours them with a
    one-hue ramp rather than eleven categorical hues.
    """
    d = df[["vintage", "months_on_book", target]].copy()
    d = d[d["months_on_book"] <= max_mob]
    g = (d.groupby(["vintage", "months_on_book"])[target]
           .agg(["sum", "size"]).reset_index())
    out = []
    for v, sub in g.groupby("vintage"):
        sub = sub.sort_values("months_on_book")
        exposure = sub["size"].to_numpy()
        if exposure.sum() < 2000:
            continue
        hz = sub["sum"].to_numpy() / np.maximum(exposure, 1)
        surv = np.cumprod(1.0 - hz)
        out.append({
            "vintage": int(v),
            "points": [{"mob": int(m), "cumulative_default_pct": float((1 - s) * 100),
                        "n": int(e)}
                       for m, s, e in zip(sub["months_on_book"], surv, exposure)],
        })
    return sorted(out, key=lambda r: r["vintage"])


def segment_backtest(df: pd.DataFrame, y: np.ndarray, p: np.ndarray, column: str,
                     min_n: int = 2000) -> list[dict]:
    """Where does the model break? Slice by any categorical and look.

    Reporting a segment the model underperforms on is more informative than
    a clean headline. It is also the thing a validator will look for first.
    """
    d = pd.DataFrame({"g": df[column].astype(str).to_numpy(), "y": y, "p": p})
    overall = M.auc(y, p)
    out = []
    for level, sub in d.groupby("g"):
        if len(sub) < min_n:
            continue
        a = M.auc(sub["y"].to_numpy(), sub["p"].to_numpy())
        ev = int(sub["y"].sum())
        act, pred = ev / len(sub), float(sub["p"].mean())
        lo, hi = M.jeffreys_interval(ev, len(sub))
        out.append({
            "segment": level, "n": int(len(sub)), "events": ev,
            "auc": a, "auc_delta": (a - overall) if a == a else float("nan"),
            "actual_annual": float(annualize(act)),
            "predicted_annual": float(annualize(pred)),
            "calibrated": bool(lo <= pred <= hi),
            "bias_pct": (pred / act - 1.0) * 100.0 if act > 0 else float("nan"),
        })
    return sorted(out, key=lambda r: (r["auc"] if r["auc"] == r["auc"] else 9))


# Frequencies the interface may re-cohort to, with what each one costs a reader.
# Monthly is offered because the underlying data IS monthly and the question is
# fair; it is not the default because of what the numbers below do to it.
FREQ_CHOICES: dict[str, str] = {"MS": "month", "QS": "quarter", "YS": "year"}


def recohort(scored: dict, freq: str) -> dict:
    """Re-run the time-cohorted statistics at another frequency.

    Uses the predictions already computed for the fit, so no refit is involved.
    """
    if freq not in FREQ_CHOICES:
        raise ValueError(f"unknown frequency {freq!r}")
    d, y, p = scored["dates"], scored["y"], scored["p"].astype(float)
    return {
        "cohorts": by_cohort(d, y, p, freq=freq),
        "rank_order": rank_order_stability(d, y, p, freq=freq),
        "score_psi": score_psi(d, p, freq=freq),
        "period_freq": FREQ_CHOICES[freq],
    }
