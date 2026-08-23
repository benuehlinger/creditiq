"""The canonical monthly MEV panel, built from the committed FRED cache.

Everything downstream — the data generator, the PD model's macro terms, the
scenario engine — reads this one frame. It works offline, with no key.

Column convention, so nothing is ambiguous at the call site:

  <key>         the variable AS THE CCAR SCENARIOS PUBLISH IT.
                A growth variable holds an annualized percent, measured over a
                TRAILING 3-MONTH window so it is directly comparable to the
                quarterly annualized rate the Fed publishes. A rate holds a
                percent. An index holds an index level.
  <key>_level   the underlying level the growth was computed from. Present only
                where the two differ.

The order of operations is fixed and never reversed: convert to a monthly LEVEL
first, then difference. A growth rate is never interpolated.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from . import reconcile
from .registry import Mev, by_key

CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "mev_cache"

# Where a quarterly variable has a monthly cousin, use it as a Chow-Lin style
# indicator so the disaggregated path follows real monthly movement rather than a
# smooth curve. This is what separates a defensible disaggregation from a
# decorative one.
# The indicator must be a series that genuinely MOVES WITH the target at monthly
# frequency. Merely correlated is not good enough: the proportional objective
# copies the indicator's month-to-month shape into the result, so a volatile
# indicator manufactures volatility that is not in the data. Real disposable
# income is the standard monthly indicator for GDP. Inverted unemployment was
# tried and REJECTED — it swings four-fold in 2020, which produced monthly GDP
# growth near -100% annualized.
INDICATORS: dict[str, str] = {
    "real_gdp_growth": "industrial_production",
    "nominal_gdp_growth": "industrial_production",
    "hpi_fhfa": "hpi",
    # No indicator for CRE. There is no monthly US commercial property series to
    # anchor to, and borrowing a residential one would import exactly the
    # divergence the CRE portfolio exists to show. A flat indicator gives the
    # smooth Denton path, which still aggregates back exactly.
}


def manifest() -> dict:
    return json.loads((CACHE_DIR / "manifest.json").read_text())


def resolved_mevs() -> dict[str, Mev]:
    man = manifest()
    catalog = by_key()
    return {r["key"]: catalog[r["key"]] for r in man["series"]
            if r["status"].startswith("ok") and r["key"] in catalog}


@lru_cache(maxsize=1)
def monthly_panel() -> pd.DataFrame:
    hist = pd.read_parquet(CACHE_DIR / "fred_history.parquet")
    hist["date"] = pd.to_datetime(hist["date"])
    mevs = resolved_mevs()
    raw = {k: hist.loc[hist["key"] == k].set_index("date")["value"].sort_index()
           for k in mevs}

    levels: dict[str, pd.Series] = {}
    deferred: list[str] = []

    for key, mev in mevs.items():
        if mev.native == "Q" and key in INDICATORS:
            deferred.append(key)
            continue
        levels[key] = _monthly_level(raw[key], mev, None)

    helpers: dict[str, pd.Series] = {}
    if "industrial_production" in levels:
        helpers["industrial_production"] = levels["industrial_production"]
    if "hpi" in levels:
        helpers["hpi"] = levels["hpi"]

    for key in deferred:
        levels[key] = _monthly_level(raw[key], mevs[key], helpers.get(INDICATORS[key]))

    df = pd.DataFrame(levels).sort_index()
    df.index.name = "date"

    # Now derive the published form for growth variables. Level first, always.
    out = {}
    for key, mev in mevs.items():
        if key not in df:
            continue
        lv = df[key]
        if mev.derive == "qoq_annualized_from_level":
            out[f"{key}_level"] = lv
            # TRAILING 3-MONTH annualized, not month-over-month annualized.
            # CCAR publishes growth at a quarterly annualized rate. The monthly
            # analogue of that is a 3-month window, not a 1-month window.
            # Month-over-month annualization multiplies every monthly wobble by
            # twelve: it put real GDP growth at -100% in April 2020, which is an
            # artefact of the definition, not a fact about the economy. Over a
            # 3-month window the same series reproduces the published quarterly
            # figures, including the real 2020 collapse and rebound.
            out[key] = ((lv / lv.shift(3)) ** 4 - 1.0) * 100.0
        else:
            out[key] = lv
    res = pd.DataFrame(out).sort_index()

    # Year-over-year change for every INDEX variable.
    #
    # An index level is non-stationary — Case-Shiller roughly doubles over the
    # panel window — so its z-score trends monotonically and is unusable as a
    # hazard driver. Two things go wrong. A main effect on a trending level makes
    # PD drift in one direction for a decade regardless of the cycle. Worse, an
    # INTERACTION with a trending level drifts too: current LTV crossed with the
    # HPI level had its coefficient fully cancelled by 2023 (0.62 main effect
    # against -0.38 x z_hpi at z = 1.5), which collapsed out-of-time AUC to 0.59.
    #
    # The YoY change is stationary and is what the credit cycle actually is. The
    # cumulative level effect on a borrower is already carried, correctly, by
    # current LTV — which is measured against THEIR origination, not a common
    # base.
    for key, mev in mevs.items():
        if mev.measure == "index" and key in res.columns:
            res[f"{key}_yoy"] = (res[key] / res[key].shift(12) - 1.0) * 100.0
    res.index.name = "date"
    return res


def _monthly_level(s: pd.Series, mev: Mev, indicator: pd.Series | None) -> pd.Series:
    """One series -> a monthly LEVEL, whatever its native frequency and form."""
    if mev.derive == "level_from_yoy_growth":
        # FRED publishes growth; the CCAR variable is an index. Build the
        # quarterly level FIRST, then benchmark the level to monthly. Doing it in
        # the other order would interpolate a growth rate.
        q_level = reconcile.level_from_yoy_growth(s.to_numpy(dtype=float))
        q = pd.Series(q_level, index=s.index, name=s.name)
        return reconcile.to_monthly(q, mev, indicator=indicator)
    return reconcile.to_monthly(s, mev, indicator=indicator)


def panel_for(keys: list[str], start: str | None = None,
              end: str | None = None) -> pd.DataFrame:
    df = monthly_panel()
    out = df[[k for k in keys if k in df.columns]]
    if start:
        out = out.loc[out.index >= pd.Timestamp(start)]
    if end:
        out = out.loc[out.index <= pd.Timestamp(end)]
    return out.copy()


def standardize(df: pd.DataFrame, ref: pd.DataFrame | None = None) -> pd.DataFrame:
    """z-score against a reference window, so hazard coefficients are comparable."""
    ref = df if ref is None else ref
    return (df - ref.mean()) / ref.std(ddof=0)
