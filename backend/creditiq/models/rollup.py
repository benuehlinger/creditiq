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
from .spec import LgdSpec, MevSpec, ModelSpec, VariableSpec

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
    # NOTE the absence of bbb_yield, for the same reason hpi_yoy is absent from
    # mortgage. It fits -0.11 against a positive prior at p = 0.18: an
    # insignificant term with the wrong sign. Commercial property growth and the
    # BBB yield both proxy the credit cycle, and once the property term is in the
    # specification the residual yield term picks up the wrong direction.
    #
    # It was not free. Under severely adverse the BBB yield widens IMMEDIATELY
    # while the property fall builds over the following year, so a negative
    # coefficient on it pushed stressed PD BELOW baseline for the first nine
    # months of the projection — a stress scenario that reduced the default rate.
    # Dropping it improves test AUC from 0.7784 to 0.7821 and leaves out-of-time
    # unchanged at 0.691.
    "cre": (["dscr_reported", "current_ltv", "risk_rating", "property_type"],
            ["cre_price_index_yoy"]),
}
SEGMENTS = {"consumer": "fico_band", "mortgage": "ltv_band", "cre": "property_type"}


def pf_spec_signs(portfolio: str) -> dict[str, int]:
    from ..data.portfolios import PORTFOLIOS
    return PORTFOLIOS[portfolio].expected_signs
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
    # True when every book is reported on its champion, or on the documented
    # default where no champion has been promoted. False means a hand-picked
    # combination, which is an exploratory figure rather than the adopted one.
    is_adopted: bool = True
    selection: dict = field(default_factory=dict)
    # Every saved version per book, so the selector needs no second request.
    available: dict = field(default_factory=dict)


def spec_for(portfolio: str,
             version_hash: str | None = None) -> tuple[ModelSpec, str, object]:
    """Which model this book is reported on, and where it came from.

    Returns the specification, a source of `selected`, `champion` or `default`,
    and the version record when there is one. The source matters: the roll-up is
    the executive number, and a number produced by a hand-picked combination of
    versions is a different object from the one produced by the adopted models.
    """
    if version_hash:
        v = vstore.load(version_hash)
        if v is not None and v.portfolio == portfolio:
            try:
                return ModelSpec.from_dict(v.spec), "selected", v
            except Exception:                                           # noqa: BLE001
                pass
    champ = vstore.champion(portfolio)
    if champ is not None:
        try:
            return ModelSpec.from_dict(champ.spec), "champion", champ
        except Exception:                                               # noqa: BLE001
            pass
    cols, mevs = FALLBACK_SPECS[portfolio]
    return (ModelSpec(portfolio, [VariableSpec(c) for c in cols],
                      [MevSpec(m) for m in mevs],
                      lgd=LgdSpec.default_for(portfolio)), "default", None)


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
        force: bool = False, selection: dict[str, str] | None = None) -> RollUp:
    """Roll every book up onto one page.

    `selection` overrides which saved version a book is reported on, per
    portfolio. Absent, each book uses its champion, and a book with no champion
    uses the documented default specification. A selection that differs from the
    champions produces a number that is NOT the adopted position, and the result
    says so rather than leaving it to be inferred from a dropdown.
    """
    scenarios = scenarios or ["baseline", "severely_adverse"]
    selection = {k: v for k, v in (selection or {}).items() if v}
    key = (tuple(scenarios), with_tornado,
           tuple(sorted(selection.items())))
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
        spec, source, version = spec_for(portfolio, selection.get(portfolio))
        sr = SS.run(spec, scenarios=scenarios)
        # A macro term fitted against its economic prior is a finding about the
        # specification, and this page is where the number it produces is read.
        # Surfaced here rather than left on the model surface: the roll-up used a
        # champion carrying one, and its stressed default rate fell BELOW
        # baseline for the first nine months as a result.
        priors = pf_spec_signs(portfolio)
        flips = [c.name for c in sr.pd_fit.coefficients
                 if c.name.startswith("mev:")
                 and priors.get(c.name[4:].split()[0]) is not None
                 and priors[c.name[4:].split()[0]] != (1 if c.estimate > 0 else -1)]
        pf = store.load(portfolio)
        champ = vstore.champion(portfolio)

        rows.append({
            "portfolio": portfolio, "label": pf.spec.label,
            "accent_slot": pf.spec.accent_slot,
            "model_name": version.name if version else "documented default",
            "model_hash": spec.hash(),
            "version_hash": version.hash if version else None,
            "source": source,
            "from_champion": source == "champion",
            "champion_hash": champ.hash if champ else None,
            "champion_name": champ.name if champ else None,
            # A version fitted on a superseded panel still re-runs — that is the
            # point of a portable specification — but its stored metrics describe
            # data that no longer exists.
            "data_is_current": version.data_is_current() if version else True,
            "ead_method": sr.ead.method, "ead_ccf": sr.ead.estimated_ccf,
            "n_accounts": sr.results[scenarios[0]].n_accounts,
            "exposure": sr.results[scenarios[0]].total_exposure,
            "by_scenario": {k: {
                "ecl": v.ecl, "ecl_bps": v.ecl_bps,
                "pd_12m": v.weighted_pd_12m, "lgd": v.weighted_lgd,
            } for k, v in sr.results.items()},
            "sign_flips": flips,
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
    # Adopted means every book is on its champion, or on the documented default
    # where none has been promoted. Anything else is a hand-picked set.
    adopted = all(r["source"] in ("champion", "default") for r in rows)
    available = {
        r["portfolio"]: [
            {"hash": v.hash, "name": v.name, "status": v.status,
             "created_at": v.created_at, "starred": v.starred,
             "auc_test": v.metrics.get("auc_test"),
             "n_variables": v.metrics.get("n_variables"),
             "data_is_current": v.data_is_current()}
            for v in vstore.list_all(r["portfolio"])
        ] for r in rows
    }
    out = RollUp(scenarios=scenarios, portfolios=rows, totals=totals, monthly=monthly,
                 tornado=sorted(tornado, key=lambda r: -abs(r["delta_ecl"])),
                 concentration=concentration, timings=timings,
                 is_adopted=adopted, selection=dict(selection), available=available)
    _CACHE[key] = out
    return out


def _tornado_for(spec: ModelSpec, sr, portfolio: str) -> list[dict]:
    """Shock one macro variable at a time, by one standard deviation of its own
    history, and re-project. A PARTIAL derivative — in a real downturn these move
    together, and the tornado deliberately does not."""
    df = store.analysis_frame(portfolio)
    pf = store.load(portfolio)
    as_of = df["performance_date"].max()
    fit_from = SS.estimation_window(portfolio)
    base_path = SS.scenario_mev_path("severely_adverse", as_of, fit_from=fit_from)
    pd_run = modelsvc.run(spec)
    lg = SS.lgd_model(portfolio, spec.lgd)
    ead_a = EAD.assumption_for(portfolio, pf.spec.ead_method, pf.panel)
    horizon = len(sr.results["severely_adverse"].monthly)
    base_ecl = sr.results["severely_adverse"].ecl

    out = []
    for m in spec.mevs:
        key = m.key
        if key not in base_path.columns:
            continue
        hist = base_path[key].loc[(base_path.index >= fit_from) & (base_path.index <= as_of)]
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
