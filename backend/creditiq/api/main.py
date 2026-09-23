"""CreditIQ API.

Runs entirely offline against the committed FRED cache and the generated panels.
No key, no network, no configuration.
"""

from __future__ import annotations

import hashlib as _hashlib
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .. import store
from ..analysis import profile as prof
from ..analysis import univariate as univar
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
        s = PORTFOLIOS[key]
        # An ingested book answers from its registry record: every figure
        # below was computed once at ingestion. Loading the panel just to
        # relist the books cost a minute on a large tape — the first thing a
        # user saw after adding one was the whole app waiting on this loop.
        rec = tapemod.record_for(key)
        summary = (rec or {}).get("summary")
        if summary:
            out.append(_jsonable({
                "key": key, "label": s.label, "accent_slot": s.accent_slot,
                "source": "ingested",
                "has_severity": summary["has_severity"],
                "n_accounts": rec["n_accounts"], "n_rows": rec["n_rows"],
                "n_defaults": summary["n_defaults"],
                "annual_default_rate_pct": round(
                    float(annualize(summary["monthly_default_rate"])), 3),
                "window": summary["window"],
                "oot_from": _book_oot_from(key),
                "target": {"column": s.target.column, "label": s.target.label,
                           "description": s.target.description},
                "ead_method": s.ead_method, "ead_note": s.ead_note,
                "mev_keys": PORTFOLIO_MEVS.get(key, s.mev_keys),
                "drivers": sorted(set(s.numeric_betas)
                                  | set(s.observed_aliases.values())
                                  - set(s.observed_aliases)),
                "categorical_drivers": list(s.categorical_betas),
                "expected_signs": s.expected_signs,
            }))
            continue
        pf = store.load(key)
        s, p = pf.spec, pf.panel
        out.append(_jsonable({
            "key": key, "label": s.label, "accent_slot": s.accent_slot,
            # Whether this book is generated or someone's real tape. The
            # interface labels synthetic data everywhere, and that label must
            # not follow real loans onto the screen once a tape is ingested.
            "source": "ingested" if tapemod.is_ingested(key) else "synthetic",
            # Whether the tape carries realised losses. Without them no
            # severity model can be fitted and the LGD stage offers a
            # declared assumption instead.
            "has_severity": "lgd_realised" in p.columns,
            "n_accounts": len(pf.accounts), "n_rows": len(p),
            "n_defaults": int(p[s.target.column].sum()),
            "annual_default_rate_pct": round(float(annualize(p[s.target.column].mean())), 3),
            "window": [p["performance_date"].min(), p["performance_date"].max()],
            # One source of truth for the out-of-time boundary the workbenches
            # propose: the book's own, stated at ingestion where there is one.
            "oot_from": _book_oot_from(key),
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
    because the Panel surface is where a switch lands — so the cost was paid
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
    categorical column. The headline chart on the Panel surface."""
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
def portfolio_sample(key: str, limit: int = 200, offset: int = 0,
                     structure: bool = False):
    """Raw rows. With `structure=true`, a few whole accounts sorted by month
    instead of the first N rows: the first rows of a date-ordered panel are
    fifty different accounts on the same date, which shows the columns but
    not the SHAPE — one row per account per month is the fact the panel view
    exists to make visible."""
    df = store.analysis_frame(key)
    if structure:
        ids = df["account_id"].drop_duplicates().head(3)
        sub = (df[df["account_id"].isin(ids)]
               .sort_values(["account_id", "performance_date"])
               .groupby("account_id", sort=False).head(max(2, limit // len(ids)))
               .copy())
    else:
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


@app.get("/api/portfolios/{key}/univariate/{column}")
def univariate(key: str, column: str):
    """One column on its own, before any target: shape, spread, concentration,
    and the findings that follow. Answers "what does this look like", which is
    the question the binning panels assume has already been answered."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    df, sampled = store.screening_frame(key)
    if column not in df.columns:
        raise HTTPException(404, f"unknown column {column!r}")
    out = univar.describe(df[column], column, df[PORTFOLIOS[key].target.column])
    out["sampled"] = bool(sampled)
    return _jsonable(out)


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


@app.post("/api/portfolios/{key}/prepare")
def prepare_portfolio(key: str):
    """Warm ONE book's frame and screening, in the background.

    The first fit on a cold server paid the panel load and the design build
    inside the user's click — thirty seconds of which twenty were loading a
    parquet the server could have loaded while the user was still choosing
    variables. The frontend fires this when a book's workspace opens; by the
    time a human has read the candidate list, the frame is hot. This is
    per-book and demand-driven — not the all-books warm-up, which costs ~9 GB
    and stays opt-in."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    with _WARM_LOCK:
        if _WARM.get(key, {}).get("stage") not in (None, "", "ready", "failed"):
            return {"status": "warming", "portfolio": key}
        _WARM[key] = {"stage": "panel", "started": _time.time(), "error": ""}

    def say(stage: str, error: str = "") -> None:
        with _WARM_LOCK:
            _WARM[key] = {"stage": stage, "error": error,
                          "started": _WARM.get(key, {}).get("started", _time.time())}

    def run() -> None:
        try:
            say("panel")
            store.load(key)
            say("frame")
            store.analysis_frame(key)
            say("screen")
            _screen_all(key)
            say("ready")
        except Exception as e:                                          # noqa: BLE001
            say("failed", f"{type(e).__name__}: {e}")

    _threading.Thread(target=run, daemon=True).start()
    return {"status": "warming", "portfolio": key}


# What a book's first visit is doing, so the surface can narrate it. A 22
# million row tape takes the better part of a minute to read, join and screen,
# and the page showed only pulsing skeletons for all of it — indistinguishable
# from a hang.
_WARM: dict[str, dict] = {}
_WARM_LOCK = _threading.Lock()

WARM_STAGES = [
    ("panel", "Reading the panel"),
    ("frame", "Joining account attributes"),
    ("screen", "Screening the columns"),
]


@app.get("/api/portfolios/{key}/warm-status")
def warm_status(key: str):
    """Which stage this book's first load has reached, and for how long."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    with _WARM_LOCK:
        w = dict(_WARM.get(key) or {})
    stage = w.get("stage") or ""
    labels = dict(WARM_STAGES)
    return {
        "portfolio": key, "stage": stage,
        "label": labels.get(stage, "Ready" if stage == "ready" else ""),
        "stages": [{"key": k, "label": lbl} for k, lbl in WARM_STAGES],
        "elapsed_s": round(_time.time() - w["started"], 1) if w.get("started") else None,
        "error": w.get("error", ""),
    }


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
                # on the Panel surface. It was absent from this list, so the one
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
from ..models.naming import friendly_name, lgd_display                  # noqa: E402
from ..models.spec import (LGD_MACRO, LgdSpec, MevSpec, ModelSpec,  # noqa: E402
                           SampleSpec, VariableSpec)


class FitRequest(BaseModel):
    portfolio: str
    variables: list[dict] = []
    mevs: list[dict] = []
    estimator: str = "logistic"
    regularization: float = 1.0
    # Off unless the request carries a saved specification that recorded it:
    # nothing enters a model automatically.
    seasoning_spline: bool = False
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
        # The pair hash above identifies the MODEL (PD with the severity spec
        # embedded at fit time); this one identifies the PD half alone, and is
        # what the band's PD cell shows. Without it the PD cell displayed the
        # pair hash — the same string as the model cell — which made the two
        # halves look like one identity.
        "pd_hash": r.spec.pd_hash(),
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


# ── Fitting as a JOB ────────────────────────────────────────────────────────
#
# /api/fit above answers inside the request, which is right for the generated
# panels: three million account-months fit in under ten seconds. It is wrong
# for an ingested tape. The Santander book is twenty-two million account-months
# and a fit is three to five minutes, and holding an HTTP request open that
# long fails in four separate ways:
#
#   - the browser aborted at 45s and showed an error for work that was fine;
#   - the abort disconnects the client, FastAPI cancels the handler, and the
#     minutes already spent are DISCARDED — the retry starts from nothing;
#   - a reverse proxy in front of this closes an idle connection long before
#     five minutes, so the request never survives outside a dev machine;
#   - closing the tab kills the run.
#
# So the long path submits a job and polls, the same shape /api/data/generate
# already uses. The result is not returned by the poll: `modelsvc.run` caches
# by specification hash, so once the job says done the client collects the
# payload from /api/models/{hash} — one way for a finished model to be read,
# whoever asks and whenever.
#
# Phases are reported as they start, so the bar shows where the fit actually
# is rather than pacing itself off the previous run's timings.
# One registry for every long job, whatever it computes. A job whose result
# can be fetched by hash afterwards — a PD fit, read back from /models/{hash} —
# leaves `result` empty. A job with nowhere else to keep its answer — an ECL
# projection, which is not cached under a retrievable key — parks the payload
# here and the status call hands it over on completion.
_FITS: dict[str, dict] = {}
_FITS_LOCK = _threading.Lock()
MAX_FIT_JOBS = 24


def _job_snapshot(hash_: str, j: dict | None, *, with_result: bool = False) -> dict:
    """Format one job entry. Takes NO lock — the caller already read `j`."""
    if j is None:
        return {"hash": hash_, "state": "unknown", "phase": "",
                "elapsed_s": 0.0, "error": ""}
    elapsed = (j["finished_at"] or _time.time()) - j["started_at"]
    out = {"hash": hash_, "state": j["state"], "phase": j["phase"],
           "elapsed_s": round(elapsed, 1), "error": j["error"]}
    if with_result and j["state"] == "done":
        out["result"] = j.get("result")
    return out


def _fit_state(hash_: str, *, with_result: bool = False) -> dict:
    with _FITS_LOCK:
        j = _FITS.get(hash_)
        j = dict(j) if j is not None else None
    return _job_snapshot(hash_, j, with_result=with_result)


def _start_job(hash_: str, work, first_phase: str):
    """Run `work(phase)` on a thread under `hash_`, or join the run in flight.

    `work` is handed a callback to name the phase it has reached, and whatever
    it returns is kept as the job's result. Idempotent on the hash: a second
    ask for the same thing joins the first rather than doubling the work.
    Returns None when a job was started or joined, or the existing state dict
    when one is already running.
    """
    with _FITS_LOCK:
        j = _FITS.get(hash_)
        if j is not None and j["state"] == "running":
            # Snapshot WITHOUT re-acquiring: _fit_state takes _FITS_LOCK,
            # which this thread already holds, and threading.Lock is not
            # reentrant. This exact call self-deadlocked whenever a fit was
            # requested twice while running — a double click, a retry, a
            # second tab — and the stuck holder then queued every fit and
            # status request in the process behind it forever. That one line
            # was the recurring "server died" of the past three days.
            return _job_snapshot(hash_, dict(j))
        if len(_FITS) >= MAX_FIT_JOBS:
            for k, v in list(_FITS.items()):
                if v["state"] != "running":
                    _FITS.pop(k)
                    break
        _FITS[hash_] = {"state": "running", "phase": first_phase, "error": "",
                        "started_at": _time.time(), "finished_at": None,
                        "result": None}

    def phase(name: str) -> None:
        with _FITS_LOCK:
            if hash_ in _FITS:
                _FITS[hash_]["phase"] = name

    def run() -> None:
        try:
            out = work(phase)
            state, err = "done", ""
        except Exception as e:                                          # noqa: BLE001
            out, state, err = None, "error", f"{type(e).__name__}: {e}"
        with _FITS_LOCK:
            if hash_ in _FITS:
                _FITS[hash_].update(state=state, error=err, result=out,
                                    finished_at=_time.time())

    _threading.Thread(target=run, daemon=True).start()
    return None


def _book_window(key: str) -> list[str]:
    pf = store.load(key)
    d = pf.panel["performance_date"]
    return [str(pd.Timestamp(d.min()).date()), str(pd.Timestamp(d.max()).date())]


def _book_oot_from(key: str) -> str:
    """The out-of-time boundary to propose for this book.

    An ingested tape states its own at ingestion, and that answer is the
    analyst's, so it is used verbatim. The synthetic books keep the compiled
    default — deriving one from the window would move their out-of-time split
    and every statistic measured on it."""
    rec = tapemod.record_for(key)
    if rec and rec.get("default_oot_from"):
        return str(rec["default_oot_from"])
    return sel.SelectionConfig.__dataclass_fields__["oot_from"].default


def _fit_window_note(key: str, oot_from: str) -> str:
    """A warning when the boundary leaves too little behind it to fit on.

    Search fits see only rows BEFORE this date. On a tape whose history is
    short, a boundary meant for an eighteen-year synthetic panel can leave a
    few weeks, where whole columns hold one value and the fit cannot run."""
    try:
        df, _ = store.screening_frame(key)
    except Exception:                                               # noqa: BLE001
        return ""
    cut = pd.Timestamp(oot_from)
    before = df[df["performance_date"] < cut]
    lo = pd.Timestamp(df["performance_date"].min())
    months = max(0, round((cut - lo).days / 30.44))
    target = PORTFOLIOS[key].target.column
    events = int(before[target].sum()) if target in before.columns else 0
    if len(before) == 0:
        return (f"No rows fall before {cut.date()}, so there is nothing to fit "
                f"on. This book starts {lo.date()}.")
    if months < 12 or events < 200:
        return (f"Only {len(before):,} of {len(df):,} rows and {events:,} "
                f"defaults fall before {cut.date()}, about {months} months of "
                f"history from {lo.date()}. A search fits on those rows alone; "
                "move the boundary later for a wider fitting window.")
    return ""


@app.get("/api/portfolios/{key}/concentration")
def concentration_for(key: str, column: str):
    """The book's drawn balance cut along any column, in readable bands.

    Numeric columns are banded on ROUND edges, not quantiles: deciles of
    balance are flat by construction and say nothing, while "50-59, 60-69,
    ..." is how a committee actually talks about LTV. The step is chosen so
    five to eight bands cover the 2nd to 98th percentile; categorical columns
    report their largest levels by balance."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    from ..models import ecl as ECL
    pf = store.load(key)
    book = ECL._as_of_frame(store.analysis_frame(key),
                            pf.panel["performance_date"].max())
    if column not in book.columns:
        raise HTTPException(400, f"{column!r} is not a column of the {key} panel")
    if "current_balance" not in book.columns:
        raise HTTPException(400, f"{key} has no current_balance; concentration "
                                 "is a share of drawn balance")
    exposure = pd.to_numeric(book["current_balance"], errors="coerce").fillna(0.0)
    col = book[column]
    numeric = pd.api.types.is_numeric_dtype(col)

    if numeric:
        v = pd.to_numeric(col, errors="coerce")
        ok = v.notna()
        if not ok.any():
            raise HTTPException(400, f"{column} holds no numeric values")
        lo, hi = float(v[ok].quantile(0.02)), float(v[ok].quantile(0.98))
        span = max(hi - lo, 1e-9)
        # A round step: 1, 2, 2.5 or 5 times a power of ten, aiming at ~6 bands.
        raw = span / 6
        mag = 10 ** np.floor(np.log10(raw))
        step = float(min((s for s in (1, 2, 2.5, 5, 10)
                          if s * mag >= raw), default=10) * mag)
        first = float(np.floor(lo / step) * step)
        edges = [first + i * step for i in range(1, 9) if first + i * step < hi]
        fmt = (lambda x: f"{x:,.0f}") if step >= 1 else (lambda x: f"{x:g}")
        labels = ([f"<{fmt(edges[0])}"]
                  + [f"{fmt(a)}-{fmt(b)}" for a, b in zip(edges, edges[1:])]
                  + [f"{fmt(edges[-1])}+"])
        band = pd.cut(v, [-np.inf, *edges, np.inf], labels=labels)
        order = labels
    else:
        band = col.astype(str)
        by_bal = exposure.groupby(band).sum().sort_values(ascending=False)
        keep = list(by_bal.index[:8])
        band = band.where(band.isin(keep), "other")
        order = keep + (["other"] if (~col.astype(str).isin(keep)).any() else [])

    sums = exposure.groupby(band.astype(str)).sum()
    tot = float(sums.sum()) or 1.0
    return _jsonable({
        "portfolio": key, "column": column,
        "kind": "numeric" if numeric else "categorical",
        "bands": [{"band": str(b), "exposure": float(sums.get(str(b), 0.0)),
                   "share": float(sums.get(str(b), 0.0) / tot)}
                  for b in order if str(b) in sums.index],
    })


@app.get("/api/debug/stacks")
def debug_stacks():
    """Every thread's Python stack, for diagnosing a hang in place.

    Read-only and cheap. This is how a wedged request is identified without
    attaching a debugger to the process."""
    import sys
    import traceback
    frames = sys._current_frames()
    return {str(tid): traceback.format_stack(frame)
            for tid, frame in frames.items()}


@app.post("/api/fit/start")
def fit_start(req: FitRequest):
    """Begin a fit in the background. Returns at once with its hash.

    Idempotent on the hash: asking twice for the same specification joins the
    run already going rather than starting a second one. A specification
    already in the cache comes back done immediately, so the client's poll
    resolves on its first tick and a refit of something seen before still
    feels instant.
    """
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    if not req.variables:
        raise HTTPException(400, "select at least one variable")
    spec = req.to_spec()
    hash_ = spec.hash()

    # NOTHING heavy runs in this request. Column validation reads the
    # analysis frame and the cache probe unpickles a stored run — a minute
    # each on a large cold book — and both used to run right here, so the
    # start call itself timed out on the client while the server was merely
    # busy. They now run on the job's own thread; a bad column comes back
    # through the poll as the job's error, in the same words.
    def work(phase):
        phase("prepare")
        try:
            _reject_unknown_columns(req.portfolio,
                                    [v.column for v in spec.variables],
                                    "variables")
            if spec.lgd is not None:
                _reject_unknown_columns(req.portfolio,
                                        [*spec.lgd.drivers,
                                         *spec.lgd.categoricals],
                                        "LGD drivers")
        except HTTPException as e:
            raise ValueError(e.detail) from e
        hit = modelsvc.cached(hash_)
        if hit is not None:
            return hit
        return modelsvc.run(spec, progress=phase)

    # The run is not kept here: modelsvc caches it under the same hash and
    # /api/models/{hash} is the one way a finished model is read.
    running = _start_job(hash_, work, "prepare")
    return running or _fit_state(hash_)


@app.get("/api/fit/status/{hash_}")
def fit_status(hash_: str):
    """Where a submitted fit has got to.

    `done` means the model is in the cache and /api/models/{hash_} will serve
    it. A job this process never started but whose model IS cached also reads
    done — a restart, or a fit that came from somewhere else, should not look
    like a failure to the client that is waiting on it.
    """
    s = _fit_state(hash_)
    if s["state"] == "unknown" and modelsvc.cached(hash_) is not None:
        s["state"] = "done"
    return s


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
    """The identity of a PD specification AND an LGD specification together.

    A Model is both halves: an ECL number is PD x LGD x EAD. But each half
    carries its OWN name, derived from its own hash, and the pair is displayed
    as the two names collated — never a third, freshly minted name. A third
    name breaks the thread the analyst is following: the search names a PD
    model on the leaderboard, and the workbench must still call it that, with
    or without a severity model beside it. (This replaces the earlier rule of
    refusing to name a half-built model; the half that exists is named, and
    the UI says which half is missing.)
    """
    spec = req.to_spec()
    missing = []
    if not spec.variables:
        missing.append("PD variables")
    lgd_present = spec.lgd is not None and spec.lgd.is_specified
    if not lgd_present:
        missing.append("LGD drivers")
    pd_name = friendly_name(spec.pd_hash()) if spec.variables else None
    lgd_name = lgd_display(spec.lgd) if lgd_present else None
    name = (f"{pd_name} · {lgd_name}" if pd_name and lgd_name
            else pd_name or lgd_name)
    return {
        "hash": spec.hash(), "complete": not missing, "missing": missing,
        "name": name, "pd_name": pd_name, "lgd_name": lgd_name,
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
                   stds=r.fit.stds, basis_maps=r.fit.basis_maps,
                   columns=r.fit.columns)
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


def _ecl_payload(r) -> dict:
    """One projection, as the wire sees it. Shared by the blocking endpoint and
    the job, so the two can never drift into reporting different shapes."""
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


def _ecl_run(req: EclRequest, progress=None):
    return scensvc.run(req.to_spec(), scenarios=req.scenarios, weights=req.weights,
                       custom=req.custom, fixed_ccf=req.fixed_ccf, cpr=req.cpr,
                       cap_to_fitted_range=req.cap_to_fitted_range,
                       bridge_from=req.bridge_from, bridge_to=req.bridge_to,
                       progress=progress)


def _ecl_view_key(req: EclRequest) -> str:
    """Semantic key for the finished PAYLOAD of a projection.

    The full ScenarioRun holds account-level material — a gigabyte on a large
    tape — so even a disk cache hit unpickled for half a minute and looked
    exactly like a re-run. The payload the page renders is kilobytes, so it is
    cached in its own right under everything that changes it: the model
    identity and every projection option, weights included (the run-level key
    ignores weights because they only rescale the weighted tile; the payload
    carries that tile, so here they count)."""
    spec = req.to_spec()
    key = (spec.hash(), tuple(req.scenarios),
           tuple(sorted((req.weights or {}).items())),
           tuple(sorted((k, tuple(sorted(v.items())))
                        for k, v in (req.custom or {}).items())),
           req.fixed_ccf, req.cpr, req.cap_to_fitted_range,
           req.bridge_from, req.bridge_to)
    return "eclview-" + _hashlib.sha256(repr(key).encode()).hexdigest()[:16]


def _ecl_view(req: EclRequest, progress=None) -> dict:
    """The projection payload, served from its own small cache when known."""
    vk = _ecl_view_key(req)
    hit = runcache.load(req.portfolio, "ecl", vk)
    if hit is not None:
        return hit
    payload = _ecl_payload(_ecl_run(req, progress))
    runcache.save(req.portfolio, "ecl", vk, payload)
    return payload


def _ecl_guard(req: EclRequest) -> None:
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    if not req.variables:
        raise HTTPException(400, "select at least one variable")


@app.post("/api/ecl")
def project_ecl(req: EclRequest):
    _ecl_guard(req)
    try:
        return _ecl_view(req)
    except Exception as e:                                              # noqa: BLE001
        raise HTTPException(400, f"{type(e).__name__}: {e}") from e


# The projection as a JOB, for the same reasons as the fit above: on an
# ingested tape it runs past two minutes, and a held-open request loses the
# work the moment anything interrupts it. Unlike a fit there is no
# /api/models/{hash} to read the answer back from, so the job keeps the
# payload and the status call hands it over once the run is done.
@app.post("/api/ecl/start")
def ecl_start(req: EclRequest):
    _ecl_guard(req)
    # The job id is the semantic view key, not a hash of the raw body: two
    # requests that mean the same projection join the same job even when the
    # JSON differs cosmetically.
    job = _ecl_view_key(req)
    hit = runcache.load(req.portfolio, "ecl", job)
    if hit is not None:
        # Known payload: answer done on the start call itself. Registering it
        # as a finished job keeps the status endpoint's contract for any poll
        # already in flight.
        with _FITS_LOCK:
            _FITS[job] = {"state": "done", "phase": "", "error": "",
                          "started_at": _time.time(),
                          "finished_at": _time.time(), "result": hit}
        return {"hash": job, "state": "done", "phase": "", "elapsed_s": 0.0,
                "error": "", "result": hit}
    running = _start_job(job, lambda phase: _ecl_view(req, phase), "pd_model")
    return running or _fit_state(job)


@app.get("/api/ecl/status/{job}")
def ecl_status(job: str):
    return _fit_state(job, with_result=True)


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
    # Severity views describe defaults whose severity was observed; on an
    # ingested tape the unreported rest are NaN, not zero.
    if "lgd_realised" in d.columns:
        d = d.loc[d["lgd_realised"].notna()]
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
    if "lgd_realised" not in d.columns:
        # A tape without realised losses has nothing to rank severity drivers
        # against. This used to fall through to a KeyError and a bare 500.
        raise HTTPException(
            400, "This book carries no realised severity (no lgd_realised column "
                 "was mapped), so severity drivers cannot be screened. Declare an "
                 "assumed severity on the LGD stage instead.")
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


class LgdAssumeRequest(BaseModel):
    portfolio: str
    value: float


@app.post("/api/lgd/assume")
def lgd_assume(req: LgdAssumeRequest):
    """Declare a flat severity for a book whose tape carries no realised
    losses. Not a fit: the value is recorded in the specification, hashed like
    any other choice, and the loss number scales one-for-one with it. Refused
    where realised severity exists — there, fit the model."""
    if req.portfolio not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {req.portfolio!r}")
    if "lgd_realised" in store.load(req.portfolio).panel.columns:
        raise HTTPException(400,
            "This book carries realised severities, so a severity model can "
            "be fitted on it. An assumption is only offered where nothing "
            "can be estimated.")
    if not 0.0 < req.value < 1.0:
        raise HTTPException(422, "an assumed severity must be strictly "
                                 "between 0 and 1")
    spec = LgdSpec(portfolio=req.portfolio, assumed_lgd=float(req.value))
    m = scensvc.lgd_model(req.portfolio, spec)
    return _jsonable({
        "portfolio": req.portfolio, "spec": spec.to_dict(), "hash": spec.hash(),
        "name": lgd_display(spec), "assumed": True,
        "mean_lgd": m.mean_lgd, "n_defaults": 0, "note": m.fit_note,
    })


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
        "name": friendly_name(spec.hash(), kind="lgd"),
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
    # The rationale captured at the fork gate, and the search row this
    # specification entered the workspace as. Both are recorded on the version
    # so the lineage graph can explain every edge and every root.
    fork: dict | None = None
    origin: dict | None = None
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
    if spec.lgd is None or not spec.lgd.is_specified:
        return {}
    if spec.lgd.assumed_lgd is not None:
        # Nothing was estimated, so there is nothing to backtest. The
        # assumption's basis is recorded instead of a fabricated error.
        return {"lgd_basis": "assumed",
                "lgd_basis_note": f"declared flat severity "
                                  f"{spec.lgd.assumed_lgd:.0%}, not estimated",
                "lgd_mean_predicted": float(spec.lgd.assumed_lgd)}
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
    if spec.lgd is None or not spec.lgd.is_specified:
        raise HTTPException(
            400, "fit an LGD model before naming this one, or declare an assumed "
                 "severity on a book whose tape carries no realised losses. A "
                 "Model ID covers the PD specification and the severity "
                 "specification together, because both of them produced the loss "
                 "number.")
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
                    replaces=req.replaces, fork=req.fork, origin=req.origin)
    return _jsonable(_version_payload(v))


def _version_payload(v) -> dict:
    return {**v.to_dict(), "data_is_current": v.data_is_current(),
            "current_data_fingerprint": vstore.data_fingerprint(v.portfolio)}


@app.get("/api/versions")
def list_versions(portfolio: str | None = None):
    return _jsonable([_version_payload(v) for v in vstore.list_all(portfolio)])


# The static paths MUST register before the parameterised one: FastAPI
# matches in registration order, so /versions/{hash_} placed first swallowed
# "compare" and "lineage" as hashes and 404ed both — silently, since the
# frontend treated the errors as empty panels and retried on every mount.
@app.get("/api/versions/compare")
def compare_versions(hashes: str = Query(...)):
    hs = [h.strip() for h in hashes.split(",") if h.strip()][:4]
    if len(hs) < 2:
        raise HTTPException(400, "select at least two versions to compare")
    return _jsonable(vstore.compare(hs))


@app.get("/api/versions/lineage")
def version_lineage(portfolio: str = Query(...)):
    return _jsonable(vstore.lineage(portfolio))


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


@app.post("/api/workspace/reset")
def reset_workspace():
    """Clear the server's share of "Start from scratch".

    The browser reset only ever cleared localStorage, so saved versions, their
    promoted champions and the selection review state survived it: the roll-up
    reopened on a champion and a loss figure from the previous session. That is
    exactly the artifact a reset exists to remove.

    The generated panels are NOT touched. They are expensive to rebuild, they
    are not user work, and every cache that depends on them is already keyed by
    the data fingerprint. Versions are archived rather than deleted, so a demo
    reset can never be the thing that loses real work.
    """
    moved = vstore.archive_all()
    # Ingested books go too: they register themselves on every start, so a
    # reset that left them made "from scratch" reopen with last session's
    # tape already loaded. Archived alongside the versions, never deleted.
    moved["ingested_books"] = tapemod.archive_all()
    store.clear()
    rollupsvc.clear_cache()
    _SEL_RESULTS.clear()
    _LSEL_RESULTS.clear()
    with _SEL_LOCK:
        _SEL.clear()
        _LSEL.clear()
    return moved


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


# ── automated selection ──────────────────────────────────────────────────────
from fastapi.responses import PlainTextResponse                         # noqa: E402

from ..models import selection as sel                                   # noqa: E402
from ..models import selection_store as selstore                        # noqa: E402

# One search at a time per portfolio, tracked the same way data generation is:
# a module dict under a lock, mutated by a daemon thread, read by a polled
# status endpoint. The progress labels are the product here — a run is minutes
# long, and the person waiting is owed the step, the count and what exactly is
# being fitted, not a spinner.
_SEL: dict[str, dict] = {}
_SEL_LOCK = _threading.Lock()
_SEL_CANCEL: dict[str, _threading.Event] = {}

# In-memory memo of finished payloads, cleared with every other derived cache.
_SEL_RESULTS: dict[tuple[str, str], dict] = {}
store.register_dependent_cache(_SEL_RESULTS.clear)


class SelectionRunRequest(BaseModel):
    config: dict | None = None
    config_id: str | None = None
    save_as: str | None = None      # also store the config for reuse


def _selection_config(key: str, body: SelectionRunRequest) -> sel.SelectionConfig:
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    raw = body.config
    if body.config_id and raw is None:
        rec = selstore.load_config(key, body.config_id)
        if rec is None:
            raise HTTPException(404, f"no saved configuration {body.config_id!r} "
                                     f"on the {key} book")
        raw = rec["config"]
    if raw is None:
        raise HTTPException(400, "a configuration is required: pass config or "
                                 "config_id")
    try:
        cfg = sel.SelectionConfig.from_dict({**raw, "portfolio": key})
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")
    _reject_unknown_columns(key, [c.column for c in cfg.candidates],
                            "candidate variables")
    _reject_unknown_columns(key, cfg.expert_core or [], "expert core variables")
    if not any(c.role == "candidate" for c in cfg.candidates):
        raise HTTPException(400, "no candidate variables: mark at least one "
                                 "column as a candidate")
    panel_cols = set(mevpanel.monthly_panel().columns)
    unknown = sorted({m.key for m in sel.mev_variants(cfg)
                      if m.key not in panel_cols})
    if unknown:
        raise HTTPException(400, "macro terms not in the published panel: "
                            + ", ".join(unknown))
    return cfg


@app.get("/api/selection/{key}/defaults")
def selection_defaults(key: str):
    """Everything the setup screen needs prefilled: the screened candidate
    list with its warnings and the default rules. The macro terms come from
    the MEV surface's shortlist, which lives client-side; the search takes
    them verbatim rather than offering a second picker here."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    screen_rows = _screen_all(key)["rows"]
    spec = PORTFOLIOS[key]
    candidates = []
    for r in screen_rows:
        col = r.get("column")
        if not col or r.get("error"):
            continue
        candidates.append({
            "column": col, "kind": r.get("kind"),
            "iv": r.get("iv"), "iv_band": r.get("iv_band"),
            "above_null": r.get("above_null"),
            "leakage_risk": r.get("leakage_risk"),
            "missing_pct": r.get("missing_pct"),
            "expected_sign": spec.expected_signs.get(col),
            "cyclical": any(m in col.lower() for m in sel.CYCLICAL_MARKERS),
        })
    return _jsonable({
        "portfolio": key,
        "candidates": candidates,
        "scenarios": sel.available_scenarios(),
        "rules": {f: getattr(sel.SelectionRules(), f)
                  for f in sel.SelectionRules.__dataclass_fields__},
        # The BOOK's own out-of-time date, stated at ingestion, with the
        # window it sits in. A fixed 2023-01-01 belongs to the synthetic
        # books, whose panels run from 2008; on a tape that starts in 2022 it
        # left the search fitting on a few weeks of rows, where whole columns
        # hold one value and nothing can be estimated.
        "oot_from": (oot := _book_oot_from(key)),
        "window": _book_window(key),
        "fit_window_note": _fit_window_note(key, oot),
        "reason_codes": selstore.REASON_CODES,
    })


@app.post("/api/selection/{key}/preview")
def selection_preview(key: str, body: SelectionRunRequest):
    cfg = _selection_config(key, body)
    return _jsonable(sel.preview(cfg))


@app.post("/api/selection/{key}/run")
def selection_run(key: str, body: SelectionRunRequest):
    cfg = _selection_config(key, body)
    with _SEL_LOCK:
        state = _SEL.get(key, {})
        if state.get("state") == "running":
            return {"state": "running", "config_hash": state.get("config_hash")}
        cancel = _threading.Event()
        _SEL_CANCEL[key] = cancel
        _SEL[key] = {"state": "running", "config_hash": cfg.hash(),
                     "stage_no": 1, "n_stages": sel.N_STAGES,
                     "step": 0, "total": 0, "label": "Starting",
                     "n_combos": None, "started_at": _time.time(), "error": ""}
    if body.save_as:
        selstore.save_config(cfg, name=body.save_as)

    def progress(stage_no: int, n_stages: int, step: int, total: int,
                 label: str) -> None:
        with _SEL_LOCK:
            _SEL[key].update(stage_no=stage_no, n_stages=n_stages,
                             step=step, total=total, label=label)

    def checkpoint(payload: dict) -> None:
        runcache.save(key, "selection", cfg.hash(), payload)

    def run() -> None:
        try:
            payload = sel.run_search(cfg, progress=progress, cancel=cancel,
                                     checkpoint=checkpoint)
            runcache.save(key, "selection", cfg.hash(), payload)
            _SEL_RESULTS[(key, cfg.hash())] = payload
            with _SEL_LOCK:
                _SEL[key].update(state="done", label="Done",
                                 n_combos=payload["n_combos"])
        except sel.Cancelled:
            with _SEL_LOCK:
                _SEL[key].update(state="cancelled", label="Cancelled")
        except Exception as e:                                          # noqa: BLE001
            # A ValueError here is a deliberate refusal written for the
            # analyst — "chargedoffPrincipalAmount holds a single value on
            # the rows before the out-of-time date". Prefixing it with the
            # exception type turns a sentence into a stack trace. Anything
            # else is unexpected, and the type is part of the evidence.
            with _SEL_LOCK:
                _SEL[key].update(
                    state="error",
                    error=str(e) if isinstance(e, ValueError)
                    else f"{type(e).__name__}: {e}")

    _threading.Thread(target=run, daemon=True).start()
    return {"state": "running", "config_hash": cfg.hash()}


@app.get("/api/selection/{key}/status")
def selection_status(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    with _SEL_LOCK:
        s = dict(_SEL.get(key) or {"state": "idle"})
    if s.get("state") == "running":
        s["elapsed_s"] = round(_time.time() - s.pop("started_at", _time.time()), 1)
    else:
        s.pop("started_at", None)
    return _jsonable(s)


@app.post("/api/selection/{key}/cancel")
def selection_cancel(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    ev = _SEL_CANCEL.get(key)
    if ev is not None:
        ev.set()
    return {"state": "cancelling"}


def _selection_results(key: str, config_hash: str) -> dict:
    memo = _SEL_RESULTS.get((key, config_hash))
    if memo is not None:
        return memo
    payload = runcache.load(key, "selection", config_hash)
    if payload is None:
        raise HTTPException(
            404, "no completed search for this configuration on the current "
                 "data. Run the search.")
    _SEL_RESULTS[(key, config_hash)] = payload
    return payload


@app.get("/api/selection/{key}/results")
def selection_results(key: str, config: str = Query(...)):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    payload = _selection_results(key, config)
    from ..models.versions import data_fingerprint
    return _jsonable({
        **payload,
        "current": payload.get("data_fingerprint") == data_fingerprint(key),
    })


# ── selection configurations ─────────────────────────────────────────────────
class ConfigSaveRequest(BaseModel):
    config: dict
    name: str


@app.post("/api/selection/{key}/configs")
def selection_config_save(key: str, body: ConfigSaveRequest):
    """Store a configuration WITHOUT running it.

    The run endpoint's `save_as` only fires when the run actually starts, so
    while a search was in flight there was no way to save at all — the button
    sat disabled and the name went nowhere.
    """
    cfg = _selection_config(key, SelectionRunRequest(config=body.config))
    if not body.name.strip():
        raise HTTPException(422, "a saved configuration needs a name")
    return _jsonable(selstore.save_config(cfg, name=body.name.strip()))


@app.get("/api/selection/{key}/configs")
def selection_configs(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    return _jsonable({"configs": selstore.list_configs(key)})


@app.get("/api/selection/{key}/configs/{config_id}")
def selection_config_get(key: str, config_id: str):
    rec = selstore.load_config(key, config_id)
    if rec is None:
        raise HTTPException(404, f"no saved configuration {config_id!r} on "
                                 f"the {key} book")
    return _jsonable(rec)


@app.delete("/api/selection/{key}/configs/{config_id}")
def selection_config_delete(key: str, config_id: str):
    if not selstore.delete_config(key, config_id):
        raise HTTPException(404, f"no saved configuration {config_id!r} on "
                                 f"the {key} book")
    return {"deleted": config_id}


# ── selection review ─────────────────────────────────────────────────────────
class ReviewRowRequest(BaseModel):
    reviewer: str
    status: str | None = None
    reason_code: str | None = None
    justification: str | None = None
    user_rank: int | None = None


class ReviewOrderRequest(BaseModel):
    reviewer: str
    order: list[str]
    justifications: dict[str, str] = {}


def _auto_ranks(key: str, config_hash: str) -> dict[str, int | None]:
    payload = _selection_results(key, config_hash)
    return {r["hash"]: r.get("auto_rank") for r in payload["rows"]}


@app.get("/api/selection/{key}/review")
def selection_review(key: str, config: str = Query(...)):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    return _jsonable(selstore.load_review(key, config))


# Declared before the {model_hash} route: FastAPI matches in order, and a
# model hash named "order" does not exist (hashes are hex).
@app.post("/api/selection/{key}/review/order")
def selection_review_order(key: str, body: ReviewOrderRequest,
                           config: str = Query(...)):
    auto = _auto_ranks(key, config)
    unknown = [h for h in body.order if h not in auto]
    if unknown:
        raise HTTPException(404, "not on this leaderboard: "
                            + ", ".join(unknown))
    try:
        review = selstore.reorder(key, config, body.order,
                                  reviewer=body.reviewer, auto_ranks=auto,
                                  justifications=body.justifications)
    except selstore.ReviewError as e:
        raise HTTPException(400, str(e))
    return _jsonable(review)


@app.post("/api/selection/{key}/review/{model_hash}")
def selection_review_row(key: str, model_hash: str, body: ReviewRowRequest,
                         config: str = Query(...)):
    auto = _auto_ranks(key, config)
    if model_hash not in auto:
        raise HTTPException(404, f"model {model_hash!r} is not on this "
                                 f"leaderboard")
    try:
        review = selstore.update_row(
            key, config, model_hash,
            # only the fields the client actually sent — a partial update must
            # not blank the ones it left out
            body.model_dump(exclude={"reviewer"}, exclude_unset=True),
            reviewer=body.reviewer, auto_rank=auto[model_hash])
    except selstore.ReviewError as e:
        raise HTTPException(400, str(e))
    return _jsonable(review)


@app.get("/api/selection/{key}/review/export")
def selection_review_export(key: str, config: str = Query(...)):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    csv_text = selstore.export_csv(key, config)
    return PlainTextResponse(csv_text, media_type="text/csv", headers={
        "Content-Disposition":
            f"attachment; filename=selection-review-{key}-{config}.csv"})


# ── roll-up ──────────────────────────────────────────────────────────────────


@app.get("/api/rollup")
def rollup(tornado: bool = True, select: str = Query("")):
    """Every book on one page.

    `select` is `portfolio:version_hash` pairs and overrides which saved model a
    book is reported on. Absent, each book uses its champion; a book with
    neither champion nor selection contributes NOTHING and is reported in
    `not_covered` — no default stands in. A selection that differs from the
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
        "not_covered": r.not_covered,
        "champions": {k: (v.to_dict() if v else None) for k, v in champs.items()},
        "note": ("Each book is projected with its promoted champion, or with the "
                 "saved version selected for it. Books with neither are not "
                 "included."),
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
# ── automated severity selection ─────────────────────────────────────────────
# The LGD twin of the selection block above: same job shape (a module dict
# under the same lock discipline, a daemon thread, a polled status endpoint
# with verbose per-fit labels), same cache pattern (runcache kind
# "lgd_selection" keyed by config hash), different model and yardstick.
from ..models import lgd_selection as lgdsel                            # noqa: E402

_LSEL: dict[str, dict] = {}
_LSEL_CANCEL: dict[str, _threading.Event] = {}
_LSEL_RESULTS: dict[tuple[str, str], dict] = {}
store.register_dependent_cache(_LSEL_RESULTS.clear)


def _lgd_selection_config(key: str, body: SelectionRunRequest) -> "lgdsel.LgdSelectionConfig":
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    raw = body.config
    if raw is None:
        raise HTTPException(400, "a configuration is required: pass config")
    try:
        cfg = lgdsel.LgdSelectionConfig.from_dict({**raw, "portfolio": key})
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")
    _reject_unknown_columns(key, cfg.candidates, "severity driver candidates")
    _reject_unknown_columns(key, cfg.expert_core or [],
                            "expert severity core variables")
    if not cfg.candidates:
        raise HTTPException(400, "no candidate drivers: pass at least one "
                                 "severity driver column")
    panel_cols = set(mevpanel.monthly_panel().columns)
    unknown = sorted({lgdsel.parse_term(t).key for t in cfg.mev_terms
                      if lgdsel.parse_term(t).key not in panel_cols})
    if unknown:
        raise HTTPException(400, "macro terms not in the published panel: "
                                 + ", ".join(unknown))
    return cfg


@app.get("/api/lgd-selection/{key}/defaults")
def lgd_selection_defaults(key: str):
    """Ranked severity-driver candidates plus the default search rules, so
    the surface seeds itself the same way the PD setup does."""
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    cand = scensvc.LGD.candidates(store.analysis_frame(key), key,
                                  mevpanel.monthly_panel())
    return _jsonable({
        "candidates": cand,
        "rules": vars(sel.SelectionRules()),
        "oot_from": _book_oot_from(key),
        "fit_window_note": _fit_window_note(key, _book_oot_from(key)),
    })


@app.post("/api/lgd-selection/{key}/run")
def lgd_selection_run(key: str, body: SelectionRunRequest):
    cfg = _lgd_selection_config(key, body)
    with _SEL_LOCK:
        state = _LSEL.get(key, {})
        if state.get("state") == "running":
            return {"state": "running", "config_hash": state.get("config_hash")}
        cancel = _threading.Event()
        _LSEL_CANCEL[key] = cancel
        _LSEL[key] = {"state": "running", "config_hash": cfg.hash(),
                      "stage_no": 1, "n_stages": lgdsel.N_STAGES,
                      "step": 0, "total": 0, "label": "Starting",
                      "n_combos": None, "started_at": _time.time(), "error": ""}

    def progress(stage_no, n_stages, step, total, label):
        with _SEL_LOCK:
            _LSEL[key].update(stage_no=stage_no, n_stages=n_stages,
                              step=step, total=total, label=label)

    def checkpoint(payload):
        runcache.save(key, "lgd_selection", cfg.hash(), payload)

    def run():
        try:
            payload = lgdsel.run_search(cfg, progress=progress, cancel=cancel,
                                        checkpoint=checkpoint)
            runcache.save(key, "lgd_selection", cfg.hash(), payload)
            _LSEL_RESULTS[(key, cfg.hash())] = payload
            with _SEL_LOCK:
                _LSEL[key].update(state="done", label="Done",
                                  n_combos=payload["n_combos"])
        except sel.Cancelled:
            with _SEL_LOCK:
                _LSEL[key].update(state="cancelled", label="Cancelled")
        except Exception as e:                                          # noqa: BLE001
            with _SEL_LOCK:
                _LSEL[key].update(state="error", error=f"{type(e).__name__}: {e}")

    _threading.Thread(target=run, daemon=True).start()
    return {"state": "running", "config_hash": cfg.hash()}


@app.get("/api/lgd-selection/{key}/status")
def lgd_selection_status(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    with _SEL_LOCK:
        return dict(_LSEL.get(key) or {"state": "idle"})


@app.post("/api/lgd-selection/{key}/cancel")
def lgd_selection_cancel(key: str):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    ev = _LSEL_CANCEL.get(key)
    if ev is not None:
        ev.set()
    return {"state": "cancelling"}


@app.get("/api/lgd-selection/{key}/results")
def lgd_selection_results(key: str, config: str = Query(...)):
    if key not in PORTFOLIOS:
        raise HTTPException(404, f"unknown portfolio {key!r}")
    memo = _LSEL_RESULTS.get((key, config))
    if memo is None:
        memo = runcache.load(key, "lgd_selection", config)
        if memo is None:
            raise HTTPException(
                404, "no completed severity search for this configuration on "
                     "the current data. Run the search.")
        _LSEL_RESULTS[(key, config)] = memo
    from ..models.versions import data_fingerprint
    return _jsonable({
        **memo,
        "current": memo.get("data_fingerprint", data_fingerprint(key))
        == data_fingerprint(key),
    })


# ── loan tape ingestion ──────────────────────────────────────────────────────
# A validation gate, not a preparation engine: the file must already be a
# panel. See creditiq/data/tapes.py and docs/CECL-FORK.md for the boundary.
from fastapi import File, Form, UploadFile                              # noqa: E402

from ..data import tapes as tapemod                                     # noqa: E402


@app.get("/api/tapes/schema")
def tapes_schema():
    return {"schema": tapemod.SCHEMA, "required": tapemod.REQUIRED}


@app.get("/api/tapes")
def tapes_list():
    return _jsonable({"tapes": tapemod.records()})


@app.post("/api/tapes/inspect")
async def tapes_inspect(file: UploadFile = File(...)):
    """Stage the upload and report its columns beside the canonical schema,
    with a suggested mapping. Nothing is registered here."""
    content = await file.read()
    if len(content) > 512 * 1024 * 1024:
        raise HTTPException(400, "file over 512 MB — export a parquet, or "
                                 "trim the tape")
    try:
        return _jsonable(tapemod.stage(file.filename or "tape.csv", content))
    except ValueError as e:
        raise HTTPException(400, str(e))


class TapeIngestRequest(BaseModel):
    token: str
    key: str
    label: str
    mapping: dict[str, str | None] = {}
    # What default MEANS on this tape, in the uploader's words. Required:
    # it is the single most important fact about the target, and the app
    # cannot infer it from a column of ones and zeroes.
    default_definition: str
    # How the supplied LGD was calculated. Required when lgd_realised is
    # mapped, ignored otherwise.
    lgd_definition: str = ""
    # Re-ingesting over an existing ingested book: a corrected mapping, or
    # next period's file. Refused for the synthetic books.
    replace: bool = False
    ead_method: str = "amortizing"
    oot_from: str = "2023-01-01"


@app.get("/api/tapes/ingest-progress/{token}")
def tapes_ingest_progress(token: str):
    """The running ingest's current stage, for the frontend to poll.

    A large tape spends real time reading, checking and writing; the stage on
    screen is what distinguishes work in progress from a hang."""
    return tapemod.ingest_progress(token) or {"stage": None, "elapsed_s": None}


@app.post("/api/tapes/ingest")
def tapes_ingest(req: TapeIngestRequest):
    try:
        record = tapemod.ingest(
            token=req.token, key=req.key, label=req.label,
            mapping={k: v for k, v in req.mapping.items() if v},
            default_definition=req.default_definition,
            ead_method=req.ead_method, oot_from=req.oot_from,
            replace=req.replace, lgd_definition=req.lgd_definition)
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        tapemod.clear_progress(req.token)
    # A replaced book invalidates everything cached under its key, and the
    # per-key caches offer no selective eviction, so replacement clears the
    # store. A NEW key was never cached: clearing the whole store for it made
    # the next /api/portfolios reload every book's panel from disk — the
    # minute of dead skeletons right after adding a tape. The roll-up cache
    # goes either way, because the set of books changed.
    if req.replace:
        store.clear()
    rollupsvc.clear_cache()
    return _jsonable(record)


class TapeRemapRequest(BaseModel):
    """A correction to an ingested book, applied to the stored data."""
    changes: dict[str, str | None] = {}
    label: str | None = None
    default_definition: str | None = None
    ead_method: str | None = None
    oot_from: str | None = None


@app.patch("/api/tapes/{key}")
def tapes_remap(key: str, req: TapeRemapRequest):
    """Correct a mapping or an answer without re-uploading the file.

    The original upload is not kept, but nothing in it was discarded either:
    every column is in the stored book, mapped ones under their canonical
    name and the rest under the seller's. So a mis-mapped column is a rename,
    not a re-ingestion."""
    try:
        rec = tapemod.remap(
            key, changes=req.changes, label=req.label,
            default_definition=req.default_definition,
            ead_method=req.ead_method, oot_from=req.oot_from)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    store.clear()
    rollupsvc.clear_cache()
    return _jsonable(rec)


@app.delete("/api/tapes/{key}")
def tapes_delete(key: str):
    if not tapemod.remove(key):
        raise HTTPException(404, f"no ingested tape named {key!r} — synthetic "
                                 "books cannot be removed here")
    store.clear()
    rollupsvc.clear_cache()
    return {"deleted": key}


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
