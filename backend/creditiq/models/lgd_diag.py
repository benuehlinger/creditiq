"""Diagnostics and backtesting for a fractional response model.

Copying the PD diagnostics here would be wrong. AUC, KS and a lift curve measure
how well a model separates two classes, and realised severity has no classes.
The quantities that matter for a conditional mean on [0, 1] are different:

  DISCRIMINATION   does the model order defaults by severity? A rank correlation
                   between predicted and realised, not an AUC.
  CALIBRATION      does the LEVEL come out right? This is the one that reaches
                   the loss number, and it is the one a fractional logit can get
                   wrong while ordering perfectly.
  ACCURACY         mean absolute error in percentage points of severity, which is
                   the unit the answer is quoted in.
  SPECIFICATION    a RESET-style link test. Adding the squared linear predictor
                   to the model and testing it is the standard check that the
                   logit link is the right one; Papke and Wooldridge specify it
                   with the estimator.
  VARIANCE         Pearson residuals against fitted values. The estimator assumes
                   nothing about the variance, but a strong pattern here says the
                   mean function is misspecified rather than the variance.

`deviance_r2` is the quasi-likelihood analogue of McFadden's pseudo R-squared:
one minus the fitted quasi-log-likelihood over the intercept-only one.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

from . import lgd as LGD


def _quasi_ll(mu: np.ndarray, y: np.ndarray) -> float:
    m = np.clip(mu, 1e-9, 1 - 1e-9)
    return float(np.sum(y * np.log(m) + (1 - y) * np.log(1 - m)))


def _cohorts(pred: np.ndarray, y: np.ndarray, n: int = 10) -> list[dict]:
    q = np.unique(np.quantile(pred, np.linspace(0, 1, n + 1)))
    if len(q) < 3:
        return []
    b = np.clip(np.digitize(pred, q[1:-1]), 0, len(q) - 2)
    out = []
    for k in range(len(q) - 1):
        m = b == k
        if not m.any():
            continue
        act, prd = y[m], pred[m]
        se = float(act.std(ddof=1) / np.sqrt(m.sum())) if m.sum() > 1 else 0.0
        out.append({
            "cohort": len(out) + 1, "n": int(m.sum()),
            "predicted": float(prd.mean()), "actual": float(act.mean()),
            "actual_lo95": float(max(0.0, act.mean() - 1.96 * se)),
            "actual_hi95": float(min(1.0, act.mean() + 1.96 * se)),
            "zero_loss_share": float((act <= 1e-9).mean()),
            "total_loss_share": float((act >= 1 - 1e-9).mean()),
        })
    return out


def _link_test(X: np.ndarray, y: np.ndarray, beta: np.ndarray) -> dict:
    """RESET-style specification test.

    Refit on the fitted linear predictor and its square. If the square carries a
    significant coefficient, the logit link with these terms does not describe
    the conditional mean — usually because a driver needs a non-linear form.
    """
    eta = np.clip(X @ beta, -30, 30)
    Z = np.column_stack([np.ones_like(eta), eta, eta ** 2])
    try:
        b, cov = LGD.fractional_logit_fit(Z, y)
    except Exception:                                                # noqa: BLE001
        return {"coefficient": None, "z": None, "p_value": None, "ok": None}
    se = float(np.sqrt(max(cov[2, 2], 0.0)))
    if not np.isfinite(se) or se < 1e-12:
        return {"coefficient": float(b[2]), "z": None, "p_value": None, "ok": None}
    z = float(b[2] / se)
    p = float(2 * stats.norm.sf(abs(z)))
    return {"coefficient": float(b[2]), "z": z, "p_value": p, "ok": bool(p >= 0.05)}


def diagnostics(model: LGD.LgdModel, d: pd.DataFrame) -> dict:
    """Everything needed to judge a fitted severity model, on the fitted rows."""
    X = LGD.design_for(d, model)
    y = np.clip(d["lgd_realised"].to_numpy(float), 0.0, 1.0)
    pred = model.predict(X)

    ll = _quasi_ll(pred, y)
    ll0 = _quasi_ll(np.full(len(y), y.mean()), y)
    rho = stats.spearmanr(pred, y)
    resid = (y - pred) / np.sqrt(np.clip(pred * (1 - pred), 1e-6, None))

    # Pearson residuals against fitted, grouped so the panel is readable at any
    # sample size. A slope here indicates the mean function, not the variance.
    order = np.argsort(pred)
    groups = np.array_split(order, min(20, max(3, len(y) // 20)))
    resid_curve = [{
        "predicted": float(pred[g].mean()),
        "residual": float(resid[g].mean()),
        "lo95": float(resid[g].mean() - 1.96 * resid[g].std(ddof=1) / np.sqrt(len(g)))
        if len(g) > 1 else float(resid[g].mean()),
        "hi95": float(resid[g].mean() + 1.96 * resid[g].std(ddof=1) / np.sqrt(len(g)))
        if len(g) > 1 else float(resid[g].mean()),
        "n": int(len(g)),
    } for g in groups if len(g)]

    return {
        "n": int(len(y)),
        "deviance_r2": float(1.0 - ll / ll0) if ll0 else 0.0,
        "log_likelihood": ll, "null_log_likelihood": ll0,
        "spearman": float(rho.statistic) if np.isfinite(rho.statistic) else None,
        "spearman_p": float(rho.pvalue) if np.isfinite(rho.pvalue) else None,
        "mae": float(np.mean(np.abs(y - pred))),
        "rmse": float(np.sqrt(np.mean((y - pred) ** 2))),
        "mean_actual": float(y.mean()), "mean_predicted": float(pred.mean()),
        "calibration": _cohorts(pred, y),
        "residuals": resid_curve,
        "link_test": _link_test(X, y, model.beta),
        "predicted_range": [float(pred.min()), float(pred.max())],
        "actual_range": [float(y.min()), float(y.max())],
    }



def backtest(model: LGD.LgdModel, d: pd.DataFrame, oot_from: str,
             freq: str = "MS") -> dict:
    """Refit on defaults BEFORE the boundary, score the ones after it.

    Severity is thin. The commercial book resolves a few hundred defaults in
    total, so an out-of-time split leaves a test set of tens rather than
    thousands and the interval on any statistic from it is wide. That is the
    honest state of the data, and it is reported alongside the numbers rather
    than left for someone to work out.
    """
    from ..mev.panel import monthly_panel

    cut = pd.Timestamp(oot_from)
    dates = pd.DatetimeIndex(d["performance_date"])
    train, test = d.loc[dates < cut], d.loc[dates >= cut]
    out: dict = {
        "oot_from": oot_from,
        "n_train": int(len(train)), "n_test": int(len(test)),
        "usable": bool(len(train) >= 60 and len(test) >= 20),
    }
    if not out["usable"]:
        out["note"] = (
            f"{len(train)} defaults before the boundary and {len(test)} after it. "
            f"A severity model needs at least 60 to fit and 20 to test against; "
            f"this split cannot support a backtest.")
        return out

    try:
        refit = LGD.fit_lgd(train.assign(default_flag=1), model.spec, monthly_panel())
    except ValueError as e:
        out["usable"] = False
        out["note"] = str(e)
        return out

    def score(frame: pd.DataFrame) -> dict:
        yy = np.clip(frame["lgd_realised"].to_numpy(float), 0.0, 1.0)
        pp = refit.predict(LGD.design_for(frame, refit))
        rho = stats.spearmanr(pp, yy)
        return {
            "n": int(len(yy)),
            "mean_actual": float(yy.mean()), "mean_predicted": float(pp.mean()),
            "mae": float(np.mean(np.abs(yy - pp))),
            "rmse": float(np.sqrt(np.mean((yy - pp) ** 2))),
            "spearman": float(rho.statistic) if np.isfinite(rho.statistic) else None,
            "deviance_r2": float(
                1.0 - _quasi_ll(pp, yy) / _quasi_ll(np.full(len(yy), yy.mean()), yy))
            if len(yy) > 1 else None,
        }

    out["train"] = score(train)
    out["test"] = score(test)
    # Mean severity by year, actual against predicted, so drift is visible rather
    # than averaged away by a single headline number.
    all_pred = refit.predict(LGD.design_for(d, refit))
    yr = pd.DatetimeIndex(d["performance_date"]).year
    frame = pd.DataFrame({"year": yr,
                          "actual": np.clip(d["lgd_realised"].to_numpy(float), 0, 1),
                          "predicted": all_pred})
    g = frame.groupby("year").agg(n=("actual", "size"), actual=("actual", "mean"),
                                  predicted=("predicted", "mean")).reset_index()
    g = g[g["n"] >= 5]
    out["by_year"] = [
        {"year": int(r.year), "n": int(r.n), "actual": float(r.actual),
         "predicted": float(r.predicted), "in_sample": bool(r.year < cut.year)}
        for r in g.itertuples()]
    # The same thing at a readable frequency, with an interval — the backtest
    # was a table of yearly means, which cannot show a turn or say whether a gap
    # is a miss or the spread of a thin quarter.
    out["by_period"] = severity_over_time(d, all_pred, freq=freq, cut=cut)
    out["period_freq"] = SEVERITY_FREQ_CHOICES.get(freq, freq)
    out |= severity_coverage(d, freq)
    return out


# Severity cohorts are QUARTERS for the same reason the PD backtest's are: a
# month of workouts on these books is a handful of resolutions, and a mean taken
# over a handful moves on one loan. Quarterly is coarse enough to read and fine
# enough to show a turn. `MIN_RESOLUTIONS` drops a cohort too thin to average.
SEVERITY_FREQ = "QS"
SEVERITY_FREQ_LABEL = "quarter"
# The fewest resolved workouts that make a mean worth plotting.
#
# Set against the interval rather than against a rule of thumb: the chart draws
# the 95% interval of every cohort mean, so a thin month arrives visibly thin
# rather than quietly wrong. Five is low enough to keep a monthly line
# continuous on books that resolve a few workouts a month, and the band on such
# a month is wide enough that nobody reads it as a level.
MIN_RESOLUTIONS = 5


# Frequencies the interface may group severity at. Monthly is offered because
# the panel is monthly and the question is fair; whether it is READABLE depends
# entirely on how many workouts a book resolves. Measured here:
#
#   consumer  213 of 214 months survive the floor, median 21 resolutions
#   mortgage  139 of 211,                          median 12
#   cre         7 of 158,                          median 10
#
# So monthly is honest on the consumer book, gappy on mortgage and useless on
# commercial real estate. The count of dropped periods travels with the series
# so the interface can say so rather than drawing seven lonely points.
SEVERITY_FREQ_CHOICES: dict[str, str] = {"MS": "month", "QS": "quarter", "YS": "year"}


def severity_over_time(d: pd.DataFrame, predicted: np.ndarray | None = None,
                       freq: str = SEVERITY_FREQ,
                       cut: pd.Timestamp | None = None) -> list[dict]:
    """Mean REALISED severity through time, with the model's prediction beside it.

    The dependent variable through time. A severity model is judged on the LEVEL
    it produces, and a level can drift while every rank stays correct — so the
    realised mean has to be visible against the predicted one, period by period,
    rather than summarised into a single bias.

    Each point is a DISJOINT cohort: the workouts that resolved in that period
    and no others. A trailing window would fill every month on a thin book, but
    adjacent points would then share most of their data, and a reader who does
    not know the window is there reads the smoothness as precision. The panels
    carry enough workouts to fill a month instead.

    The interval is the standard error of the mean rather than a binomial band:
    severity is a proportion per loan, but the quantity being estimated is an
    AVERAGE of proportions, and its spread comes from how much the loans in that
    window differ from one another.
    """
    y = np.clip(d["lgd_realised"].to_numpy(float), 0.0, 1.0)
    frame = pd.DataFrame({"p": pd.DatetimeIndex(d["performance_date"]), "y": y})
    if predicted is not None:
        frame["pred"] = predicted

    periods = pd.period_range(frame["p"].min(), frame["p"].max(),
                              freq={"MS": "M", "QS": "Q", "YS": "Y"}[freq])
    rows: list[dict] = []
    for period in periods:
        end = period.to_timestamp(how="end")
        start = period.to_timestamp()
        g = frame[(frame["p"] >= start) & (frame["p"] <= end)]
        n = len(g)
        stamp = period.to_timestamp().strftime("%Y-%m-%d")
        if n < MIN_RESOLUTIONS:
            # A hole, not an omission: omitting it left no trace, so a time axis
            # joined the points either side and drew a band across months where
            # nothing had resolved.
            rows.append({"period": stamp, "n": int(n),
                         "actual": None, "lo95": None, "hi95": None,
                         "zero_loss_share": None, "too_thin": True,
                         **({"predicted": None, "calibrated": None}
                            if predicted is not None else {}),
                         **({"in_sample": bool(period.to_timestamp() < cut)}
                            if cut is not None else {})})
            continue
        mean = float(g["y"].mean())
        se = float(g["y"].std(ddof=1) / np.sqrt(n)) if n > 1 else 0.0
        row = {
            "period": stamp, "n": int(n), "actual": mean,
            "lo95": max(0.0, mean - 1.96 * se), "hi95": min(1.0, mean + 1.96 * se),
            "zero_loss_share": float((g["y"] <= 0).mean()),
            "too_thin": False,
        }
        if predicted is not None:
            row["predicted"] = float(g["pred"].mean())
            # A predicted mean outside the interval of the realised mean is a
            # calibration miss for that window, not sampling noise.
            row["calibrated"] = bool(row["lo95"] <= row["predicted"] <= row["hi95"])
        if cut is not None:
            row["in_sample"] = bool(period.to_timestamp() < cut)
        rows.append(row)
    return rows


def severity_coverage(d: pd.DataFrame, freq: str) -> dict:
    """How many periods exist, and how many carry enough workouts to average."""
    idx = pd.DatetimeIndex(d["performance_date"])
    total = int(len(idx.to_period("M" if freq == "MS" else
                                 "Q" if freq == "QS" else "Y").unique()))
    kept = sum(1 for r in severity_over_time(d, freq=freq) if not r["too_thin"])
    return {"periods_total": total, "periods_kept": kept,
            "periods_dropped": total - kept, "min_resolutions": MIN_RESOLUTIONS}

