"""CreditIQ API.

Runs entirely offline against the committed FRED cache and the generated panels.
No key, no network, no configuration.
"""

from __future__ import annotations

import json
from functools import lru_cache
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
from ..models import runcache
from ..mev import panel as mevpanel
from ..mev import scenarios as scen
from ..mev.registry import PORTFOLIO_MEVS, by_key

app = FastAPI(title="CreditIQ", version="0.1.0",
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
        # One string that changes whenever any panel is rebuilt. The frontend
        # compares it across polls and reloads itself on a change, so a panel
        # rebuilt mid-session can never keep serving results computed on data
        # that no longer exists.
        "data_fingerprint": "|".join(
            vstore.data_fingerprint(k) for k in PORTFOLIOS),
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


@lru_cache(maxsize=8)
@runcache.disk_through("health")
def _health(key: str) -> dict:
    """Structural checks and a column profile for the whole panel.

    Cached because the panel is STATIC for the life of the process and this is
    the most expensive read in the application: every integrity check and a
    profile of forty-two columns across the full tape, which came to 6.7 seconds
    on the mortgage book. It is also the first request a portfolio switch makes,
    because the Data surface is where a switch lands — so the cost was paid
    again on every switch, and again on every switch back, on a result that
    could not have changed. `store.clear()` drops it with the panels.
    """
    pf = store.load(key)
    df = store.analysis_frame(key)
    issues = prof.check_integrity(pf.panel, pf.spec)
    cols = prof.profile_columns(df, pf.spec, notes=PLANTED_NOTES)
    return {
        "portfolio": key, "n_rows": len(df), "n_accounts": len(pf.accounts),
        "n_columns": len(df.columns), "score": prof.health_score(issues),
        "issues": issues, "columns": cols,
    }


store.register_dependent_cache(_health.cache_clear)


@app.get("/api/portfolios/{key}/health")
def portfolio_health(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    return _jsonable(_health(key))


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
def scenario_spliced(name: str, keys: str = Query(...), history_from: str = "2008-01-01"):
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

from ..analysis import binning as binmod                               # noqa: E402
from ..analysis import curve as curvemod                               # noqa: E402


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
@runcache.disk_through("screen")
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
            "Screened on a deterministic subsample. Every default is retained "
            "and only non-events are thinned, so the event rate is not reduced. "
            "Model fits use the full panel."
            if res["sampled"] else "Screened on the full panel."),
    })


@app.get("/api/portfolios/{key}/binning/{column}")
def binning(key: str, column: str, edges: str | None = None, max_bins: int = 8,
            monotone: bool = True, n_knots: int = 4, exact_bins: bool = False):
    """Bin a variable. Pass `edges` as a comma-separated list to override the
    optimal edges — this is what the drag interaction in the editor sends.

    `exact_bins` asks for `max_bins` bins rather than at most that many. The
    editor sets it, because a ceiling does not respond to a button. The
    response reports `requested_bins` and `achieved_bins` so the editor can say
    when the count could not be delivered instead of appearing inert."""
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
        b = binmod.bin_numeric(x, y, edges=ed, max_bins=max_bins, monotone=monotone,
                               exact_bins=exact_bins and not ed)
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
        # What was asked for against what the data would carry. The editor shows
        # the difference rather than leaving the control looking broken.
        "requested_bins": max_bins if use_numeric else None,
        "achieved_bins": n_real if use_numeric else None,
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


