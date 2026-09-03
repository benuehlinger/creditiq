"""Macro transformation search: build many candidate terms, then reduce them.

A macroeconomic variable does not enter a credit model as published. It enters
as some transformation of itself at some lag, and which one is an empirical
question. This module enumerates the candidates and applies three filters that
narrow several hundred down to a handful.

**Stationarity.** A regression of one trending series on another finds a
relationship whether or not one exists. Unemployment in levels and a default
rate that drifts with book composition will correlate at 0.8 with no causal
content between them. Every candidate carries an augmented Dickey-Fuller test,
and non-stationary forms are excluded by default with the test reported. This is
the filter that removes most `level` forms and is the reason the search exists.

**Autocorrelation.** A correlation between two smooth monthly series is not
estimated on 216 independent observations. The effective sample size is smaller,
often by a factor of ten, and an unadjusted p-value on 216 points calls almost
anything significant. The reported significance uses the Bartlett-Quenouille
adjustment for first-order autocorrelation in both series.

**Sign.** A term whose observed direction contradicts the economic prior is a
finding about collinearity, not a discovery. The prior is declared per VARIABLE
and is applied to every transform and lag of it: a prior says which way a
variable moves default risk, and differencing or lagging it does not reverse
that. Rising unemployment raises defaults whether it is read as a level, a
twelve-month change or a growth rate.

A portfolio declares its priors under whichever name it uses in its own
specification, which is sometimes the derived series — the commercial book
declares `cre_price_index_yoy`, not `cre_price_index`. Looking the prior up under
the base key alone found nothing for those, so every commercial property
candidate reported no prior when one existed.

None of the three is applied for you. Each is reported, the defaults are stated,
and the filters are switches.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.tsa.stattools import adfuller

from ..models.design import apply_mev_transform

# The transforms a scenario can carry forward. Every one of these is implemented
# in `apply_mev_transform`, which both the fit and the projection go through.
TRANSFORMS: list[tuple[str, str, str]] = [
    ("level", "Level", "As published."),
    ("diff", "1m change", "First difference. Removes a linear trend."),
    ("four_quarter_change", "12m change",
     "Change over twelve months, in the variable's own units."),
    ("yoy", "12m % change",
     "Year-over-year growth. Removes a trend and a seasonal pattern together."),
    ("qoq_annualized", "3m change annualised",
     "Quarter-over-quarter growth at an annual rate. Responds faster than YoY."),
    ("ma3", "3m average", "Rolling three-month mean of the level. Smooths noise."),
    ("ma6", "6m average", "Rolling six-month mean of the level."),
    ("ma12", "12m average",
     "Rolling twelve-month mean of the level. Removes the seasonal pattern."),
    ("yoy_ma3", "12m % change, 3m avg",
     "Year-over-year growth, then a three-month average. Growth without the "
     "month-to-month noise."),
    ("diff_ma3", "1m change, 3m avg",
     "First difference, then a three-month average. The recent drift."),
]

LAGS: tuple[int, ...] = (0, 3, 6, 9, 12)

# The augmented Dickey-Fuller null is a unit root, so a SMALL p-value is evidence
# of stationarity. 0.05 is the convention.
ADF_ALPHA = 0.05


@dataclass(frozen=True)
class Candidate:
    key: str
    transform: str
    lag_months: int

    @property
    def column(self) -> str:
        """A stable name for the materialised column, parsed back by the UI."""
        return f"{self.key}@{self.transform}@{self.lag_months}"

    @staticmethod
    def parse(column: str) -> "Candidate | None":
        parts = column.split("@")
        if len(parts) != 3:
            return None
        try:
            return Candidate(parts[0], parts[1], int(parts[2]))
        except ValueError:
            return None


def _effective_n(a: np.ndarray, b: np.ndarray) -> float:
    """Bartlett-Quenouille adjustment for serial correlation in both series.

    n_eff = n (1 - r1 s1) / (1 + r1 s1), where r1 and s1 are the lag-1
    autocorrelations. Two smooth monthly series over eighteen years carry far
    less independent information than their 216 observations suggest.
    """
    n = len(a)
    if n < 12:
        return float(n)

    def ac1(v: np.ndarray) -> float:
        v = v - v.mean()
        d = float(np.dot(v, v))
        return float(np.dot(v[:-1], v[1:]) / d) if d > 0 else 0.0

    r = ac1(a) * ac1(b)
    r = float(np.clip(r, -0.99, 0.99))
    return float(max(4.0, n * (1 - r) / (1 + r)))


def _correlate(x: pd.Series, target: pd.Series) -> dict:
    joined = pd.concat([x.rename("x"), target.rename("y")], axis=1).dropna()
    if len(joined) < 24:
        return {"r": None, "n": len(joined), "n_effective": None, "p": None}
    a = joined["x"].to_numpy(float)
    b = joined["y"].to_numpy(float)
    if a.std() < 1e-12 or b.std() < 1e-12:
        return {"r": None, "n": len(joined), "n_effective": None, "p": None}
    r = float(np.corrcoef(a, b)[0, 1])
    n_eff = _effective_n(a, b)
    if n_eff > 2 and abs(r) < 1:
        t = r * np.sqrt((n_eff - 2) / (1 - r * r))
        p = float(2 * stats.t.sf(abs(t), n_eff - 2))
    else:
        p = None
    return {"r": r, "n": int(len(joined)), "n_effective": round(n_eff, 1), "p": p}


def _adf(x: pd.Series) -> dict:
    v = x.dropna().to_numpy(float)
    if len(v) < 24 or np.std(v) < 1e-12:
        return {"p": None, "statistic": None, "stationary": None}
    try:
        stat, p, *_ = adfuller(v, autolag="AIC")
    except Exception:                                                # noqa: BLE001
        return {"p": None, "statistic": None, "stationary": None}
    return {"p": float(p), "statistic": float(stat), "stationary": bool(p < ADF_ALPHA)}


def pd_target(portfolio: str) -> pd.Series:
    """Monthly default rate on the log-odds scale.

    The log-odds rather than the rate, because that is the scale the hazard model
    is linear in. A correlation computed against the rate answers a different
    question from the one the model asks.
    """
    from .. import store
    from ..data.portfolios import PORTFOLIOS
    df = store.analysis_frame(portfolio)
    g = df.groupby(pd.Grouper(key="performance_date", freq="MS"))[
        PORTFOLIOS[portfolio].target.column].agg(["size", "sum"])
    g = g[g["size"] >= 500]
    p = ((g["sum"] + 0.5) / (g["size"] + 1.0)).clip(1e-6, 1 - 1e-6)
    return np.log(p / (1 - p)).rename("pd_log_odds")


def lgd_rows(portfolio: str) -> pd.DataFrame:
    """Every defaulted row with the month it defaulted in.

    Severity is correlated at the LOAN level, not on a monthly mean. The
    commercial book resolves 381 defaults over 216 months, so a monthly mean
    reaches five resolutions in only fourteen of them — too few to correlate
    anything against. It is also the wrong statistic: the LGD model is estimated
    on defaulted rows with the macro joined at the default month, so that is the
    population the screen should measure on.
    """
    from .. import store
    df = store.analysis_frame(portfolio)
    d = df.loc[df["default_flag"] == 1, ["performance_date", "lgd_realised"]].dropna()
    return pd.DataFrame({
        "month": pd.DatetimeIndex(d["performance_date"]).to_period("M").to_timestamp(),
        "y": np.clip(d["lgd_realised"].to_numpy(float), 0.0, 1.0),
    })


def _correlate_loan_level(x: pd.Series, rows: pd.DataFrame) -> dict:
    """Rank correlation between a macro term and realised severity, per default.

    The effective sample size is capped at the number of DISTINCT MONTHS. A macro
    variable takes one value per month, so a hundred defaults in one month carry
    one observation of that variable, not a hundred. Reporting significance on
    the default count would overstate it by roughly the average defaults per
    month.
    """
    v = x.reindex(rows["month"]).to_numpy(float)
    ok = np.isfinite(v) & np.isfinite(rows["y"].to_numpy(float))
    if ok.sum() < 30:
        return {"r": None, "n": int(ok.sum()), "n_effective": None, "p": None}
    a, b = v[ok], rows["y"].to_numpy(float)[ok]
    if np.std(a) < 1e-12 or np.std(b) < 1e-12:
        return {"r": None, "n": int(ok.sum()), "n_effective": None, "p": None}
    r = float(stats.spearmanr(a, b).statistic)
    months = rows["month"].to_numpy()[ok]
    n_months = int(pd.unique(months).size)
    monthly = pd.Series(a, index=months).groupby(level=0).first().to_numpy()
    n_eff = min(float(n_months), _effective_n(monthly, monthly))
    if n_eff > 2 and abs(r) < 1:
        t = r * np.sqrt((n_eff - 2) / (1 - r * r))
        p = float(2 * stats.t.sf(abs(t), n_eff - 2))
    else:
        p = None
    return {"r": r, "n": int(ok.sum()), "n_effective": round(n_eff, 1), "p": p}


@lru_cache(maxsize=8)
def library(portfolio: str) -> dict:
    """Every candidate term, with its stationarity test and both correlations."""
    from ..data.portfolios import PORTFOLIOS
    from ..mev.panel import monthly_panel
    from ..mev.registry import by_key
    from ..models.scenario_service import PROJECTION_MEVS

    panel = monthly_panel()
    y_pd = pd_target(portfolio)
    lgd_obs = lgd_rows(portfolio)
    # The estimation window. A candidate is judged on the span the model sees.
    lo, hi = y_pd.index.min(), y_pd.index.max()

    # Only variables a scenario can carry forward. A term with no published path
    # cannot be projected, so it cannot enter a model that has to be stressed.
    bases = [k for k in PROJECTION_MEVS if not k.endswith("_yoy") and k in panel.columns]
    meta = by_key(bases)
    raw_signs = PORTFOLIOS[portfolio].expected_signs

    def prior_for(key: str) -> int | None:
        """The prior for a base variable, under any name the portfolio used.

        A specification names the series it actually fitted, which may be the
        derived one. `cre_price_index_yoy` and `cre_price_index` carry the same
        economic claim about commercial property, so either spelling resolves.
        """
        if key in raw_signs:
            return raw_signs[key]
        for suffix in ("_yoy", "_growth"):
            if f"{key}{suffix}" in raw_signs:
                return raw_signs[f"{key}{suffix}"]
        if key.endswith("_yoy") and key[:-4] in raw_signs:
            return raw_signs[key[:-4]]
        return None

    rows: list[dict] = []
    for key in bases:
        raw = panel[key].astype(float)
        for tf, tf_label, tf_note in TRANSFORMS:
            base = apply_mev_transform(raw, tf)
            if not np.isfinite(base.to_numpy(float)).any():
                continue
            for lag in LAGS:
                s = base.shift(lag) if lag else base
                window = s.loc[(s.index >= lo) & (s.index <= hi)]
                if window.notna().sum() < 24:
                    continue
                adf = _adf(window)
                c_pd = _correlate(window, y_pd)
                c_lgd = _correlate_loan_level(window, lgd_obs)
                prior = prior_for(key)
                # The table shows either the PD or the LGD correlation, so the
                # sign check has to follow whichever is on screen. One shared
                # check read from the PD column contradicted the LGD numbers
                # beside it.
                def obs(c: dict) -> int | None:
                    return None if c["r"] is None else (1 if c["r"] > 0 else -1)

                def ok(c: dict) -> bool | None:
                    o = obs(c)
                    return None if prior is None or o is None else bool(prior == o)
                rows.append({
                    "column": Candidate(key, tf, lag).column,
                    "key": key, "label": meta[key].label if key in meta else key,
                    "unit": meta[key].unit if key in meta else "",
                    "transform": tf, "transform_label": tf_label,
                    "lag_months": lag,
                    "adf_p": adf["p"], "stationary": adf["stationary"],
                    "pd_r": c_pd["r"], "pd_p": c_pd["p"],
                    "pd_n": c_pd["n"], "pd_n_effective": c_pd["n_effective"],
                    "lgd_r": c_lgd["r"], "lgd_p": c_lgd["p"],
                    "lgd_n": c_lgd["n"], "lgd_n_effective": c_lgd["n_effective"],
                    "expected_sign": prior,
                    "pd_observed_sign": obs(c_pd), "pd_sign_ok": ok(c_pd),
                    "lgd_observed_sign": obs(c_lgd), "lgd_sign_ok": ok(c_lgd),
                })
    return {
        "portfolio": portfolio,
        "window": [str(lo.date()), str(hi.date())],
        "n_candidates": len(rows),
        "n_bases": len(bases),
        "transforms": [{"key": k, "label": lab, "note": n} for k, lab, n in TRANSFORMS],
        "lags": list(LAGS),
        "adf_alpha": ADF_ALPHA,
        "pd_months": int(len(y_pd)),
        "lgd_defaults": int(len(lgd_obs)),
        "lgd_months": int(lgd_obs["month"].nunique()),
        "rows": rows,
    }


def series_for(portfolio: str, column: str) -> dict:
    """One candidate plotted against both targets, on a comparable scale."""
    from ..mev.panel import monthly_panel
    cand = Candidate.parse(column)
    if cand is None:
        raise KeyError(f"unparseable candidate {column!r}")
    panel = monthly_panel()
    if cand.key not in panel.columns:
        raise KeyError(f"unknown MEV {cand.key!r}")
    s = apply_mev_transform(panel[cand.key], cand.transform)
    if cand.lag_months:
        s = s.shift(cand.lag_months)
    y_pd = pd_target(portfolio)
    obs = lgd_rows(portfolio)
    # For the chart only, severity is averaged by quarter. The statistic in the
    # table is computed per default; this is a readable overlay, not the measure.
    q = obs.assign(q=obs["month"].dt.to_period("Q").dt.to_timestamp())
    lgd_q = q.groupby("q")["y"].mean()
    lo, hi = y_pd.index.min(), y_pd.index.max()
    s = s.loc[(s.index >= lo) & (s.index <= hi)]
    return {
        "column": column, "key": cand.key, "transform": cand.transform,
        "lag_months": cand.lag_months,
        "points": [{"month": d.strftime("%Y-%m-%d"),
                    "value": None if not np.isfinite(v) else float(v),
                    "pd": None if d not in y_pd.index else float(y_pd[d]),
                    "lgd": float(lgd_q[d.to_period("Q").to_timestamp()])
                    if d.to_period("Q").to_timestamp() in lgd_q.index else None}
                   for d, v in s.items()],
    }


def clear() -> None:
    library.cache_clear()


# The library ranks candidates against targets built from the panel, so it is
# stale the moment the panel is rebuilt.
from .. import store as _store  # noqa: E402
_store.register_dependent_cache(library.cache_clear)
