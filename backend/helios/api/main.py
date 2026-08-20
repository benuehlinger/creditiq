"""Helios API.

Runs entirely offline against the committed FRED cache and the generated panels.
No key, no network, no configuration.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .. import store
from ..analysis import profile as prof
from ..analysis.rates import annualize
from ..data.build import PLANTED_NOTES
from ..data.portfolios import PORTFOLIOS
from ..mev import panel as mev_panel
from ..mev import scenarios as scen
from ..mev.registry import PORTFOLIO_MEVS, by_key

app = FastAPI(title="Helios", version="0.1.0",
              description="Credit risk model development platform")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])

ROOT = Path(__file__).resolve().parents[3]


def _jsonable(o):
    """pandas and numpy types do not serialise. Normalise once, here.

    NaN and infinity are the trap. They are legitimate results — an empty bin has
    an undefined event rate, a degenerate PSI is infinite — but `json.dumps`
    emits bare `NaN`, which is not valid JSON and which FastAPI rejects with a
    500. They become `null`, which the frontend already renders as an em dash.
    Plain Python floats need this as much as numpy ones do; handling only
    `np.floating` was the original bug.
    """
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        v = float(o)
        return None if (np.isnan(v) or np.isinf(v)) else v
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp,)):
        return o.strftime("%Y-%m-%d")
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    return o


# ── system ───────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    man = mev_panel.manifest()
    return {
        "status": "ok",
        "offline_capable": True,
        "portfolios": store.available(),
        "mev_series_resolved": man["n_resolved"],
        "mev_series_failed": man["n_failed"],
        "mev_cache_built_at": man["built_at"],
    }


# ── portfolios ───────────────────────────────────────────────────────────────
@app.get("/api/portfolios")
def portfolios():
    out = []
    for key in store.available():
        pf = store.load(key)
        s, p = pf.spec, pf.panel
        out.append(_jsonable({
            "key": key, "label": s.label, "accent_slot": s.accent_slot,
            "n_accounts": len(pf.accounts), "n_rows": len(p),
            "n_defaults": int(p[s.target.column].sum()),
            "annual_default_rate_pct": round(float(annualize(p[s.target.column].mean())), 3),
            "window": [p["performance_date"].min(), p["performance_date"].max()],
            "target": {"column": s.target.column, "label": s.target.label,
                       "description": s.target.description},
            "ead_method": s.ead_method, "ead_note": s.ead_note,
            "mev_keys": PORTFOLIO_MEVS.get(key, s.mev_keys),
            "drivers": sorted(set(s.numeric_betas) | set(s.observed_aliases.values())
                              - set(s.observed_aliases)),
            "categorical_drivers": list(s.categorical_betas),
            "expected_signs": s.expected_signs,
        }))
    return out


@app.get("/api/portfolios/{key}/health")
def portfolio_health(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    pf = store.load(key)
    df = store.analysis_frame(key)
    issues = prof.check_integrity(pf.panel, pf.spec)
    cols = prof.profile_columns(df, pf.spec, notes=PLANTED_NOTES)
    return _jsonable({
        "portfolio": key, "n_rows": len(df), "n_accounts": len(pf.accounts),
        "n_columns": len(df.columns), "score": prof.health_score(issues),
        "issues": issues, "columns": cols,
    })


@app.get("/api/portfolios/{key}/timeseries")
def portfolio_timeseries(key: str, by: str | None = Query(None)):
    """Default rate and exposure by performance date, optionally split by a
    categorical column. The headline chart on the Data surface."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df = store.analysis_frame(key)
    tgt = store.load(key).spec.target.column
    if by:
        if by not in df.columns:
            raise HTTPException(400, f"unknown column {by!r}")
        g = df.groupby([df["performance_date"], df[by].astype(str)])
    else:
        g = df.groupby(df["performance_date"])
    agg = g.agg(observations=(tgt, "size"), defaults=(tgt, "sum"),
                balance=("current_balance", "sum")).reset_index()
    agg["annual_default_rate_pct"] = annualize(agg["defaults"] / agg["observations"])
    agg = agg.rename(columns={by: "series"} if by else {})
    agg["performance_date"] = agg["performance_date"].dt.strftime("%Y-%m-%d")
    return _jsonable(agg.to_dict("records"))


@app.get("/api/portfolios/{key}/sample")
def portfolio_sample(key: str, limit: int = 200, offset: int = 0):
    df = store.analysis_frame(key)
    sub = df.iloc[offset:offset + min(limit, 2000)].copy()
    for c in sub.columns:
        if pd.api.types.is_datetime64_any_dtype(sub[c]):
            sub[c] = sub[c].dt.strftime("%Y-%m-%d")
        elif str(sub[c].dtype) == "category":
            sub[c] = sub[c].astype(str)
    return _jsonable({"total": len(df), "columns": list(sub.columns),
                      "rows": sub.where(pd.notna(sub), None).to_dict("records")})


