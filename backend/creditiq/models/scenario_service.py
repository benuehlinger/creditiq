"""Scenario orchestration: PD + LGD + EAD -> ECL, under each scenario, with the bridge."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import store
from ..mev import panel as mevpanel
from ..mev import scenarios as scen
from . import bridge as BR
from . import ead as EAD
from . import ecl as ECL
from . import lgd as LGD
from . import runcache
from . import service as modelsvc
from .spec import ModelSpec

import hashlib


def _disk_key(key: tuple) -> str:
    return hashlib.sha256(repr(key).encode()).hexdigest()[:16]

_LGD_CACHE: dict[str, LGD.LgdModel] = {}
_ECL_CACHE: dict[tuple, dict] = {}

# The MEV columns a projection needs on its own monthly grid, whatever the model
# happens to have selected — the dynamics need HPI and the CRE index regardless.
PROJECTION_MEVS = ["hpi", "hpi_yoy", "cre_price_index", "cre_price_index_yoy",
                   "unemployment_rate", "bbb_yield", "real_gdp_growth",
                   "real_disp_income_growth", "mortgage_rate", "treasury_10y",
                   "cpi_inflation", "equity_index", "vix", "prime_rate",
                   "nominal_gdp_growth"]


def lgd_model(portfolio: str, spec: LGD.LgdSpec | None = None) -> LGD.LgdModel:
    """Cached on the LGD SPECIFICATION, not on the portfolio.

    It used to be keyed on the portfolio alone. Once the drivers became a choice
    that would have served the first analyst's severity model to everyone who
    asked afterwards, which is the same class of bug as saving a version with the
    wrong macro terms: silent, and only visible in the number.
    """
    spec = spec or LGD.LgdSpec.default_for(portfolio)
    key = spec.hash()
    if key not in _LGD_CACHE:
        prev = runcache.load(spec.portfolio, "lgd", key)
        if prev is None:
            df = store.analysis_frame(spec.portfolio)
            prev = LGD.fit_lgd(df, spec, mevpanel.monthly_panel())
            runcache.save(spec.portfolio, "lgd", key, prev)
        _LGD_CACHE[key] = prev
    return _LGD_CACHE[key]


@dataclass
class Extrapolation:
    """How far a scenario pushes a variable beyond the range the model was fitted on."""
    key: str
    fitted_min: float
    fitted_max: float
    scenario_min: float
    scenario_max: float
    beyond_sd: float
    outside: bool
    note: str


def extrapolation_check(path: pd.DataFrame, keys: list[str], as_of: pd.Timestamp,
                        fit_from: str | pd.Timestamp = "2008-01-01") -> list[Extrapolation]:
    """A scenario that takes a driver outside its estimation window is the single
    most important caveat on a stress number, and almost nothing surfaces it.

    A logit is linear in the log-odds of its inputs. Inside the fitted range that
    is an empirical claim; outside it, it is pure extrapolation with no evidence
    behind it and no upper bound. On the old 2015-2025 panel the 2026 severely
    adverse scenario took commercial property growth to -24% year on year against
    a fitted floor of -10.7%, and the unconstrained model answered with a 33%
    cumulative default rate. Opening the panel in 2008 is what fixed that; this
    check stays because a future scenario can leave the window again, and a
    caveat has to be visible on the day it becomes true.
    """
    out: list[Extrapolation] = []
    for k in keys:
        if k not in path.columns:
            continue
        hist = path[k].loc[(path.index >= pd.Timestamp(fit_from)) & (path.index <= as_of)]
        fwd = path[k].loc[path.index > as_of]
        if hist.empty or fwd.empty:
            continue
        lo, hi = float(hist.min()), float(hist.max())
        sd = float(hist.std(ddof=0)) or 1.0
        smin, smax = float(fwd.min()), float(fwd.max())
        beyond = max((lo - smin) / sd, (smax - hi) / sd, 0.0)
        outside = smin < lo - 1e-9 or smax > hi + 1e-9
        note = ""
        if outside:
            note = (f"The scenario reaches {smin:.1f} to {smax:.1f} against a fitted "
                    f"range of {lo:.1f} to {hi:.1f} — {beyond:.1f} standard deviations "
                    f"beyond anything the model has seen. The response there is "
                    f"extrapolation, not evidence.")
        out.append(Extrapolation(k, lo, hi, smin, smax, beyond, outside, note))
    return out


def estimation_window(portfolio: str) -> pd.Timestamp:
    """The first month the model could have been estimated on.

    This used to be the literal string "2015-01-01" in two function signatures.
    When the panel moved back to 2008 the constant did not, so the extrapolation
    panel went on reporting a fitted house-price floor of -0.3% for a model that
    had by then been estimated straight through a -16% year. A hardcode that
    describes the data is a hardcode that goes stale silently.
    """
    return pd.Timestamp(store.analysis_frame(portfolio)["performance_date"].min())


def scenario_mev_path(name: str, as_of: pd.Timestamp,
                      custom: dict[str, dict[str, float]] | None = None,
                      cap_to_fitted_range: bool = False,
                      fit_from: str | pd.Timestamp = "2008-01-01") -> pd.DataFrame:
    """History spliced to the scenario's forward path, on the monthly grid.

    `custom` lets the scenario editor override individual variables: a mapping of
    variable -> {quarter -> value}. An overridden variable is spliced exactly like
    a published one, so a dragged path behaves the same as a supervisory one.
    """
    hist = mevpanel.monthly_panel()
    scenarios, _ = scen.load_all()
    if name not in scenarios:
        raise KeyError(f"unknown scenario {name!r}")
    q = scenarios[name].quarterly
    out = {}
    for key in PROJECTION_MEVS:
        if key not in hist.columns:
            continue
        base = key[:-4] if key.endswith("_yoy") else key
        if base not in q.columns:
            continue
        series_q = q[base]
        if custom and base in custom:
            series_q = series_q.copy()
            for when, val in custom[base].items():
                ts = pd.Timestamp(when)
                if ts in series_q.index:
                    series_q.loc[ts] = float(val)
        sp = scen.splice_variable(hist[base], series_q, base)
        out[base] = sp.monthly
    df = pd.DataFrame(out).sort_index()
    # rebuild the year-over-year forms on the SPLICED path, so the forward part of
    # a growth series reflects the scenario rather than history
    for key in list(df.columns):
        if f"{key}_yoy" in PROJECTION_MEVS:
            df[f"{key}_yoy"] = (df[key] / df[key].shift(12) - 1.0) * 100.0
    df = df.ffill().bfill()

    if cap_to_fitted_range:
        # Winsorize the FORWARD path to the range the model was fitted on. This is
        # standard practice and it is a real trade-off, so the UI states it: it
        # keeps the projection inside the evidence, and it also CAPS THE STRESS.
        # Both the capped and uncapped numbers are reported.
        fwd = df.index > as_of
        for k in df.columns:
            hist = df[k].loc[(df.index >= pd.Timestamp(fit_from)) & (df.index <= as_of)]
            if hist.empty:
                continue
            df.loc[fwd, k] = df.loc[fwd, k].clip(float(hist.min()), float(hist.max()))
    return df


@dataclass
class ScenarioRun:
    portfolio: str
    model_hash: str
    as_of: str
    horizon_months: int
    results: dict[str, ECL.EclResult] = field(default_factory=dict)
    bridge: list[BR.BridgeStep] = field(default_factory=list)
    bridge_reconciles: tuple[bool, float] = (True, 0.0)
    shapley: dict[str, float] = field(default_factory=dict)
    ead: EAD.EadAssumption | None = None
    lgd: LGD.LgdModel | None = None
    # The fitted PD model, so callers can check the specification that produced
    # these numbers without refitting it.
    pd_fit: object | None = None
    weights: dict[str, float] = field(default_factory=dict)
    weighted_ecl: float = 0.0
    timings: dict[str, float] = field(default_factory=dict)
    extrapolation: list = field(default_factory=list)
    #: ECL under the OPPOSITE capping choice, for comparison.
    alternative_ecl: dict[str, float] = field(default_factory=dict)
    capped: bool = False


def run(spec: ModelSpec, scenarios: list[str] | None = None,
        weights: dict[str, float] | None = None,
        custom: dict[str, dict[str, float]] | None = None,
        fixed_ccf: float | None = None, cpr: float = 0.0,
        # Off by default. Winsorizing the forward path is a defensible technique
        # On the CRE book it clips the Fed's commercial property fall from -24.1%
        # to whatever the panel's own floor is, which removes a large part of the
        # loss. A headline that says "severely adverse" while quietly running a
        # milder path reports the wrong figure.
        # The Fed's path is the default; the constrained view is one click away
        # and both figures are always reported.
        cap_to_fitted_range: bool = False,
        bridge_from: str = "baseline", bridge_to: str = "severely_adverse",
        force: bool = False) -> ScenarioRun:
    scenarios = scenarios or ["baseline", "severely_adverse"]
    key = (spec.hash(), tuple(scenarios), fixed_ccf, cpr, cap_to_fitted_range,
           tuple(sorted((k, tuple(sorted(v.items()))) for k, v in (custom or {}).items())))
    if not force and key in _ECL_CACHE:
        return _ECL_CACHE[key]
    if not force:
        # A projection computed in a previous process. The disk key carries
        # the data fingerprint, so a run projected on a superseded panel is
        # recomputed rather than served.
        prev = runcache.load(spec.portfolio, "ecl", _disk_key(key))
        if prev is not None:
            _ECL_CACHE[key] = prev
            return prev

    t = {}
    t0 = time.perf_counter()
    pd_run = modelsvc.run(spec)
    t["pd_model"] = time.perf_counter() - t0

    t1 = time.perf_counter()
    lg = lgd_model(spec.portfolio, spec.lgd)
    t["lgd_model"] = time.perf_counter() - t1

    df = store.analysis_frame(spec.portfolio)
    pf = store.load(spec.portfolio)
    ead_assumption = EAD.assumption_for(spec.portfolio, pf.spec.ead_method,
                                        pf.panel, cpr=cpr, fixed_ccf=fixed_ccf)
    as_of = df["performance_date"].max()
    fit_from = estimation_window(spec.portfolio)
    all_sc, _ = scen.load_all()
    horizon = all_sc[scenarios[0]].horizon_quarters * 3

    seg = {"consumer": "loan_purpose", "mortgage": "state",
           "cre": "property_type"}.get(spec.portfolio)

    t2 = time.perf_counter()
    results: dict[str, ECL.EclResult] = {}
    extrap: list[Extrapolation] = []
    alternative: dict[str, float] = {}
    # The check must cover EVERY macro variable that reaches a number, not just
    # the PD model's terms. Mortgage LGD takes hpi_yoy as a driver, so clipping
    # the house-price fall from -16.3% to -0.3% moved mortgage ECL from 181M to
    # 122M while the extrapolation panel reported nothing out of range — it was
    # only inspecting spec.mevs. Severity is where a housing stress actually
    # bites, so missing it is not a small omission.
    lgd_spec = spec.lgd or LGD.LgdSpec.default_for(spec.portfolio)
    lgd_macro = [c for c in lgd_spec.drivers if c in PROJECTION_MEVS]
    model_mevs = sorted({m.key for m in spec.mevs} | set(lgd_macro))
    for name in scenarios:
        if not extrap:
            extrap = extrapolation_check(
                scenario_mev_path(bridge_to, as_of, custom, fit_from=fit_from),
                model_mevs, as_of, fit_from=fit_from)
        path = scenario_mev_path(name, as_of, custom if name == bridge_to else None,
                                 cap_to_fitted_range=cap_to_fitted_range,
                                 fit_from=fit_from)
        results[name] = ECL.project(spec, pd_run.fit, df, path, lg, ead_assumption,
                                    name, horizon, as_of=as_of, segment_column=seg)
        # Always price the OTHER choice too, so the difference between the Fed's
        # path and a constrained one is on screen rather than implied.
        if any(e.outside for e in extrap):
            other = scenario_mev_path(name, as_of, custom if name == bridge_to else None,
                                      cap_to_fitted_range=not cap_to_fitted_range,
                                      fit_from=fit_from)
            alternative[name] = ECL.project(spec, pd_run.fit, df, other, lg,
                                            ead_assumption, name, horizon,
                                            as_of=as_of).ecl
    t["projection"] = time.perf_counter() - t2

    steps, recon, shap = [], (True, 0.0), {}
    if bridge_from in results and bridge_to in results:
        steps = BR.build_bridge(results[bridge_from].components,
                                results[bridge_to].components,
                                base_label=all_sc[bridge_from].label,
                                stress_label=all_sc[bridge_to].label)
        recon = BR.reconciles(steps)
        shap = BR.contributions_shapley(results[bridge_from].components,
                                        results[bridge_to].components)

    # A CECL weighting is a management assumption, not a supervisory number, and
    # the editor exposes it. This default leans on the baseline the way a
    # practitioner would and keeps a real tail weight rather than a token one.
    w = weights or {"baseline": 0.75, "severely_adverse": 0.25}
    tot = sum(w.get(k, 0.0) for k in results) or 1.0
    weighted = sum(results[k].ecl * w.get(k, 0.0) for k in results) / tot
    t["total"] = time.perf_counter() - t0

    out = ScenarioRun(
        portfolio=spec.portfolio, model_hash=spec.hash(),
        as_of=as_of.strftime("%Y-%m-%d"), horizon_months=horizon,
        results=results, bridge=steps, bridge_reconciles=recon, shapley=shap,
        ead=ead_assumption, lgd=lg, pd_fit=pd_run.fit,
        weights={k: w.get(k, 0.0) / tot for k in results}, weighted_ecl=weighted,
        timings={k: round(v, 2) for k, v in t.items()},
        extrapolation=extrap, alternative_ecl=alternative,
        capped=cap_to_fitted_range,
    )
    if len(_ECL_CACHE) > 12:
        _ECL_CACHE.pop(next(iter(_ECL_CACHE)))
    _ECL_CACHE[key] = out
    runcache.save(spec.portfolio, "ecl", _disk_key(key), out)
    return out


def clear() -> None:
    _LGD_CACHE.clear()
    _ECL_CACHE.clear()


store.register_dependent_cache(clear)