@app.get("/api/portfolios/{key}/curve/{column}")
def curve(key: str, column: str, knots: str | None = None, resolution: int = 30):
    """The empirical log-odds curve at a resolution you can place a knot from.

    The optimal binning gives six to eight bins, which is right for a WoE table
    and useless for deciding between a straight term and a spline: three of those
    bins are a straight run and the bend is inside the fourth. This cuts as fine
    as the event count supports and shows the shape with its uncertainty.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df, sampled = store.screening_frame(key)
    if column not in df.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    x, y = df[column], df[PORTFOLIOS[key].target.column]
    numeric = pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > 12
    if numeric:
        ks = [float(k) for k in knots.split(",") if k.strip()] if knots else \
            binmod_knots(x, 4)
        out = curvemod.numeric_curve(x, y, knots=ks, resolution=resolution)
        out["candidate_knots"] = ks
    else:
        out = curvemod.categorical_curve(x, y)
    return _jsonable({**out, "column": column, "sampled": sampled})


@app.get("/api/portfolios/{key}/knots/{column}")
def suggest_knots(key: str, column: str, n_knots: int = 4):
    """Place knots where they most improve the fit, rather than at quantiles.

    Quantile placement puts a knot where the DATA is dense and ignores the
    response, so on a variable that bends once at a thin point it puts every knot
    in the straight run. This searches positions against the fit.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df, _ = store.screening_frame(key)
    if column not in df.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    return _jsonable(curvemod.auto_knots(df[column],
                                         df[PORTFOLIOS[key].target.column],
                                         n_knots=n_knots))


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
def vif_for(key: str, columns: str = Query(...), treatments: str = Query("")):
    """Variance inflation for the current selection, on the columns the model
    will actually contain.

    `treatments` is `column:treatment` pairs. Without them this measured the
    correlation of the RAW tape columns, so a variable reported the same
    inflation whether it entered as a spline, as bin indicators or as a
    continuous term — three designs with entirely different column structures.
    A binned interest rate read 20.9 against a true value of 2.4.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df, sampled = store.screening_frame(key)
    cols = [c.strip() for c in columns.split(",") if c.strip() and c.strip() in df.columns]
    if not cols:
        return _jsonable({"vif": [], "skipped": [], "sampled": sampled})
    tmap = dict(t.split(":", 1) for t in treatments.split(",") if ":" in t)

    spec = ModelSpec(
        portfolio=key,
        variables=[VariableSpec(c, treatment=tmap.get(c, "woe")) for c in cols],  # type: ignore[arg-type]
        target_column=PORTFOLIOS[key].target.column,
        # The seasoning basis is in every fitted design, so it belongs in the
        # collinearity picture: it is seven columns of months on book, and a
        # selected variable correlated with age competes with all of them.
        seasoning_spline=True,
    )
    try:
        des = design.build(df, spec)
    except Exception as e:                                              # noqa: BLE001
        raise HTTPException(400, f"{type(e).__name__}: {e}") from e

    groups = des.term_groups()
    rows = modelfit.generalised_vif(np.asarray(des.X, dtype=float), groups)
    by_term = {r["term"]: r for r in rows}
    return _jsonable({
        "vif": [{"column": c,
                 "vif": by_term.get(c, {}).get("vif", 1.0),
                 "gvif": by_term.get(c, {}).get("gvif", 1.0),
                 "df": by_term.get(c, {}).get("df", 1),
                 "aliased": by_term.get(c, {}).get("aliased", False),
                 "treatment": tmap.get(c, "woe")}
                for c in cols if c in by_term],
        "seasoning": by_term.get("seasoning"),
        "n_columns": len(des.columns) - 1,
        "skipped": [c for c in cols if c not in by_term],
        "sampled": sampled,
    })


# ── data initialization ──────────────────────────────────────────────────────
# The panels are not shipped — they are generated, deterministically, from
# seeds. A fresh clone therefore boots with no data, and the frontend offers a
# generate button instead of failing on empty endpoints. Progress is tracked
# here so the person waiting knows the step, the count and the clock, rather
# than staring at a spinner of unknown length.
import threading as _threading
import time as _time

_GEN = {"state": "idle", "step": 0, "total": 0, "label": "", "started_at": 0.0,
        "error": ""}
_GEN_LOCK = _threading.Lock()


@app.get("/api/data/status")
def data_status():
    ready = len(store.available()) == len(PORTFOLIOS)
    with _GEN_LOCK:
        g = dict(_GEN)
    elapsed = _time.time() - g["started_at"] if g["state"] == "running" else 0.0
    # A rough remaining-time estimate from the average pace of completed
    # steps. Steps are not equal-sized, so it is labelled rough in the UI.
    eta = (elapsed / g["step"] * (g["total"] - g["step"])
           if g["state"] == "running" and g["step"] > 0 else None)
    return {"ready": ready, "portfolios_present": store.available(),
            "state": g["state"], "step": g["step"], "total": g["total"],
            "label": g["label"], "elapsed_s": round(elapsed, 1),
            "eta_s": round(eta, 1) if eta is not None else None,
            "error": g["error"]}


@app.post("/api/data/generate")
def data_generate():
    from ..data import build as databuild
    with _GEN_LOCK:
        if _GEN["state"] == "running":
            return {"state": "running"}
        _GEN.update(state="running", step=0, total=databuild.BUILD_TOTAL_STEPS,
                    label="Starting", started_at=_time.time(), error="")

    def tick(label: str) -> None:
        with _GEN_LOCK:
            _GEN["step"] += 1
            _GEN["label"] = label

    def run() -> None:
        try:
            databuild.build(verbose=False, progress=tick)
            # Every derived cache is stale the moment the panels change hands.
            store.clear()
            with _GEN_LOCK:
                _GEN.update(state="done", label="Done")
        except Exception as e:                                          # noqa: BLE001
            with _GEN_LOCK:
                _GEN.update(state="error", error=str(e))

    _threading.Thread(target=run, daemon=True).start()
    return {"state": "running", "total": databuild.BUILD_TOTAL_STEPS}


@app.on_event("startup")
def _warm() -> None:
    """Warm the caches in the background so the first click of a demo is instant.

    Screening a book takes a few seconds. Paying that while a client watches is
    the difference between a product and a prototype, so it is paid at boot.

    OPT-IN, because the price is real: warming loads and profiles all three
    panels, roughly 9 GB of memory. On a smaller laptop that swaps, every
    request starves behind it, and the frontend sits on its loading skeleton —
    the app looks broken on exactly the machine it was just handed to. Cold,
    the first click on each surface pays a few seconds instead, once.
    """
    import os
    import threading

    if os.environ.get("CREDITIQ_WARM", "") != "1":
        print("creditiq: cache warm-up off — first click per surface pays a few "
              "seconds, once. Set CREDITIQ_WARM=1 (or `make demo`) to pre-warm.")
        return
    if not store.available():
        return

    def run():
        for k in store.available():
            try:
                store.analysis_frame(k)
                _screen_all(k)
                # The panel profile is the single most expensive read in the
                # application — 7.4 seconds on the mortgage book — and it is the
                # FIRST request a portfolio switch makes, because a switch lands
                # on the Data surface. It was absent from this list, so the one
                # call worth warming was the one not warmed.
                _health(k)
                # The macro search enumerates 325 candidate terms per book and
                # runs a stationarity test on each. Roughly a second, paid on
                # the first visit to the Macro stage.
                mevsearch.library(k)
            except Exception:                                           # noqa: BLE001
                pass                                    # a warm-up failure is not fatal
        try:
            mev_panel.monthly_panel()
            scen.load_all()
        except Exception:                                               # noqa: BLE001
            pass

    threading.Thread(target=run, daemon=True).start()


# ── model ────────────────────────────────────────────────────────────────────
from pydantic import BaseModel, field_validator                         # noqa: E402

from ..models import fit as modelfit                                    # noqa: E402
from ..models import design                                             # noqa: E402
from ..models import rollup as rollupsvc                                # noqa: E402
from ..models import service as modelsvc                                # noqa: E402
from ..models.naming import friendly_name                               # noqa: E402
from ..models.spec import (LGD_MACRO, LgdSpec, MevSpec, ModelSpec,  # noqa: E402
                           SampleSpec, VariableSpec)


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
    # The severity half. Absent means the PD model is being worked on alone,
    # which is a legal working state — it is naming and saving that require both.
    lgd: dict | None = None

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
            lgd=LgdSpec.from_dict({**self.lgd, "portfolio": self.portfolio})
            if self.lgd else None,
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


def _references(r) -> dict[str, str]:
    """The reference level of every dummy-encoded variable.

    A k-bin variable enters as k-1 indicators, and the bin with no column is
    what every coefficient is measured against. The table has to say which bin
    that is, or the coefficients read as absolute effects."""
    out: dict[str, str] = {}
    for v in r.spec.variables:
        if v.treatment not in ("bins", "indicator"):
            continue
        m = r.fit.woe_maps.get(v.column)
        if not m:
            continue
        if m.get("kind") == "numeric":
            labels = m.get("labels")
            if labels:
                out[v.column] = str(labels[0])
        else:
            keys = list((m.get("map") or {}).keys())
            if keys:
                out[v.column] = str(keys[0])
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
        "references": _references(r),
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


def _reject_unknown_columns(portfolio: str, columns: list[str], what: str) -> None:
    """Refuse a specification naming a column the panel does not have.

    A missing column used to pass straight through. The design matrix skipped
    it, the fit succeeded, no warning was raised, and the term simply was not in
    the model. The hash is taken from the specification rather than from the
    design, so the phantom column still changed the hash and the generated name:
    two Model IDs for one model, with the difference invisible in the
    coefficients. On the severity side it was worse, and the whole LGD fit came
    back with no coefficients at all.

    A model cannot be fitted on a variable that is not there, so this is an
    error rather than a warning.
    """
    if not columns:
        return
    have = set(store.analysis_frame(portfolio).columns)
    missing = [c for c in dict.fromkeys(columns)
               # A macro driver is joined from the published series rather than
               # read off the account panel, so it is legitimately absent here.
               # A transformed term carries '@' and is resolved the same way.
               if c not in have and c not in LGD_MACRO and "@" not in c]
    if missing:
        raise HTTPException(
            400,
            f"{what} not in the {portfolio} panel: {', '.join(sorted(missing))}")


@app.post("/api/fit")
def fit_model(req: FitRequest):
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    if not req.variables:
        raise HTTPException(400, "select at least one variable")
    spec = req.to_spec()
    _reject_unknown_columns(req.portfolio, [v.column for v in spec.variables],
                            "variables")
    if spec.lgd is not None:
        _reject_unknown_columns(req.portfolio,
                                [*spec.lgd.drivers, *spec.lgd.categoricals],
                                "LGD drivers")
    try:
        r = modelsvc.run(spec)
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


@app.post("/api/model/identity")
def model_identity(req: FitRequest):
    """The Model ID for a PD specification AND an LGD specification together.

    A Model is both halves. An ECL number is PD x LGD x EAD, so a name that
    covers only the hazard model refers to half of what produced the figure —
    two "models" with the same name could carry severity specifications that
    differ by twenty points of downturn LGD.

    So this is deliberately NOT willing to name a half-built model. Until both
    halves exist it returns the working hash and no name, and the UI says which
    half is missing rather than offering a name it would have to revoke.
    """
    spec = req.to_spec()
    missing = []
    if not spec.variables:
        missing.append("PD variables")
    if spec.lgd is None or not (spec.lgd.drivers or spec.lgd.categoricals):
        missing.append("LGD drivers")
    h = spec.hash()
    return {
        "hash": h, "complete": not missing, "missing": missing,
        "name": friendly_name(h) if not missing else None,
        "pd_variables": [v.column for v in spec.variables],
        "lgd_drivers": list(spec.lgd.drivers) if spec.lgd else [],
        "lgd_categoricals": list(spec.lgd.categoricals) if spec.lgd else [],
    }


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


@app.get("/api/scenarios/model-paths")
def scenario_model_paths(terms: str = Query(...), history_from: str = "2022-01-01"):
    """Each macro term of a specification, as the projection consumes it.

    The scenario editor showed raw supervisory variables; the model responds to
    its TERMS — a transform of a variable, at a lag — and the honest display of
    "what is stressed" is the transformed, lagged series itself: history up to
    the projection date, then the baseline and severely adverse branches the
    projection actually walks. One shared history and two forward branches per
    term, so the divergence at the projection date is the picture.
    """
    from ..models.design import apply_mev_transform
    hist = mev_panel.monthly_panel()
    as_of = hist.index.max()
    paths = {name: scensvc.scenario_mev_path(name, as_of)
             for name in ("baseline", "severely_adverse")}
    lo = pd.Timestamp(history_from)
    # A derived series like cre_price_index_yoy has no registry entry of its
    # own; its base does. Resolve the label through the base and fold the
    # implied year-over-year into the reported transform, so the chart is
    # titled "Commercial property price index" over "12-month % change"
    # rather than a raw column slug.
    raw_keys = [t.split("@")[0] for t in terms.split(",") if t.strip()]
    meta = by_key(raw_keys + [k[:-4] for k in raw_keys if k.endswith("_yoy")])

    series = []
    seen: set[str] = set()
    for raw in [t.strip() for t in terms.split(",") if t.strip()]:
        if raw in seen:
            continue
        seen.add(raw)
        parts = raw.split("@")
        key = parts[0]
        tf = parts[1] if len(parts) > 1 else "level"
        lag = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0

        branches: dict[str, list[dict]] = {}
        history: list[dict] = []
        for name, path in paths.items():
            if key not in path.columns:
                break
            s = apply_mev_transform(path[key], tf)
            if lag:
                s = s.shift(lag)
            s = s.loc[s.index >= lo].dropna()
            fwd = s.loc[s.index > as_of]
            branches[name] = [{"date": str(d.date()), "value": float(v)}
                              for d, v in fwd.items()]
            if name == "baseline":
                back = s.loc[s.index <= as_of]
                history = [{"date": str(d.date()), "value": float(v)}
                           for d, v in back.items()]
        if not branches:
            continue
        m = meta.get(key)
        rep_tf = tf
        if m is None and key.endswith("_yoy") and key[:-4] in meta:
            m = meta[key[:-4]]
            rep_tf = {"level": "yoy", "ma3": "yoy_ma3"}.get(tf, tf)
        series.append({
            "term": raw, "key": key, "transform": rep_tf, "lag_months": lag,
            "label": m.label if m else key,
            "unit": (m.unit if m and rep_tf == "level" else ""),
            "history": history,
            "baseline": branches.get("baseline", []),
            "severely_adverse": branches.get("severely_adverse", []),
        })
    return _jsonable({"as_of": str(as_of.date()), "series": series})

from ..models import lgd_diag as lgddiag                                # noqa: E402
from ..analysis import severity_binning as sevbin                      # noqa: E402


class EclRequest(FitRequest):
    scenarios: list[str] = ["baseline", "severely_adverse"]
    weights: dict[str, float] | None = None
    custom: dict[str, dict[str, float]] | None = None
    fixed_ccf: float | None = None
    cpr: float = 0.0
    cap_to_fitted_range: bool = False
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
            "alternative_ecl": r.alternative_ecl.get(k),
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
                "spec": r.lgd.spec.to_dict(), "drivers": list(r.lgd.spec.drivers)},
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



# ── loss given default ───────────────────────────────────────────────────────
# ── macro transformation search ──────────────────────────────────────────────
from ..analysis import mev_search as mevsearch                          # noqa: E402


@app.get("/api/portfolios/{key}/macro/library")
def macro_library(key: str):
    """Every candidate macro term for this book, with its stationarity test and
    its correlation with both targets."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    return _jsonable(mevsearch.library(key))


