"""Design matrix construction.

Turns a ModelSpec into the numeric matrix the estimator sees. Three transforms:

  woe     the scorecard convention — each bin replaced by its weight of evidence.
          Monotone by construction if the binning is, robust to outliers, and it
          gives coefficients an interpretation a credit officer already knows.

  raw     the variable z-scored. Keeps full resolution; costs the outlier
          robustness and the automatic handling of missing values.

  spline  a piecewise-linear basis. For a driver whose effect genuinely bends —
          seasoning above all — where binning would throw the shape away.

Macro terms carry their own transform and lag, applied to the monthly MEV panel
and joined on performance date. Seasoning enters as a spline whenever it is
switched on, because the age profile of a hazard is a hump and a single linear
term cannot represent it.

One rule matters more than the rest: a test or out-of-time slice is transformed
with the TRAINING binning, never re-binned. Re-binning on the test set fits the
transform to the test target and leaks it into the score.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..analysis.binning import bin_categorical, bin_numeric
from ..mev.panel import monthly_panel
from .spec import MevSpec, ModelSpec, VariableSpec

SEASONING_KNOTS = (3, 6, 12, 24, 36, 60, 96, 144)


# WoE maps are cached on (portfolio, column, edges, groups). In a real session an
# analyst changes ONE variable at a time, so without this every refit re-runs the
# optimal binning for every variable that did not change — which was most of the
# design-matrix cost. The cache key includes the edges, so dragging an edge in the
# binning editor correctly misses and refits that variable only.
_WOE_CACHE: dict[tuple, dict] = {}

# Transformed COLUMN vectors, cached on (portfolio, rows, column, transform, map).
# When an analyst adds or removes one variable, every other column's transform is
# unchanged — recomputing all of them was most of the refit cost. Keyed on the row
# count as well, so the train slice and the full panel never collide.
_COL_CACHE: dict[tuple, np.ndarray] = {}
_COL_CACHE_MAX = 400


def clear_woe_cache() -> None:
    _WOE_CACHE.clear()
    _COL_CACHE.clear()


def _cache_col(key: tuple, build_fn) -> np.ndarray:
    v = _COL_CACHE.get(key)
    if v is None:
        v = build_fn()
        if len(_COL_CACHE) >= _COL_CACHE_MAX:
            _COL_CACHE.pop(next(iter(_COL_CACHE)))
        _COL_CACHE[key] = v
    return v


def _sample_for_bins(x: pd.Series, y: pd.Series) -> tuple[pd.Series, pd.Series]:
    """An event-preserving sample for fitting a binning. Every event is kept so a
    rare target is not made rarer; only non-events are thinned."""
    if len(x) <= BIN_FIT_ROWS:
        return x, y
    rng = np.random.default_rng(20260819)
    ev = np.flatnonzero(y.to_numpy() == 1)
    rest = np.flatnonzero(y.to_numpy() == 0)
    take = rng.choice(rest, size=max(BIN_FIT_ROWS - len(ev), 1000), replace=False)
    idx = np.concatenate([ev, take])
    return x.iloc[idx], y.iloc[idx]


@dataclass
class Design:
    X: np.ndarray
    columns: list[str]
    y: np.ndarray
    dates: np.ndarray
    accounts: np.ndarray
    woe_maps: dict[str, dict]
    means: np.ndarray
    stds: np.ndarray
    basis_maps: dict[str, dict] = field(default_factory=dict)

    @property
    def n(self) -> int:
        return self.X.shape[0]


def _woe_vector(x: pd.Series, y: pd.Series, v: VariableSpec) -> tuple[np.ndarray, dict]:
    """Replace each value by the weight of evidence of the bin it falls in."""
    numeric = pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > 12
    if numeric:
        b = bin_numeric(x, y, edges=v.edges)
        edges = b.edges or []
        idx = np.digitize(pd.to_numeric(x, errors="coerce").fillna(-np.inf), edges)
        real = [bn for bn in b.bins if not bn.is_special]
        woe = np.array([bn.woe for bn in real] or [0.0])
        out = woe[np.clip(idx, 0, len(woe) - 1)]
        special = next((bn.woe for bn in b.bins if bn.is_special), 0.0)
        out = np.where(x.isna().to_numpy(), special, out)
        m = {"kind": "numeric", "edges": edges, "woe": [float(w) for w in woe],
             "missing_woe": float(special), "iv": b.iv,
             "labels": [bn.label for bn in real]}
    else:
        b = bin_categorical(x, y, groups=v.groups)
        lookup: dict[str, float] = {}
        for bn in b.bins:
            for lvl in (bn.levels or []):
                lookup[str(lvl)] = bn.woe
        special = next((bn.woe for bn in b.bins if bn.is_special), 0.0)
        cat = x.astype("category")
        lut = np.array([lookup.get(str(c), special) for c in cat.cat.categories], dtype=float)
        codes = cat.cat.codes.to_numpy()
        out = np.where(codes >= 0, lut[np.clip(codes, 0, len(lut) - 1)], special)
        m = {"kind": "categorical", "map": lookup, "missing_woe": float(special),
             "iv": b.iv, "groups": b.groups}
    return out.astype(float), m


def _dummy_matrix(x: pd.Series, m: dict) -> tuple[np.ndarray, list[str]]:
    """Indicator columns for a binning — k-1 of them, first bin as reference.

    The difference from WoE is the whole point of separating the two decisions.
    WoE spends ONE parameter and bakes the direction into the encoding: it
    assumes the fitted effect is proportional to the log-odds ratio the bins
    already showed. Dummies spend k-1 parameters and assume nothing — each bin
    gets its own free level, so a non-monotone or hook-shaped relationship
    survives contact with the model instead of being flattened.

    That freedom is not free. The column-cost readout in the UI exists so the
    analyst sees the price before choosing it.
    """
    if m["kind"] == "numeric":
        idx = np.digitize(pd.to_numeric(x, errors="coerce").fillna(-np.inf), m["edges"])
        n_bins = len(m["woe"])
        labels = m.get("labels") or [f"bin{i}" for i in range(n_bins)]
        idx = np.clip(idx, 0, max(n_bins - 1, 0))
        miss = x.isna().to_numpy()
    else:
        cat = x.astype("category")
        order = list(m["map"].keys())
        pos = {lvl: i for i, lvl in enumerate(order)}
        lut = np.array([pos.get(str(c), -1) for c in cat.cat.categories], dtype=np.int64)
        raw = cat.cat.codes.to_numpy()
        idx = np.where(raw >= 0, lut[np.clip(raw, 0, max(len(lut) - 1, 0))], -1)
        n_bins = len(order)
        labels = order
        miss = idx < 0
        idx = np.clip(idx, 0, max(n_bins - 1, 0))

    cols, names = [], []
    # the first bin is the reference level, so the design stays full rank
    for b in range(1, n_bins):
        cols.append(((idx == b) & ~miss).astype(float))
        names.append(f"={labels[b]}")
    if miss.any():
        cols.append(miss.astype(float))
        names.append("=Missing")
    if not cols:
        return np.zeros((len(x), 0)), []
    return np.column_stack(cols), names


def _apply_woe(x: pd.Series, m: dict) -> np.ndarray:
    if m["kind"] == "numeric":
        woe = np.asarray(m["woe"], dtype=float)
        idx = np.digitize(pd.to_numeric(x, errors="coerce").fillna(-np.inf), m["edges"])
        out = woe[np.clip(idx, 0, len(woe) - 1)]
        return np.where(x.isna().to_numpy(), m["missing_woe"], out)
    cat = x.astype("category")
    lut = np.array([m["map"].get(str(c), m["missing_woe"]) for c in cat.cat.categories],
                   dtype=float)
    codes = cat.cat.codes.to_numpy()
    out = np.where(codes >= 0, lut[np.clip(codes, 0, len(lut) - 1)], m["missing_woe"])
    return out.astype(float)


def _spline_basis(v: np.ndarray, knots, fitted: dict | None = None
                  ) -> tuple[np.ndarray, list[str], dict]:
    """Piecewise-linear spline basis, ORTHOGONALIZED.

    The raw hinge basis — the value plus max(value - knot, 0) at each knot — is
    the easy way to write a piecewise-linear spline and it is catastrophically
    collinear: every hinge is a truncated copy of the one before it. Fitted
    directly it produced variance inflation factors above 4,700 and a pair of
    coefficients of +21.5 and -21.8 that cancel to nothing. Those numbers are not
    wrong, but no validator will accept a specification card that shows them.

    A QR decomposition returns an orthonormal basis spanning EXACTLY the same
    function space, so the fitted seasoning curve is identical while the variance
    inflation drops to one. The individual coefficients then carry no separate
    meaning — which is honest, because a spline's shape is the quantity of
    interest, not its basis weights. The Model surface plots the curve.
    """
    def raw(vv, ks):
        cols = [vv.astype(float)]
        nm = ["value"]
        for kk in ks:
            cols.append(np.maximum(vv - kk, 0.0))
            nm.append(f"gt{kk}")
        return np.column_stack(cols), nm

    if fitted is not None:
        # APPLY a previously fitted basis. The knot set and the orthogonalising
        # map must both come from training: a projection ages accounts past knots
        # that were dead in the fit sample, which would otherwise change the
        # column count, and re-running QR on new data produces a DIFFERENT basis
        # spanning the same space — the fitted coefficients would then be applied
        # to the wrong vectors.
        B, _ = raw(v, fitted["knots"])
        B = (B - np.asarray(fitted["center"])) @ np.asarray(fitted["rinv"])
        B = B * np.asarray(fitted["signs"])
        return B, [f"basis{i + 1}" for i in range(B.shape[1])], fitted

    B, names = raw(v, knots)
    keep = B.std(axis=0) > 1e-9              # a knot beyond the data's range is dead
    live_knots = [k for k, kp in zip(knots, keep[1:]) if kp]
    B = B[:, keep]
    names = [n for n, k in zip(names, keep) if k]
    meta: dict = {"knots": live_knots}
    if B.shape[1] > 1:
        center = B.mean(axis=0)
        Bc = B - center
        Q, R = np.linalg.qr(Bc)
        signs = np.sign(np.sum(Q * Bc, axis=0))
        signs[signs == 0] = 1.0
        B = Q * signs
        names = [f"basis{i + 1}" for i in range(B.shape[1])]
        meta |= {"center": center.tolist(),
                 "rinv": np.linalg.pinv(R).tolist(), "signs": signs.tolist()}
    else:
        meta |= {"center": [0.0] * B.shape[1],
                 "rinv": np.eye(B.shape[1]).tolist(), "signs": [1.0] * B.shape[1]}
    return B, names, meta


def mev_series(spec: MevSpec) -> pd.Series:
    """One macro term, transformed and lagged, on the monthly grid."""
    panel = monthly_panel()
    if spec.key not in panel.columns:
        raise KeyError(f"unknown MEV {spec.key!r}")
    s = panel[spec.key].astype(float)
    if spec.transform == "yoy":
        s = (s / s.shift(12) - 1.0) * 100.0
    elif spec.transform == "log_diff":
        s = np.log(s.clip(lower=1e-9)).diff()
    elif spec.transform == "qoq_annualized":
        s = ((s / s.shift(3)) ** 4 - 1.0) * 100.0
    elif spec.transform == "four_quarter_change":
        s = s - s.shift(12)
    elif spec.transform == "z_score":
        s = (s - s.mean()) / (s.std(ddof=0) or 1.0)
    if spec.lag_months:
        s = s.shift(spec.lag_months)
    return s.rename(spec.label())


BIN_FIT_ROWS = 300_000


def build(df: pd.DataFrame, spec: ModelSpec,
          woe_maps: dict[str, dict] | None = None,
          means: np.ndarray | None = None,
          stds: np.ndarray | None = None,
          mev_override: pd.DataFrame | None = None,
          basis_maps: dict[str, dict] | None = None) -> Design:
    """Build the design matrix.

    When a variable has no stored edges the binning is fitted on an
    event-preserving sample rather than the full panel. Optimal binning is a
    constrained optimisation and running it over 1.7M rows per variable costs
    about four seconds of the two-second refit budget. A binning is a population
    statistic; fitting it on 300,000 rows and applying it to all of them changes
    the edges by less than the width of a bar on the chart. Whenever the analyst
    has set edges in the binning editor, they are used verbatim and no fit runs
    at all."""
    y = df[spec.target_column].to_numpy(np.int8)
    ys = pd.Series(y, index=df.index)
    blocks: list[np.ndarray] = []
    names: list[str] = []
    maps: dict[str, dict] = dict(woe_maps or {})
    bases: dict[str, dict] = dict(basis_maps or {})

    for v in spec.variables:
        if v.column not in df.columns:
            continue
        x = df[v.column]
        enc = v.encoder
        if enc in ("woe", "dummies", "ordinal"):
            if v.column in maps:
                m = maps[v.column]
            else:
                ck = (spec.portfolio, v.column, spec.target_column,
                      tuple(v.edges or ()), tuple(map(tuple, v.groups or ())),
                      round(v.shrinkage, 6))
                m = _WOE_CACHE.get(ck)
                if m is None:
                    xs, yss = _sample_for_bins(x, ys)
                    _, m = _woe_vector(xs, yss, v)
                    _WOE_CACHE[ck] = m
                maps[v.column] = m
            if enc == "woe":
                blocks.append(_apply_woe(x, m)[:, None])
                names.append(f"{v.column}_woe")
            elif enc == "dummies":
                B, sub = _dummy_matrix(x, m)
                if B.shape[1]:
                    blocks.append(B)
                    names += [f"{v.column}{t}" for t in sub]
            else:                                    # ordinal bin index
                idx = np.digitize(pd.to_numeric(x, errors="coerce").fillna(-np.inf),
                                  m.get("edges") or [])
                blocks.append(idx.astype(float)[:, None])
                names.append(f"{v.column}_bin")
        elif enc == "spline":
            col = pd.to_numeric(x, errors="coerce")
            b, sub, meta = _spline_basis(col.fillna(col.median()).to_numpy(),
                                         v.knots or SEASONING_KNOTS,
                                         fitted=bases.get(v.column))
            bases[v.column] = meta
            blocks.append(b); names += [f"{v.column}_{t}" for t in sub]
        else:                                        # scaled continuous
            col = pd.to_numeric(x, errors="coerce")
            blocks.append(col.fillna(col.median()).to_numpy(float)[:, None])
            names.append(v.column)

    # The automatic seasoning spline is on months_on_book. If the analyst has
    # ALSO selected months_on_book explicitly, adding both puts two bases of the
    # same variable into the design — exact collinearity. The ridge does not
    # error; it silently splits the effect in half across duplicated columns, and
    # every coefficient comes out at exactly half its true value.
    explicit_seasoning = any(v.column == "months_on_book" for v in spec.variables)
    if spec.seasoning_spline and not explicit_seasoning and "months_on_book" in df.columns:
        mob = df["months_on_book"].to_numpy(float)
        fitted = bases.get("__seasoning__")
        if fitted is not None:
            b, _, meta = _spline_basis(mob, SEASONING_KNOTS, fitted=fitted)
        else:
            sk = (spec.portfolio, "__seasoning__", len(df), int(df.index[0]))
            got = _COL_CACHE.get(sk)
            if got is None:
                b, _, meta = _spline_basis(mob, SEASONING_KNOTS)
                if len(_COL_CACHE) >= _COL_CACHE_MAX:
                    _COL_CACHE.pop(next(iter(_COL_CACHE)))
                _COL_CACHE[sk] = (b, meta)
            else:
                b, meta = got
        bases["__seasoning__"] = meta
        blocks.append(b); names += [f"seasoning_basis{i + 1}" for i in range(b.shape[1])]

    if spec.mevs:
        dates = pd.DatetimeIndex(df["performance_date"]).to_period("M").to_timestamp()
        for m in spec.mevs:
            mk = (spec.portfolio, "__mev__", m.key, m.transform, m.lag_months,
                  len(df), int(df.index[0]))

            def _mk(m=m):
                # A scenario projection supplies its OWN macro path: history plus
                # the spliced forward path. Falling back to the historical panel
                # here would silently project the future using the past, which is
                # the exact opposite of what a stress test is for.
                if mev_override is not None and m.key in mev_override.columns:
                    src = mev_override[m.key].astype(float)
                    if m.lag_months:
                        src = src.shift(m.lag_months)
                    vals = src.reindex(dates).to_numpy(float)
                else:
                    vals = mev_series(m).reindex(dates).to_numpy(float)
                return np.nan_to_num(vals, nan=float(np.nanmedian(vals)))[:, None]
            # never cache an overridden column — the scenario changes under it
            blocks.append(_mk() if mev_override is not None else _cache_col(mk, _mk))
            names.append(f"mev:{m.label()}")

    if spec.vintage_effect and "vintage" in df.columns:
        d = pd.get_dummies(df["vintage"].astype(int), prefix="vintage",
                           drop_first=True, dtype=float)
        blocks.append(d.to_numpy()); names += list(d.columns)

    X = np.column_stack(blocks) if blocks else np.zeros((len(df), 0))
    # Drop any column with no variation. A dead column contributes nothing, and
    # its standard error comes back as the reciprocal of the ridge — 31,622 —
    # which looks like a numerical failure on the specification card.
    if means is None:
        alive = X.std(axis=0) > 1e-12
        if not alive.all():
            X = X[:, alive]
            names = [n for n, a in zip(names, alive) if a]
    if means is None:
        means = X.mean(axis=0)
        stds = X.std(axis=0)
        stds[stds < 1e-12] = 1.0
    X = (X - means) / stds
    X = np.column_stack([np.ones(len(df)), X]).astype(np.float32, copy=False)
    return Design(X=X, columns=["intercept", *names], y=y,
                  dates=df["performance_date"].to_numpy(),
                  accounts=df["account_id"].to_numpy(),
                  woe_maps=maps, means=means, stds=stds, basis_maps=bases)