# ── macro ────────────────────────────────────────────────────────────────────
@app.get("/api/mev/catalog")
def mev_catalog():
    man = mev_panel.manifest()
    status = {r["key"]: r for r in man["series"]}
    out = []
    for key, m in by_key().items():
        r = status.get(key, {})
        out.append(_jsonable({
            **m.to_dict(), "resolved_series_id": r.get("series_id", m.series_id),
            "substituted": bool(r.get("substituted", False)),
            "first": r.get("first"), "last": r.get("last"),
            "status": r.get("status", "unknown"),
        }))
    return {
        "why_restricted": (
            "The catalog is restricted to the Federal Reserve supervisory (CCAR) "
            "variables because they are the only macroeconomic variables with "
            "publicly published FORWARD paths. A variable with no forward path "
            "cannot condition a scenario projection, however predictive it is "
            "in sample."),
        "built_at": man["built_at"], "variables": out,
        "by_portfolio": PORTFOLIO_MEVS,
    }


@app.get("/api/mev/series")
def mev_series(keys: str = Query(...), start: str | None = None,
               end: str | None = None):
    ks = [k.strip() for k in keys.split(",") if k.strip()]
    df = mev_panel.panel_for(ks, start=start, end=end)
    df = df.reset_index()
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    return _jsonable({"keys": ks, "rows": df.where(pd.notna(df), None).to_dict("records")})


@app.get("/api/scenarios")
def scenarios():
    sc, warns = scen.load_all()
    return _jsonable({
        "warnings": warns,
        "scenarios": [{
            "key": s.key, "label": s.label, "published": s.published,
            "source": s.source, "note": s.note,
            "horizon_quarters": s.horizon_quarters,
            "variables": list(s.quarterly.columns),
            "start": s.quarterly.index.min(), "end": s.quarterly.index.max(),
        } for s in sc.values()],
    })


@app.get("/api/scenarios/{name}/spliced")
def scenario_spliced(name: str, keys: str = Query(...), history_from: str = "2015-01-01"):
    """History joined to the forward path, with the seam reported, not hidden."""
    sc, _ = scen.load_all()
    if name not in sc:
        raise HTTPException(404, f"unknown scenario {name!r}")
    hist = mev_panel.monthly_panel()
    out = {}
    for k in [x.strip() for x in keys.split(",") if x.strip()]:
        if k not in hist.columns or k not in sc[name].quarterly.columns:
            continue
        sp = scen.splice_variable(hist[k], sc[name].quarterly[k], k)
        s = sp.monthly.loc[sp.monthly.index >= pd.Timestamp(history_from)]
        out[k] = {
            "splice_date": sp.splice_date, "rule": sp.shift_kind,
            "shift": sp.shift, "last_actual": sp.last_actual,
            "scenario_raw_first": sp.first_scenario_raw,
            "points": [{"date": d, "value": v, "projected": d >= sp.splice_date}
                       for d, v in s.items()],
        }
    return _jsonable({"scenario": name, "published": sc[name].published,
                      "series": out})


@app.get("/api/design/tokens")
def design_tokens():
    """The validated palette, served so the frontend cannot drift from it."""
    return json.loads((ROOT / "frontend" / "src" / "design" / "tokens.json").read_text())


# ── explore ──────────────────────────────────────────────────────────────────
from functools import lru_cache                                        # noqa: E402

from ..analysis import binning as binmod                               # noqa: E402


def binmod_knots(x, n_knots: int) -> list[float]:
    """Knot positions for the spline treatment, from the variable's own quantiles."""
    from ..models.design import quantile_knots
    v = pd.to_numeric(x, errors="coerce").dropna().to_numpy(float)
    return quantile_knots(v, max(1, min(n_knots, 10)))
from ..analysis import screening as screen                             # noqa: E402

# Columns never offered as model inputs. Identifiers and dates are not
# predictors, and the outcome columns ARE the answer.
NEVER_SCREEN = {
    "account_id", "performance_date", "origination_date", "default_flag",
    "recovery_amount", "loss_amount", "exposure_at_default", "lgd_realised",
    "workout_months", "terminal_event", "status",
}


def _candidates(key: str) -> list[str]:
    df = store.analysis_frame(key)
    out = []
    for c in df.columns:
        if c in NEVER_SCREEN or c.startswith("_"):
            continue
        if df[c].nunique(dropna=True) < 2:
            continue
        out.append(c)
    return out