@app.get("/api/portfolios/{key}/macro/series")
def macro_series(key: str, column: str = Query(...)):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    try:
        return _jsonable(mevsearch.series_for(key, column))
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


def _lgd_frame(key: str, extra: str = "") -> pd.DataFrame:
    """Defaulted rows with the macro block attached, plus any shortlisted
    candidate terms named `key@transform@lag`."""
    df = store.analysis_frame(key)
    d = df.loc[df["default_flag"] == 1].copy()
    cols = tuple(c for c in extra.split(",") if "@" in c)
    return scensvc.LGD.attach_macro(d, mevpanel.monthly_panel(), cols)


@app.get("/api/portfolios/{key}/lgd/screen")
def lgd_screen(key: str, extra: str = Query("")):
    """Rank the candidate severity drivers on the defaulted population.

    Ordered by the absolute Spearman rank correlation with realised severity.
    The spread column gives the same relationship in percentage points: the
    difference between the highest and lowest bucket mean.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    d = _lgd_frame(key, extra)
    cand = scensvc.LGD.candidates(store.analysis_frame(key), key,
                                  mevpanel.monthly_panel())
    # Shortlisted macro terms are ranked beside the tape columns, on the same
    # population and the same statistic.
    for col in (c for c in extra.split(",") if "@" in c and c in d.columns):
        cand["numeric"].append({"column": col, "filled": float(d[col].notna().mean()),
                                "kind": "numeric", "macro": True})
    y = d["lgd_realised"]
    rows = []
    for c in cand["numeric"]:
        r = curvemod.severity_curve(d[c["column"]], y)
        if not r.get("points"):
            continue
        rows.append({**c, "spearman": r["spearman"], "spread": r["spread"],
                     "linear_r2": r["linear"]["pseudo_r2"], "buckets": r["resolution"]})
    for c in cand["categorical"]:
        r = curvemod.severity_by_level(d[c["column"]], y)
        if not r.get("points"):
            continue
        rows.append({**c, "spearman": None, "spread": r["spread"],
                     "linear_r2": None, "buckets": len(r["points"])})
    for r in rows:
        name = r["column"]
        r["caution"] = any(t in name for t in
                           ("_id", "id_", "_code", "_seq", "batch", "vintage"))
    rows.sort(key=lambda r: (abs(r["spearman"] or 0.0), r["spread"]), reverse=True)
    return _jsonable({
        "portfolio": key, "n_defaults": int(len(d)),
        "mean_lgd": float(y.mean()), "zero_loss_share": float((y <= 1e-9).mean()),
        "rows": rows, "default_spec": LgdSpec.default_for(key).to_dict(),
    })


@app.get("/api/portfolios/{key}/lgd/curve/{column}")
def lgd_curve(key: str, column: str, resolution: int = 12,
              knots: str | None = None):
    """Mean realised severity across the range of one driver, with volume."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    d = _lgd_frame(key, column if "@" in column else "")
    if column not in d.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    x, y = d[column], d["lgd_realised"]
    numeric = pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > 8
    if numeric:
        ks = ([float(k) for k in knots.split(",") if k.strip()] if knots
              else curvemod.auto_knots_severity(x, y, 3).get("quantile_knots", []))
        out = curvemod.severity_curve(x, y, resolution=resolution, knots=ks)
        out["candidate_knots"] = ks
    else:
        out = curvemod.severity_by_level(x, y)
    return _jsonable({**out, "column": column, "n_defaults": int(len(d))})


