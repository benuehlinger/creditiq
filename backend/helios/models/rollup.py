"""Portfolio roll-up — the executive view.

Consolidates all three books onto one screen. The only number a CRO wants is ECL
under stress and how much it moves; everything else on the page exists to answer
"where does the pain come from".

The sensitivity tornado is the one non-obvious piece. It answers "which single
macro variable moves total ECL most" by shocking each variable in turn, one
standard deviation of its own history, holding the rest of the scenario fixed,
and re-projecting. That is a partial derivative, not a scenario — the variables
move together in a real downturn, and the tornado deliberately does not.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import store
from . import ead as EAD
from . import ecl as ECL
from . import scenario_service as SS
from . import service as modelsvc
from . import versions as vstore
from .spec import MevSpec, ModelSpec, VariableSpec

# Used when a portfolio has no saved champion yet, so the executive view is never
# empty in a demo. Labelled as a default in the response.
FALLBACK_SPECS: dict[str, tuple[list[str], list[str]]] = {
    "consumer": (["fico_orig", "revolving_utilization", "dti", "prior_delinq_count"],
                 ["unemployment_rate", "real_disp_income_growth"]),
    # NOTE the absence of hpi_yoy. Current LTV is computed FROM the house-price
    # path, so including a separate HPI growth term alongside it is double
    # counting: the residual term picks up a vintage confound and fits with the
    # wrong sign (+0.399 against a negative prior). The platform flags that as a
    # sign flip, and the fix is to drop the redundant term, not to constrain it —
    # the house-price channel still reaches PD through current LTV, which the
    # projection re-computes on the scenario's own HPI path.
    # Unemployment ALONE, deliberately. Two macro terms were tried and both had
    # to go:
    #
    #   hpi_yoy fits +0.39 alongside current LTV and +0.12 without it. The second
    #   one is the interesting number: it is not simple double counting. House
    #   price growth peaked in 2021-22 at the same moment the book filled with
    #   young, high-LTV originations climbing the seasoning ramp, so the MARGINAL
    #   association between price growth and default is positive even though the
    #   causal effect is negative. That is a composition confound, and the honest
    #   answer is to let the house-price channel reach PD through current LTV —
    #   which the projection re-computes on the scenario's own HPI path — rather
    #   than to force a sign on a term that is measuring something else.
    #
    #   mortgage_rate fits -0.14 and drags unemployment to -0.01 with it. In the
    #   generating process it moves prepayment, not default, so there is nothing
    #   for it to find.
    #
    # With unemployment alone the coefficient is +0.045, the sign economics
    # predicts, and mortgage ECL still triples under severely adverse through the
    # LTV channel.
    "mortgage": (["current_ltv", "fico_orig", "dti", "occupancy"],
                 ["unemployment_rate"]),
    "cre": (["dscr_reported", "current_ltv", "risk_rating", "property_type"],
            ["cre_price_index_yoy", "bbb_yield"]),
}
SEGMENTS = {"consumer": "fico_band", "mortgage": "ltv_band", "cre": "property_type"}
_CACHE: dict[tuple, "RollUp"] = {}


@dataclass
class RollUp:
    scenarios: list[str]
    portfolios: list[dict] = field(default_factory=list)
    totals: dict = field(default_factory=dict)
    monthly: list[dict] = field(default_factory=list)
    tornado: list[dict] = field(default_factory=list)
    concentration: dict = field(default_factory=dict)
    timings: dict = field(default_factory=dict)


def spec_for(portfolio: str) -> tuple[ModelSpec, bool]:
    """The champion if one is saved, otherwise a documented default."""
    champ = vstore.champion(portfolio)
    if champ is not None:
        try:
            return ModelSpec.from_dict(champ.spec), True
        except Exception:                                               # noqa: BLE001
            pass
    cols, mevs = FALLBACK_SPECS[portfolio]
    return ModelSpec(portfolio, [VariableSpec(c) for c in cols],
                     [MevSpec(m) for m in mevs]), False


def _bands(df: pd.DataFrame, portfolio: str) -> pd.Series:
    """Concentration dimension per book, in the terms a credit committee uses."""
    if portfolio == "consumer" and "fico_orig" in df:
        return pd.cut(df["fico_orig"], [0, 620, 660, 700, 740, 780, 900],
                      labels=["<620", "620-659", "660-699", "700-739", "740-779", "780+"])
    if portfolio == "mortgage" and "current_ltv" in df:
        return pd.cut(df["current_ltv"], [0, 50, 60, 70, 80, 90, 400],
                      labels=["<50", "50-59", "60-69", "70-79", "80-89", "90+"])
    if portfolio == "cre" and "property_type" in df:
        return df["property_type"].astype(str)
    return pd.Series(["all"] * len(df), index=df.index)


def run(scenarios: list[str] | None = None, with_tornado: bool = True,
        force: bool = False) -> RollUp:
    scenarios = scenarios or ["baseline", "adverse", "severely_adverse"]
    key = (tuple(scenarios), with_tornado)
    if not force and key in _CACHE:
        return _CACHE[key]

    t0 = time.perf_counter()
    timings: dict[str, float] = {}
    rows: list[dict] = []
    per_month: dict[str, dict[str, list[float]]] = {}
    concentration: dict[str, list[dict]] = {}
    tornado: list[dict] = []

    for portfolio in store.available():
        ts = time.perf_counter()
        spec, from_champion = spec_for(portfolio)
        sr = SS.run(spec, scenarios=scenarios)
        pf = store.load(portfolio)
        champ = vstore.champion(portfolio)

        rows.append({
            "portfolio": portfolio, "label": pf.spec.label,
            "accent_slot": pf.spec.accent_slot,
            "model_name": champ.name if champ else "default specification",
            "model_hash": spec.hash(), "from_champion": from_champion,
            "ead_method": sr.ead.method, "ead_ccf": sr.ead.estimated_ccf,
            "n_accounts": sr.results[scenarios[0]].n_accounts,
            "exposure": sr.results[scenarios[0]].total_exposure,
            "by_scenario": {k: {
                "ecl": v.ecl, "ecl_bps": v.ecl_bps,
                "pd_12m": v.weighted_pd_12m, "lgd": v.weighted_lgd,
            } for k, v in sr.results.items()},
            "capped": sr.capped,
            "extrapolation_flags": [e.key for e in sr.extrapolation if e.outside],
        })

        for k, v in sr.results.items():
            per_month.setdefault(k, {})[portfolio] = [m["cumulative_loss"] for m in v.monthly]
            per_month[k].setdefault("_months", [m["month"] for m in v.monthly])

        # concentration on the book as it stands
        book = ECL._as_of_frame(store.analysis_frame(portfolio),
                                pf.panel["performance_date"].max())
        band = _bands(book, portfolio)
        # Bands are ORDINAL — "<620" then "620-659" and so on. Grouping on the
        # string sorts them alphabetically, which puts "<620" last and makes the
        # chart unreadable. Keep the categorical order the cut produced.
        order = (list(band.cat.categories) if hasattr(band, "cat")
                 else sorted(band.astype(str).unique()))
        g = pd.DataFrame({"band": band.astype(str),
                          "exposure": book["current_balance"].to_numpy(float)})
        sums = g.groupby("band")["exposure"].sum()
        tot = float(sums.sum()) or 1.0
        concentration[portfolio] = [
            {"band": str(b), "exposure": float(sums.get(str(b), 0.0)),
             "share": float(sums.get(str(b), 0.0) / tot)}
            for b in order if str(b) in sums.index]
        timings[portfolio] = round(time.perf_counter() - ts, 2)

        if with_tornado:
            tornado += _tornado_for(spec, sr, portfolio)

    totals = {}
    for k in scenarios:
        ecl = sum(r["by_scenario"][k]["ecl"] for r in rows if k in r["by_scenario"])
        exp = sum(r["exposure"] for r in rows)
        w_pd = sum(r["by_scenario"][k]["pd_12m"] * r["exposure"] for r in rows) / max(exp, 1)
        w_lgd = sum(r["by_scenario"][k]["lgd"] * r["exposure"] for r in rows) / max(exp, 1)
        totals[k] = {"ecl": ecl, "exposure": exp, "ecl_bps": ecl / max(exp, 1) * 10_000,
                     "weighted_pd_12m": w_pd, "weighted_lgd": w_lgd}

    monthly = []
    for k, d in per_month.items():
        months = d.get("_months", [])
        for i, mth in enumerate(months):
            monthly.append({"scenario": k, "month": mth,
                            **{p: d[p][i] for p in d if p != "_months" and i < len(d[p])}})

    timings["total"] = round(time.perf_counter() - t0, 2)
    out = RollUp(scenarios=scenarios, portfolios=rows, totals=totals, monthly=monthly,
                 tornado=sorted(tornado, key=lambda r: -abs(r["delta_ecl"])),
                 concentration=concentration, timings=timings)
    _CACHE[key] = out
    return out


def _tornado_for(spec: ModelSpec, sr, portfolio: str) -> list[dict]:
    """Shock one macro variable at a time, by one standard deviation of its own
    history, and re-project. A PARTIAL derivative — in a real downturn these move
    together, and the tornado deliberately does not."""
    df = store.analysis_frame(portfolio)
    pf = store.load(portfolio)
    as_of = df["performance_date"].max()
    base_path = SS.scenario_mev_path("severely_adverse", as_of, cap_to_fitted_range=True)
    pd_run = modelsvc.run(spec)
    lg = SS.lgd_model(portfolio)
    ead_a = EAD.assumption_for(portfolio, pf.spec.ead_method, pf.panel)
    horizon = len(sr.results["severely_adverse"].monthly)
    base_ecl = sr.results["severely_adverse"].ecl

    out = []
    for m in spec.mevs:
        key = m.key
        if key not in base_path.columns:
            continue
        hist = base_path[key].loc[(base_path.index >= "2015-01-01") & (base_path.index <= as_of)]
        sd = float(hist.std(ddof=0)) or 1.0
        shocked = base_path.copy()
        fwd = shocked.index > as_of
        # The adverse direction comes from the ECONOMIC PRIOR, not from the way
        # the variable happens to move in this scenario.
        #
        # Taking it from the scenario was the first version and it was wrong:
        # under severely adverse, mortgage rates FALL — a flight to quality — so
        # "further in the scenario's direction" shocked rates DOWN and the tornado
        # reported that a worse mortgage rate reduces expected loss by 22%. On a
        # CRO's screen that is not a subtlety, it is a wrong answer.
        prior = pf.spec.expected_signs.get(key)
        if prior is None:
            prior = -1 if hist.mean() > 0 else 1        # growth-like: down is adverse
        direction = 1.0 if prior > 0 else -1.0
        shocked.loc[fwd, key] = shocked.loc[fwd, key] + direction * sd
        r = ECL.project(spec, pd_run.fit, df, shocked, lg, ead_a,
                        "tornado", horizon, as_of=as_of)
        out.append({
            "portfolio": portfolio, "mev": key, "shock_sd": 1.0,
            "direction": "up" if direction > 0 else "down",
            "prior": int(prior), "base_ecl": base_ecl, "shocked_ecl": r.ecl,
            "delta_ecl": r.ecl - base_ecl,
            "delta_pct": (r.ecl - base_ecl) / max(base_ecl, 1.0) * 100.0,
        })
    return out


def clear() -> None:
    _CACHE.clear()