@lru_cache(maxsize=8)
def _screen_all(key: str) -> dict:
    df, sampled = store.screening_frame(key)
    spec = PORTFOLIOS[key]
    y = df[spec.target.column]
    # One null floor per SHAPE, shared across columns of that shape. Estimating
    # it per column costs a permutation binning run each and takes ~48s to screen
    # a book — not a thing anyone waits for in a meeting.
    # Two floors: one numeric, one categorical.
    #
    # Cardinality was banded here at first, on the assumption that a 144-level
    # variable must score far higher by chance than a 3-level one. Measured, it
    # barely does — because the population floor COLLAPSES the tail before the
    # information value is computed, so a wide variable and a narrow one both
    # arrive at the statistic with a similar number of surviving bins. The
    # collapse is what removes the free pass, not the floor.
    #
    # The categorical probe is drawn at the widest cardinality in the book, with
    # a realistic concentration, so the floor is the conservative one.
    widest = max((int(df[c].nunique(dropna=True)) for c in _candidates(key)
                  if not (pd.api.types.is_numeric_dtype(df[c])
                          and df[c].nunique(dropna=True) > 12)), default=10)
    floors = {
        "numeric": binmod.null_floor_for_shape(y, "numeric"),
        "categorical": binmod.null_floor_for_shape(y, "categorical",
                                                   n_levels=min(widest, 150)),
    }
    rows = []
    for c in _candidates(key):
        try:
            numeric = (pd.api.types.is_numeric_dtype(df[c])
                       and df[c].nunique(dropna=True) > 12)
            sc, _ = screen.screen_column(
                df[c], y, expected=spec.expected_signs.get(c),
                null_floor=floors["numeric" if numeric else "categorical"])
            rows.append(sc.__dict__)
        except Exception as e:                                          # noqa: BLE001
            rows.append({"column": c, "error": f"{type(e).__name__}: {e}", "iv": 0.0})
    rows.sort(key=lambda r: -(r.get("iv") or 0))
    return {"sampled": sampled, "n_rows": len(df), "rows": rows, "floors": floors}