@app.get("/api/portfolios/{key}/lgd/distribution")
def lgd_distribution(key: str):
    """The distribution of realised severity on this book."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    y = np.clip(_lgd_frame(key)["lgd_realised"].to_numpy(float), 0.0, 1.0)
    edges = np.linspace(0.0, 1.0, 21)
    counts, _ = np.histogram(y[y > 1e-9], bins=edges)
    return _jsonable({
        "portfolio": key, "n_defaults": int(len(y)), "mean_lgd": float(y.mean()),
        "median_lgd": float(np.median(y)),
        "zero_loss_share": float((y <= 1e-9).mean()),
        "total_loss_share": float((y >= 0.999).mean()),
        "histogram": ([{"lo": 0.0, "hi": 0.0, "n": int((y <= 1e-9).sum()), "zero": True}]
                      + [{"lo": float(edges[i]), "hi": float(edges[i + 1]),
                          "n": int(counts[i]), "zero": False}
                         for i in range(len(counts))]),
    })


@app.get("/api/portfolios/{key}/lgd/candidates")
def lgd_candidates(key: str):
    """What a severity model on this book is allowed to see, and the default pick.

    Severity is fitted on defaulted account-months only. On the commercial book
    that is a few hundred rows, so the candidate list carries the fill rate and
    the default count beside it — a driver that is 60% missing among defaults is
    a different proposition from the same driver on the full tape.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df = store.analysis_frame(key)
    c = scensvc.LGD.candidates(df, key, mevpanel.monthly_panel())
    for row in c["numeric"] + c["categorical"]:
        name = row["column"]
        # Operational identifiers ride along on a real tape and are not drivers.
        row["caution"] = any(t in name for t in
                             ("_id", "id_", "_code", "_seq", "batch", "vintage"))
    return _jsonable({**c, "default_spec": LgdSpec.default_for(key).to_dict()})


class LgdFitRequest(BaseModel):
    portfolio: str
    drivers: list[str] = []
    categoricals: list[str] = []
    # column -> treatment, and per-column binning edges / spline knots
    # These accept EITHER a mapping or the list-of-pairs form.
    #
    # `LgdSpec` is frozen, so it stores these as tuples of pairs and
    # `to_dict()` serialises them as lists — which is the form written into
    # every saved version. Declaring only `dict` here meant the endpoint
    # rejected the application's own output: opening a saved model and pressing
    # Fit LGD posted the stored specification straight back and got three
    # validation errors, one per field. An API that cannot read what it writes
    # is the bug; normalising at the boundary is the fix.
    treatments: dict[str, str] = {}
    edges: dict[str, list[float]] = {}
    knots: dict[str, list[float]] = {}

    @field_validator("treatments", "edges", "knots", mode="before")
    @classmethod
    def _accept_pairs(cls, v):
        if isinstance(v, list):
            return {k: val for k, val in (pair for pair in v)}
        return v
    n_knots: int = 3
    max_bins: int = 5
    oot_from: str = "2022-01-01"
    # How the severity backtest groups its cohorts. Monthly by default because
    # the panel is monthly; the response reports how many periods were too thin
    # to average, which is the whole story on a book that resolves few workouts.
    freq: str = "MS"

    def to_spec(self) -> LgdSpec:
        return LgdSpec(
            portfolio=self.portfolio, drivers=tuple(self.drivers),
            categoricals=tuple(self.categoricals),
            treatments=tuple(sorted(self.treatments.items())),
            edges=tuple((c, tuple(v)) for c, v in sorted(self.edges.items())),
            knots=tuple((c, tuple(v)) for c, v in sorted(self.knots.items())),
            n_knots=self.n_knots, max_bins=self.max_bins)