@app.get("/api/portfolios/{key}/screen")
def screen_variables(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    res = _screen_all(key)
    return _jsonable({
        **res,
        "bands": [{"upto": b[0] if b[0] != float("inf") else None, "label": b[1]}
                  for b in screen.IV_BANDS],
        "null_note": (
            "The information-value null floor is the score a variable with NO "
            "relationship to the target would reach on this sample, estimated by "
            "permutation. It is above the textbook 0.02 threshold because the "
            "procedure being measured optimally bins against the target, so the "
            "floor prices in the binning step's own overfitting. It is estimated "
            "once per data type, not per column."),
        "sample_note": (
            f"Screened on {res['n_rows']:,} account-months"
            + (" — a deterministic, event-preserving subsample. Every default is "
               "kept and only non-events are thinned, so no rare target is made "
               "rarer. Final model fits use the full panel."
               if res["sampled"] else " — the full panel.")),
    })


@app.get("/api/portfolios/{key}/binning/{column}")
def binning(key: str, column: str, edges: str | None = None, max_bins: int = 8,
            monotone: bool = True, n_knots: int = 4):
    """Bin a variable. Pass `edges` as a comma-separated list to override the
    optimal edges — this is what the drag interaction in the editor sends."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df, sampled = store.screening_frame(key)
    if column not in df.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    y = df[PORTFOLIOS[key].target.column]
    x = df[column]
    use_numeric = pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > 12
    if use_numeric:
        ed = [float(e) for e in edges.split(",") if e.strip()] if edges else None
        b = binmod.bin_numeric(x, y, edges=ed, max_bins=max_bins, monotone=monotone)
    else:
        b = binmod.bin_categorical(x, y)
    lift, where = screen.max_bin_lift(b)
    risk, reason, _ = screen.leakage_verdict(b)
    # The editor needs a drawing domain. p1-p99 rather than min-max: one planted
    # impossible value (a DTI of 900) would otherwise compress the whole axis into
    # the left two pixels and make the drag interaction useless.
    domain = None
    hist = None
    if use_numeric:
        v = pd.to_numeric(x, errors="coerce").dropna()
        lo, hi = (float(np.nanpercentile(v, 1)), float(np.nanpercentile(v, 99)))
        if hi <= lo:
            lo, hi = float(v.min()), float(v.max()) or lo + 1
        domain = [lo, hi]
        counts, bounds = np.histogram(v.clip(lo, hi), bins=48, range=(lo, hi))
        hist = {"bounds": [float(z) for z in bounds],
                "counts": [int(z) for z in counts]}
    # What each treatment would cost in columns, so the UI never has to guess.
    n_real = len([z for z in b.bins if not z.is_special])
    n_special = len([z for z in b.bins if z.is_special and z.count > 0])
    knot_positions = binmod_knots(df[column], n_knots) if use_numeric else []
    costs = {
        "woe": 1,
        "bins": max(n_real - 1, 0) + n_special,
        "continuous": 1 if use_numeric else None,
        # a spline costs one column per knot plus the linear term
        "spline": len(knot_positions) + 1 if use_numeric else None,
    }
    return _jsonable({
        **b.to_dict(), "sampled": sampled, "domain": domain, "histogram": hist,
        "column_costs": costs, "supports_continuous": bool(use_numeric),
        "shape": binmod.shape_diagnostic(b),
        "knots": knot_positions,
        "n_knots": n_knots,
        "max_bin_lift": lift, "max_lift_bin": where,
        "leakage_risk": risk, "leakage_reason": reason,
        "expected_sign": PORTFOLIOS[key].expected_signs.get(column),
        "observed_sign": screen.observed_sign(b),
    })


@app.get("/api/portfolios/{key}/bivariate/{column}")
def bivariate(key: str, column: str, edges: str | None = None, freq: str = "QS"):
    """Event rate over time BY BIN. Shows whether a variable's relationship with
    the target is stable, which a single-period bad-rate chart cannot."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df, _ = store.screening_frame(key)
    if column not in df.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    tgt = PORTFOLIOS[key].target.column
    x, y = df[column], df[tgt]
    numeric = pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > 12
    if numeric:
        ed = [float(e) for e in edges.split(",") if e.strip()] if edges else None
        b = binmod.bin_numeric(x, y, edges=ed)
        cuts = [-np.inf, *(b.edges or []), np.inf]
        idx = pd.Series(np.digitize(x.fillna(-np.inf), b.edges or []), index=x.index)
        idx[x.isna()] = -1
        names = {i: bn.label for i, bn in enumerate([z for z in b.bins if not z.is_special])}
        names[-1] = "Missing"
        label = idx.map(names)
    else:
        b = binmod.bin_categorical(x, y)
        lookup = {str(v): bn.label for bn in b.bins if bn.levels for v in bn.levels}
        label = x.astype(str).map(lookup).fillna("Missing")
    g = (pd.DataFrame({"p": df["performance_date"], "b": label, "y": y})
         .groupby([pd.Grouper(key="p", freq=freq), "b"])["y"]
         .agg(["size", "sum"]).reset_index())
    # Drop cells too small to estimate a rate from. At 30 account-months a single
    # default reads as a 40% annualized rate and eight read as 320%, which
    # dominates the chart and hides the pattern the reader came for. 250 caps the
    # single-default artefact near 5%.
    g = g[g["size"] >= 250]
    g["rate"] = annualize(g["sum"] / g["size"])
    g["p"] = g["p"].dt.strftime("%Y-%m-%d")
    return _jsonable({
        "column": column, "bins": [bn.label for bn in b.bins],
        "points": g.rename(columns={"p": "period", "b": "bin", "size": "n"})
                   .to_dict("records"),
    })


@app.get("/api/portfolios/{key}/psi/{column}")
def psi_series(key: str, column: str):
    df, _ = store.screening_frame(key)
    if column not in df.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    return _jsonable({"column": column, "points": screen.psi_over_time(df, column)})


@app.get("/api/portfolios/{key}/correlation")
def correlation(key: str, columns: str | None = None, method: str = "pearson"):
    df, _ = store.screening_frame(key)
    cols = ([c.strip() for c in columns.split(",")] if columns
            else [c for c in _candidates(key)
                  if pd.api.types.is_numeric_dtype(df[c]) and df[c].nunique() > 5])
    cols = [c for c in cols if c in df.columns][:40]
    ivs = {r["column"]: r.get("iv", 0.0) for r in _screen_all(key)["rows"]}
    return _jsonable({
        **screen.correlation(df, cols, method),
        "high_pairs": screen.high_correlation_pairs(df, cols, 0.90),
        "clusters": screen.cluster_representatives(df, cols, ivs),
    })


@app.get("/api/portfolios/{key}/vif")
def vif_for(key: str, columns: str = Query(...)):
    df, _ = store.screening_frame(key)
    cols = [c.strip() for c in columns.split(",") if c.strip() and c.strip() in df.columns]
    numeric = [c for c in cols if pd.api.types.is_numeric_dtype(df[c])]
    return _jsonable({"vif": screen.vif(df, numeric),
                      "skipped": [c for c in cols if c not in numeric]})


@app.on_event("startup")
def _warm() -> None:
    """Warm the caches in the background so the first click of a demo is instant.

    Screening a book takes a few seconds. Paying that while a client watches is
    the difference between a product and a prototype, so it is paid at boot.
    """
    import threading

    def run():
        for k in store.available():
            try:
                store.analysis_frame(k)
                _screen_all(k)
            except Exception:                                           # noqa: BLE001
                pass                                    # a warm-up failure is not fatal
        try:
            mev_panel.monthly_panel()
            scen.load_all()
        except Exception:                                               # noqa: BLE001
            pass

    threading.Thread(target=run, daemon=True).start()


# ── model ────────────────────────────────────────────────────────────────────
from pydantic import BaseModel                                          # noqa: E402

from ..models import service as modelsvc                                # noqa: E402
from ..models.naming import friendly_name                               # noqa: E402
from ..models.spec import MevSpec, ModelSpec, SampleSpec, VariableSpec  # noqa: E402


class FitRequest(BaseModel):
    portfolio: str
    variables: list[dict] = []
    mevs: list[dict] = []
    estimator: str = "logistic"
    regularization: float = 1.0
    seasoning_spline: bool = True
    vintage_effect: bool = False
    test_fraction: float = 0.30
    oot_from: str = "2023-01-01"
    downsample_rows: int | None = None
    label: str | None = None
    parent_hash: str | None = None

    def to_spec(self) -> ModelSpec:
        return ModelSpec(
            portfolio=self.portfolio,
            variables=[VariableSpec(**v) for v in self.variables],
            mevs=[MevSpec(**m) for m in self.mevs],
            estimator=self.estimator,                    # type: ignore[arg-type]
            regularization=self.regularization,
            seasoning_spline=self.seasoning_spline,
            vintage_effect=self.vintage_effect,
            sample=SampleSpec(test_fraction=self.test_fraction, oot_from=self.oot_from,
                              downsample_rows=self.downsample_rows),
            target_column=PORTFOLIOS[self.portfolio].target.column,
            label=self.label, parent_hash=self.parent_hash,
        )


def _sign_checks(r) -> list[dict]:
    """Compare each MACRO coefficient's fitted sign with its economic prior.

    This is where a sign constraint is actually meaningful. A WoE-transformed
    driver always enters positively when it agrees with the data — the weight of
    evidence carries the direction — so the prior is checked at the bin level on
    the Explore surface. A macro term enters RAW, so its sign is a direct
    economic claim and a flip is a real finding.

    A flip is usually collinearity rather than a broken model, and the message
    says so: on the mortgage book, current LTV is computed FROM the house-price
    path, so once it is in the specification the residual HPI growth term picks
    up a vintage confound and fits positive. The platform flags it; the analyst
    decides whether to drop the term, lag it, or drop current LTV instead.
    """
    spec = PORTFOLIOS[r.spec.portfolio]
    out = []
    for c in r.fit.coefficients:
        if not c.name.startswith("mev:"):
            continue
        key = c.name[4:].split(" ")[0]
        expected = spec.expected_signs.get(key)
        if expected is None:
            continue
        observed = 1 if c.estimate > 0 else -1
        ok = observed == expected
        out.append({
            "term": c.name, "mev": key, "expected_sign": expected,
            "observed_sign": observed, "coefficient": c.estimate,
            "z_stat": c.z_stat, "ok": ok, "significant": c.p_value < 0.05,
            "message": "" if ok else (
                f"{key} fits {c.estimate:+.4f}, but the economic prior is "
                f"{'positive' if expected > 0 else 'negative'}. A flip on a macro "
                f"term is nearly always collinearity with a driver that already "
                f"carries the same effect — check whether another variable in the "
                f"specification is derived from this one."),
        })
    return out


def _run_payload(r) -> dict:
    spec = PORTFOLIOS[r.spec.portfolio]
    return {
        "hash": r.hash, "name": r.name, "created_at": r.created_at,
        "portfolio": r.spec.portfolio,
        "spec": r.spec.to_dict(),
        "converged": r.fit.converged, "iterations": r.fit.iterations,
        "separation_warning": r.fit.separation_warning,
        "n_train": r.fit.n_train, "n_events_train": r.fit.n_events_train,
        "slices": r.slices, "n_full": r.n_full, "downsampled": r.downsampled,
        "timings": r.timings,
        "coefficients": [c.__dict__ for c in r.fit.coefficients],
        "diagnostics": r.diagnostics,
        "backtest": r.backtest,
        "scorecard": r.scorecard,
        "target": {"column": spec.target.column, "label": spec.target.label,
                   "description": spec.target.description},
        "ead": {"method": spec.ead_method, "note": spec.ead_note},
        "expected_signs": spec.expected_signs,
        "sign_checks": _sign_checks(r),
        "woe_maps": {k: {kk: vv for kk, vv in v.items() if kk != "map"}
                     for k, v in r.fit.woe_maps.items()},
        "performance_note": (
            f"Fitted and backtested in {r.timings.get('total', 0):.1f} seconds on "
            f"{r.n_full:,} account-months."
            + (f" The FIT sample was thinned to {r.spec.sample.downsample_rows:,} rows "
               f"(every default kept, non-events thinned, intercept prior-corrected); "
               f"scoring, diagnostics and backtesting still use every row."
               if r.downsampled else
               " No downsampling — every account-month was used for the fit.")),
    }


@app.post("/api/fit")
def fit_model(req: FitRequest):
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    if not req.variables:
        raise HTTPException(400, "select at least one variable")
    try:
        r = modelsvc.run(req.to_spec())
    except Exception as e:                                              # noqa: BLE001
        raise HTTPException(400, f"{type(e).__name__}: {e}") from e
    return _jsonable(_run_payload(r))


@app.get("/api/models/{hash_}")
def get_model(hash_: str):
    r = modelsvc.cached(hash_)
    if r is None:
        raise HTTPException(404, "not in cache — refit from the specification")
    return _jsonable(_run_payload(r))


@app.get("/api/name/{hash_}")
def name_for(hash_: str):
    return {"hash": hash_, "name": friendly_name(hash_)}


@app.post("/api/segment-backtest")
def segment_backtest(portfolio: str, hash_: str, column: str):
    r = modelsvc.cached(hash_)
    if r is None:
        raise HTTPException(404, "not in cache")
    from ..models import backtest as bt
    df = store.analysis_frame(portfolio)
    if column not in df.columns:
        raise HTTPException(400, f"unknown column {column!r}")
    # rescore rather than store a 1.7M-row vector per cached model
    from ..models import design as dz
    from ..models.fit import predict as pr
    des = dz.build(df, r.spec, woe_maps=r.fit.woe_maps, means=r.fit.means,
                   stds=r.fit.stds, basis_maps=r.fit.basis_maps)
    p = pr(des.X, r.fit.beta)
    return _jsonable({"column": column,
                      "segments": bt.segment_backtest(df, des.y, p, column)})


# ── scenarios and ECL ────────────────────────────────────────────────────────
from ..models import scenario_service as scensvc                        # noqa: E402


class EclRequest(FitRequest):
    scenarios: list[str] = ["baseline", "adverse", "severely_adverse"]
    weights: dict[str, float] | None = None
    custom: dict[str, dict[str, float]] | None = None
    fixed_ccf: float | None = None
    cpr: float = 0.0
    cap_to_fitted_range: bool = True
    bridge_from: str = "baseline"
    bridge_to: str = "severely_adverse"


@app.post("/api/ecl")
def project_ecl(req: EclRequest):
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    if not req.variables:
        raise HTTPException(400, "select at least one variable")
    try:
        r = scensvc.run(req.to_spec(), scenarios=req.scenarios, weights=req.weights,
                        custom=req.custom, fixed_ccf=req.fixed_ccf, cpr=req.cpr,
                        cap_to_fitted_range=req.cap_to_fitted_range,
                        bridge_from=req.bridge_from, bridge_to=req.bridge_to)
    except Exception as e:                                              # noqa: BLE001
        raise HTTPException(400, f"{type(e).__name__}: {e}") from e

    sc_meta, _ = scen.load_all()
    return _jsonable({
        "portfolio": r.portfolio, "model_hash": r.model_hash, "as_of": r.as_of,
        "horizon_months": r.horizon_months, "timings": r.timings,
        "capped": r.capped,
        "scenarios": [{
            "key": k, "label": sc_meta[k].label, "published": sc_meta[k].published,
            "source": sc_meta[k].source, "note": sc_meta[k].note,
            "n_accounts": v.n_accounts, "exposure": v.total_exposure,
            "ecl": v.ecl, "ecl_bps": v.ecl_bps,
            "weighted_pd_12m": v.weighted_pd_12m, "weighted_lgd": v.weighted_lgd,
            "monthly": v.monthly, "by_segment": v.by_segment, "ifrs9": v.ifrs9,
            "uncapped_ecl": r.uncapped_ecl.get(k),
        } for k, v in r.results.items()],
        "weights": r.weights, "weighted_ecl": r.weighted_ecl,
        "bridge": [{"label": s.label, "value": s.value, "running": s.running,
                    "kind": s.kind, "note": s.note} for s in r.bridge],
        "bridge_reconciles": {"ok": r.bridge_reconciles[0],
                              "residual": r.bridge_reconciles[1]},
        "shapley": r.shapley,
        "extrapolation": [e.__dict__ for e in r.extrapolation],
        "ead": {"method": r.ead.method, "plain_english": r.ead.plain_english,
                "parameters": r.ead.parameters, "estimated_ccf": r.ead.estimated_ccf,
                "ccf_sample": r.ead.ccf_sample, "ccf_note": r.ead.ccf_note},
        "lgd": {"n_defaults": r.lgd.n_defaults, "mean_lgd": r.lgd.mean_lgd,
                "zero_loss_share": r.lgd.zero_loss_share,
                "mean_severity_given_loss": r.lgd.mean_severity_given_loss,
                "mean_workout_months": r.lgd.mean_workout_months,
                "calibration": r.lgd.calibration, "note": r.lgd.fit_note,
                "drivers": scensvc.LGD.LGD_DRIVERS.get(r.portfolio, [])},
    })


@app.get("/api/scenarios/{name}/editable")
def editable_scenario(name: str, keys: str = Query(...)):
    """The quarterly points the scenario editor lets a user drag."""
    sc, _ = scen.load_all()
    if name not in sc:
        raise HTTPException(404, f"unknown scenario {name!r}")
    q = sc[name].quarterly
    out = {}
    for k in [x.strip() for x in keys.split(",") if x.strip()]:
        base = k[:-4] if k.endswith("_yoy") else k
        if base in q.columns:
            out[base] = [{"quarter": d.strftime("%Y-%m-%d"), "value": float(v)}
                         for d, v in q[base].items()]
    return _jsonable({"scenario": name, "published": sc[name].published,
                      "note": sc[name].note, "series": out})


# ── versions ─────────────────────────────────────────────────────────────────
from ..models import versions as vstore                                 # noqa: E402


class SaveVersionRequest(EclRequest):
    notes: str = ""
    tags: list[str] = []
    with_ecl: bool = False


def _metrics_for(r) -> dict:
    d = r.diagnostics
    cal = d.get("calibration", {}).get("bins", [])
    err = (sum(abs(b["predicted"] - b["observed"]) for b in cal) / len(cal)) if cal else None
    return {
        "auc_test": (d.get("test") or {}).get("auc"),
        "auc_oot": (d.get("oot") or {}).get("auc"),
        "ks_test": (d.get("test") or {}).get("ks"),
        "gini_test": (d.get("test") or {}).get("gini"),
        "log_loss_test": (d.get("test") or {}).get("log_loss"),
        "brier_test": (d.get("test") or {}).get("brier"),
        "calibration_error": err,
        "mcfadden_r2": d.get("mcfadden_r2"),
        "n_variables": len(r.spec.variables),
        "n_mevs": len(r.spec.mevs),
        "estimator": r.spec.estimator,
        "coefficients": {c.name: c.estimate for c in r.fit.coefficients},
    }


@app.post("/api/versions")
def save_version(req: SaveVersionRequest):
    spec = req.to_spec()
    run = modelsvc.run(spec)
    ecl_summary: dict = {}
    if req.with_ecl:
        try:
            sr = scensvc.run(spec, cap_to_fitted_range=req.cap_to_fitted_range)
            ecl_summary = {f"ecl_{k}": v.ecl for k, v in sr.results.items()}
            ecl_summary |= {f"ecl_bps_{k}": v.ecl_bps for k, v in sr.results.items()}
            ecl_summary["weighted_ecl"] = sr.weighted_ecl
        except Exception as e:                                          # noqa: BLE001
            ecl_summary = {"error": f"{type(e).__name__}: {e}"}
    v = vstore.save(spec, _metrics_for(run), ecl_summary, label=req.label,
                    notes=req.notes, tags=req.tags, parent_hash=req.parent_hash)
    return _jsonable(v.to_dict())


@app.get("/api/versions")
def list_versions(portfolio: str | None = None):
    return _jsonable([v.to_dict() for v in vstore.list_all(portfolio)])


@app.get("/api/versions/compare")
def compare_versions(hashes: str = Query(...)):
    hs = [h.strip() for h in hashes.split(",") if h.strip()][:4]
    if len(hs) < 2:
        raise HTTPException(400, "select at least two versions to compare")
    return _jsonable(vstore.compare(hs))


@app.get("/api/versions/lineage")
def version_lineage(portfolio: str = Query(...)):
    return _jsonable(vstore.lineage(portfolio))


@app.patch("/api/versions/{hash_}")
def patch_version(hash_: str, name: str | None = None, notes: str | None = None,
                  starred: bool | None = None, status: str | None = None):
    v = vstore.update(hash_, name=name, notes=notes, starred=starred, status=status)
    if v is None:
        raise HTTPException(404, "unknown version")
    return _jsonable(v.to_dict())


@app.post("/api/versions/{hash_}/promote")
def promote_version(hash_: str):
    v = vstore.promote(hash_)
    if v is None:
        raise HTTPException(404, "unknown version")
    return _jsonable(v.to_dict())


@app.delete("/api/versions/{hash_}")
def delete_version(hash_: str):
    return {"deleted": vstore.delete(hash_)}


@app.get("/api/versions/{hash_}/export")
def export_version(hash_: str):
    v = vstore.load(hash_)
    if v is None:
        raise HTTPException(404, "unknown version")
    return _jsonable(v.to_dict())


@app.post("/api/versions/import")
def import_version(payload: dict):
    """Re-run an imported configuration and confirm it reproduces.

    This is the reproducibility claim, checked rather than asserted: the imported
    spec is refitted from scratch and the metrics are compared with the ones
    stored in the file.
    """
    try:
        spec = ModelSpec.from_dict(payload["spec"])
    except Exception as e:                                              # noqa: BLE001
        raise HTTPException(400, f"not a valid version file: {e}") from e
    run = modelsvc.run(spec)
    fresh = _metrics_for(run)
    stored = payload.get("metrics", {})
    checks = []
    for k in ("auc_test", "auc_oot", "ks_test", "gini_test"):
        a, b = stored.get(k), fresh.get(k)
        if a is None or b is None:
            continue
        checks.append({"metric": k, "stored": a, "refitted": b,
                       "matches": abs(a - b) < 1e-9})
    v = vstore.save(spec, fresh, payload.get("ecl", {}),
                    label=payload.get("name"), notes=payload.get("notes", ""),
                    tags=payload.get("tags", []),
                    parent_hash=payload.get("parent_hash"))
    return _jsonable({
        "version": v.to_dict(), "reproduction_checks": checks,
        "reproduced": all(c["matches"] for c in checks) if checks else None,
        "hash_matches": payload.get("hash") == v.hash,
    })


# ── roll-up ──────────────────────────────────────────────────────────────────
from ..models import rollup as rollupsvc                                # noqa: E402


@app.get("/api/rollup")
def rollup(tornado: bool = True):
    r = rollupsvc.run(with_tornado=tornado)
    champs = {p: vstore.champion(p) for p in store.available()}
    return _jsonable({
        "scenarios": r.scenarios, "portfolios": r.portfolios, "totals": r.totals,
        "monthly": r.monthly, "tornado": r.tornado,
        "concentration": r.concentration, "timings": r.timings,
        "champions": {k: (v.to_dict() if v else None) for k, v in champs.items()},
        "note": ("Each book is projected with its promoted champion model where one "
                 "exists, and with a documented default specification where none "
                 "does. The source is shown per portfolio."),
    })


@app.get("/api/mev/reconciliation/{key}")
def mev_reconciliation(key: str):
    """Show the frequency conversion, rather than burying it.

    Raw published points overlaid on the derived monthly series, with the
    benchmarking residual. If the method is right this residual is zero to machine
    precision, and being able to point at that is worth more than asserting it.
    """
    from ..mev import reconcile as rc
    catalog = by_key()
    if key not in catalog:
        raise HTTPException(404, f"unknown variable {key!r}")
    mev = catalog[key]
    hist = pd.read_parquet(mev_panel.CACHE_DIR / "fred_history.parquet")
    hist["date"] = pd.to_datetime(hist["date"])
    raw = hist.loc[hist["key"] == key].set_index("date")["value"].sort_index()
    monthly = mev_panel.monthly_panel()
    col = f"{key}_level" if f"{key}_level" in monthly.columns else key
    derived = monthly[col].dropna()

    agg = mev.agg if mev.agg != "max" else "eop"
    residual = None
    identity = None
    # Compare like with like. Where FRED publishes GROWTH and the app reconstructs
    # a LEVEL — the BIS commercial property series — the benchmark target is the
    # reconstructed quarterly level, not the published growth rate. Comparing the
    # derived level against the raw growth is apples to oranges and reports a
    # relative residual of 22.
    benchmark_target = raw
    if mev.derive == "level_from_yoy_growth":
        from ..mev import reconcile as rc2
        benchmark_target = pd.Series(
            rc2.level_from_yoy_growth(raw.to_numpy(float)), index=raw.index)
    if mev.native == "Q" and len(raw) > 4:
        idx = raw.index.to_period("Q")
        months = pd.date_range(idx.min().start_time, idx.max().end_time, freq="MS")
        sub = derived.reindex(months).ffill().bfill().to_numpy(float)
        n = (len(sub) // 3) * 3
        try:
            absr, relr = rc.aggregation_residual(
                sub[:n], benchmark_target.to_numpy(float)[: n // 3], agg)
            residual, identity = float(absr), float(relr)
        except Exception:                                               # noqa: BLE001
            pass

    return _jsonable({
        "key": key, "label": mev.label, "series_id": mev.series_id,
        "native": mev.native, "kind": mev.kind, "measure": mev.measure,
        "agg": mev.agg, "unit": mev.unit, "note": mev.note, "rebase": mev.rebase,
        "derive": mev.derive,
        "method": ("Denton-Cholette proportional benchmarking" if mev.native == "Q"
                   else f"{'period-' + mev.agg if mev.agg != 'eop' else 'end-of-period'} "
                        f"aggregation" if mev.native in ("D", "W")
                   else "already monthly — passed through"),
        "raw_is_derived": mev.derive == "level_from_yoy_growth",
        "raw": [{"date": d.strftime("%Y-%m-%d"), "value": float(v)}
                for d, v in benchmark_target.loc[
                    benchmark_target.index >= "2014-01-01"].items()],
        "derived": [{"date": d.strftime("%Y-%m-%d"), "value": float(v)}
                    for d, v in derived.loc[derived.index >= "2014-01-01"].items()],
        "residual_absolute": residual, "residual_relative": identity,
        "identity_holds": None if identity is None else identity < 1e-10,
    })


# ── static frontend (container build only) ───────────────────────────────────
# In development the frontend runs on Vite and proxies /api here. In the
# container the built assets are copied in and served by this app, so
# `docker compose up` starts ONE thing on ONE port and there is no CORS step, no
# second process and no reverse proxy to get wrong.
_DIST = ROOT / "frontend" / "dist"
if _DIST.is_dir():
    from fastapi.responses import FileResponse                          # noqa: E402
    from fastapi.staticfiles import StaticFiles                         # noqa: E402

    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        """Serve the single-page app, letting the client router own the path.

        Anything under /api has already matched a real route by the time this is
        reached, so it is explicitly rejected rather than silently answered with
        the HTML shell — an unknown API path returning 200 and a page of markup is
        a genuinely confusing failure to debug.
        """
        if full_path.startswith("api/"):
            raise HTTPException(404, "unknown API route")
        candidate = _DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")