@app.post("/api/lgd/fit")
def lgd_fit(req: LgdFitRequest):
    """Fit the severity model and return its coefficients and diagnostics."""
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    spec = req.to_spec()
    if not spec.drivers and not spec.categoricals:
        raise HTTPException(400, "select at least one driver")
    _reject_unknown_columns(req.portfolio, [*spec.drivers, *spec.categoricals],
                            "LGD drivers")
    try:
        m = scensvc.lgd_model(req.portfolio, spec)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    d = _lgd_frame(req.portfolio,
                   ",".join(c for c in spec.drivers if "@" in c))
    diag = lgddiag.diagnostics(m, d)
    return _jsonable({
        "portfolio": req.portfolio, "spec": spec.to_dict(), "hash": spec.hash(),
        # The same naming as the PD fit. Half of a model with a name and half
        # with a code read as two different kinds of thing; they are not.
        "name": friendly_name(spec.hash()),
        "columns": m.columns, "diagnostics": diag,
        "n_defaults": m.n_defaults, "mean_lgd": m.mean_lgd,
        "zero_loss_share": m.zero_loss_share,
        "mean_severity_given_loss": m.mean_severity_given_loss,
        "mean_workout_months": m.mean_workout_months,
        "coefficients": m.coefficients, "calibration": m.calibration,
        "severity_histogram": m.severity_histogram,
        "macro_drivers": spec.macro_drivers, "dropped": m.dropped, "note": m.fit_note,
        # The reference bin of every discretised term — the bin with no
        # indicator column, which every coefficient is measured against.
        "references": {c: str(m.maps[c]["labels"][0])
                       for c in (*spec.drivers, *spec.categoricals)
                       if c in m.maps and m.maps[c].get("labels")},
    })


@app.post("/api/lgd/backtest")
def lgd_backtest(req: LgdFitRequest):
    """Refit on defaults before the boundary and score the ones after it."""
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    spec = req.to_spec()
    if not spec.drivers and not spec.categoricals:
        raise HTTPException(400, "select at least one driver")
    m = scensvc.lgd_model(req.portfolio, spec)
    d = _lgd_frame(req.portfolio, ",".join(c for c in spec.drivers if "@" in c))
    return _jsonable(lgddiag.backtest(m, d, req.oot_from, freq=req.freq))


@app.get("/api/portfolios/{key}/lgd/severity-over-time")
def lgd_severity_over_time(key: str, freq: str = "MS"):
    """The DEPENDENT VARIABLE through time, before any model.

    The severity distribution shows the shape of the target — a mass at full
    recovery and a mass near total loss — but says nothing about when. Severity
    on a secured book is a function of collateral values, so it moves with the
    cycle, and a driver's usefulness depends on whether it tracks that movement.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    if freq not in lgddiag.SEVERITY_FREQ_CHOICES:
        raise HTTPException(
            400, f"unknown frequency {freq!r}; "
                 f"choose one of {sorted(lgddiag.SEVERITY_FREQ_CHOICES)}")
    d = _lgd_frame(key)
    return _jsonable({
        "portfolio": key, "freq": freq,
        "period_freq": lgddiag.SEVERITY_FREQ_CHOICES[freq],
        "n_defaults": int(len(d)),
        "mean": float(np.clip(d["lgd_realised"].to_numpy(float), 0, 1).mean()),
        **lgddiag.severity_coverage(d, freq),
        "points": lgddiag.severity_over_time(d, freq=freq),
    })


@app.get("/api/portfolios/{key}/lgd/binning/{column}")
def lgd_binning(key: str, column: str, max_bins: int = 5, edges: str | None = None):
    """Bin a driver against realised severity.

    The bin statistic is a MEAN, not an event rate, and the strength measure is a
    deviance R-squared rather than an information value — see
    `analysis/severity_binning.py` for why an information value has no referent
    on a fractional target.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    d = _lgd_frame(key, column if "@" in column else "")
    if column not in d.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    ed = [float(e) for e in edges.split(",") if e.strip()] if edges else None
    b = sevbin.bin_severity(d[column], d["lgd_realised"], max_bins=max_bins, edges=ed)
    numeric = b.kind == "numeric"
    v = pd.to_numeric(d[column], errors="coerce").dropna() if numeric else None
    dom = ([float(np.nanpercentile(v, 1)), float(np.nanpercentile(v, 99))]
           if numeric and len(v) else None)
    hist = None
    if dom and dom[1] > dom[0]:
        counts, bounds = np.histogram(np.clip(v, *dom), bins=32, range=tuple(dom))
        hist = {"bounds": [float(z) for z in bounds],
                "counts": [int(z) for z in counts]}
    n_real = len(b.bins)
    return _jsonable({
        **b.to_dict(), "domain": dom, "histogram": hist,
        "supports_continuous": bool(numeric),
        "column_costs": {"weight": 1, "bins": max(n_real - 1, 0),
                         "continuous": 1 if numeric else None,
                         "spline": None if not numeric else None},
    })


@app.get("/api/portfolios/{key}/lgd/knots/{column}")
def lgd_suggest_knots(key: str, column: str, n_knots: int = 3):
    """Place severity knots by search rather than at quantiles."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    d = _lgd_frame(key, column if "@" in column else "")
    if column not in d.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    return _jsonable(curvemod.auto_knots_severity(d[column], d["lgd_realised"],
                                                  n_knots=n_knots))


@app.get("/api/portfolios/{key}/lgd/sensitivity")
def lgd_sensitivity(key: str, drivers: str = Query(""), categoricals: str = Query("")):
    """Predicted mean LGD as each macro driver is moved one standard deviation.

    A severity model that does not move with the cycle is the most common thing a
    validator writes up, and it is invisible in a coefficient table when the
    driver is standardised. This makes it a number in dollars-per-point terms.
    """
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    spec = LgdSpec(portfolio=key,
                   drivers=tuple(x for x in drivers.split(",") if x),
                   categoricals=tuple(x for x in categoricals.split(",") if x))
    if not spec.drivers and not spec.categoricals:
        spec = LgdSpec.default_for(key)
    m = scensvc.lgd_model(key, spec)
    df = store.analysis_frame(key)
    d = scensvc.LGD.attach_macro(df.loc[df["default_flag"] == 1].copy(),
                                 mevpanel.monthly_panel(),
                                 tuple(c for c in spec.drivers if "@" in c))
    base = float(m.predict(scensvc.LGD.design_for(d, m)).mean())
    out = []
    for c in spec.macro_drivers:
        if c not in d.columns:
            continue
        sd = float(pd.to_numeric(d[c], errors="coerce").std())
        if not np.isfinite(sd) or sd <= 0:
            continue
        row = {"driver": c, "sd": sd, "base": base}
        for sign, label in ((1.0, "up"), (-1.0, "down")):
            shocked = d.copy()
            shocked[c] = pd.to_numeric(shocked[c], errors="coerce") + sign * sd
            row[label] = float(m.predict(scensvc.LGD.design_for(shocked, m)).mean())
        out.append(row)
    return _jsonable({"portfolio": key, "spec": spec.to_dict(), "base": base,
                      "sensitivity": out})


# ── versions ─────────────────────────────────────────────────────────────────
from ..models import versions as vstore                                 # noqa: E402


class SaveVersionRequest(EclRequest):
    notes: str = ""
    tags: list[str] = []
    with_ecl: bool = False
    # Hash of a version this supersedes. The replaced version is removed and its
    # status, tags and starred flag transfer to this one.
    replaces: str | None = None


def _lgd_metrics_for(spec) -> dict:
    """Score the SEVERITY half of a saved model.

    A version used to record PD statistics only, so half of what produced the
    loss number went unmeasured.

    **Both figures are out of time.** In sample they say nothing: a fractional
    logit carrying an intercept reproduces the book mean exactly, so in-sample
    bias is identically zero for every specification. Only a holdout reveals
    whether the level survives.

    **Calibration bias** — mean predicted minus mean realised severity, in LGD
    points. The headline, because it is the only severity statistic that
    converts directly into an error in the loss figure: severity enters expected
    credit loss multiplicatively, so a model 28 points high on a book averaging
    0.12 overstates lifetime ECL several times over. Rank ordering carries no
    such consequence — a model can order every default correctly and still be
    wrong on the level.

    **RMSE** — root mean squared error on realised severity, in the same units.
    Bias is a mean, so it cancels: a model that is 20 points high on half the
    book and 20 points low on the other half reports no bias at all. RMSE does
    not cancel, so the pair decomposes the error — bias is the level, and the
    gap between RMSE and bias is the dispersion.

    Rank statistics are recorded but not shown in the version list. Deviance R²
    is also kept; it goes NEGATIVE out of time when a model predicts worse than
    the book mean, which is informative but reads poorly as a table column.

    Where a book cannot support the split, the in-sample figures are stored and
    the basis is recorded, so the interface says which it is rather than passing
    one off as the other.
    """
    if spec.lgd is None or not (spec.lgd.drivers or spec.lgd.categoricals):
        return {}
    try:
        m = scensvc.lgd_model(spec.portfolio, spec.lgd)
        d = _lgd_frame(spec.portfolio,
                       ",".join(c for c in spec.lgd.drivers if "@" in c))
        bt = lgddiag.backtest(m, d, LgdFitRequest.model_fields["oot_from"].default)
    except Exception as e:                                              # noqa: BLE001
        return {"lgd_error": f"{type(e).__name__}: {e}"}

    if bt.get("usable") and bt.get("test"):
        t, basis, note = bt["test"], "out of time", f"defaults from {bt['oot_from']}"
    else:
        t = lgddiag.diagnostics(m, d)
        basis, note = "in sample", bt.get("note", "")

    return {
        "lgd_bias": float(t["mean_predicted"] - t["mean_actual"]),
        "lgd_rmse": t.get("rmse"),
        "lgd_mae": t.get("mae"),
        "lgd_deviance_r2": t.get("deviance_r2"),
        "lgd_spearman": t.get("spearman"),
        "lgd_mean_predicted": t["mean_predicted"],
        "lgd_mean_actual": t["mean_actual"],
        "lgd_n": t["n"],
        "lgd_basis": basis,
        "lgd_basis_note": note,
        "n_lgd_drivers": len(spec.lgd.drivers) + len(spec.lgd.categoricals),
        "lgd_hash": spec.lgd.hash(),
        "pd_hash": spec.pd_hash(),
    }


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
        # Out-of-time error on the annualised default rate, in percentage
        # points. The cohort backtest is the strongest evidence a PD model
        # carries, and these are its summary, so they belong on the record.
        "pd_oot_rmse_pp": (r.backtest.get("errors", {}).get("out_of_time") or {}).get("rmse_pp"),
        "pd_oot_bias_pp": (r.backtest.get("errors", {}).get("out_of_time") or {}).get("bias_pp"),
        "pd_oot_coverage": (r.backtest.get("errors", {}).get("out_of_time") or {}).get("coverage"),
        "n_variables": len(r.spec.variables),
        "n_mevs": len(r.spec.mevs),
        "estimator": r.spec.estimator,
        "coefficients": {c.name: c.estimate for c in r.fit.coefficients},
    }


class RecohortRequest(FitRequest):
    """A fit request plus the frequency to report its backtest at."""
    freq: str = "QS"


@app.post("/api/backtest/recohort")
def backtest_recohort(req: RecohortRequest):
    """Report an already-fitted model's backtest at another frequency.

    The data is monthly and quarterly cohorts are a REPORTING choice, so the
    choice belongs to the reader. It costs no refit: the scored account-months
    are kept on the cached run and only the grouping is redone.

    Quarterly is the default because of what monthly does to the statistics on a
    book this size — around nine defaults a month, against twenty-six a quarter.
    An area under the curve computed on nine events ranged from 0.30 to 0.95
    across the mortgage panel, and a value below 0.5 reads as a model ranking
    backwards when it is only sampling noise. The event count travels with every
    point so the interface can say how much is behind it.
    """
    if req.freq not in modelsvc.B.FREQ_CHOICES:
        raise HTTPException(
            400, f"unknown frequency {req.freq!r}; "
                 f"choose one of {sorted(modelsvc.B.FREQ_CHOICES)}")
    run = modelsvc.run(req.to_spec())
    if not run.scored:
        raise HTTPException(409, "this run predates re-cohorting; refit it first")
    return _jsonable(modelsvc.B.recohort(run.scored, req.freq))


@app.post("/api/versions")
def save_version(req: SaveVersionRequest):
    spec = req.to_spec()
    # Naming is gated on BOTH halves. A saved version is meant to be the thing
    # that produced an ECL number, and half of that number comes from severity.
    if not spec.variables:
        raise HTTPException(400, "no PD variables — nothing to save")
    if spec.lgd is None or not (spec.lgd.drivers or spec.lgd.categoricals):
        raise HTTPException(
            400, "fit an LGD model before naming this one. A Model ID covers the "
                 "PD specification and the LGD specification together, because "
                 "both of them produced the loss number.")
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
    rollupsvc.clear_cache()     # the roll-up's version picker is now stale
    v = vstore.save(spec, _metrics_for(run) | _lgd_metrics_for(spec), ecl_summary,
                    label=req.label,
                    notes=req.notes, tags=req.tags, parent_hash=req.parent_hash,
                    replaces=req.replaces)
    return _jsonable(_version_payload(v))


def _version_payload(v) -> dict:
    return {**v.to_dict(), "data_is_current": v.data_is_current(),
            "current_data_fingerprint": vstore.data_fingerprint(v.portfolio)}


@app.get("/api/versions")
def list_versions(portfolio: str | None = None):
    return _jsonable([_version_payload(v) for v in vstore.list_all(portfolio)])


@app.get("/api/versions/{hash_}")
def get_version(hash_: str):
    """One saved model, whole, so the app can be put back into it.

    The whole specification comes back — variables with their binning maps, macro
    terms with lags, the LGD drivers, the sample design. Loading it and replaying
    it is what makes the reproducibility claim checkable rather than asserted:
    the same specification produces the same hash, so if the replayed model has a
    different ID, something moved underneath it.
    """
    v = vstore.load(hash_)
    if v is None:
        raise HTTPException(404, "unknown version")
    return _jsonable(_version_payload(v))


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
    rollupsvc.clear_cache()     # the roll-up's version picker is now stale
    v = vstore.promote(hash_)
    if v is None:
        raise HTTPException(404, "unknown version")
    return _jsonable(v.to_dict())


@app.delete("/api/versions/{hash_}")
def delete_version(hash_: str):
    rollupsvc.clear_cache()     # the roll-up's version picker is now stale
    return {"deleted": vstore.delete(hash_)}


@app.get("/api/versions/{hash_}/export")
def export_version(hash_: str):
    v = vstore.load(hash_)
    if v is None:
        raise HTTPException(404, "unknown version")
    return _jsonable(_version_payload(v))


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


@app.get("/api/rollup")
def rollup(tornado: bool = True, select: str = Query("")):
    """Every book on one page.

    `select` is `portfolio:version_hash` pairs and overrides which saved model a
    book is reported on. Absent, each book uses its champion, and a book with no
    champion uses the documented default. A selection that differs from the
    champions is an exploratory figure, not the adopted position, and the
    response says which it is rather than leaving it to be read off a dropdown.
    """
    selection = dict(x.split(":", 1) for x in select.split(",") if ":" in x)
    r = rollupsvc.run(with_tornado=tornado, selection=selection)
    champs = {p: vstore.champion(p) for p in store.available()}
    return _jsonable({
        "scenarios": r.scenarios, "portfolios": r.portfolios, "totals": r.totals,
        "monthly": r.monthly, "tornado": r.tornado,
        "concentration": r.concentration, "timings": r.timings,
        "is_adopted": r.is_adopted, "selection": r.selection,
        "available": r.available,
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


store.register_dependent_cache(_screen_all.cache_clear)
