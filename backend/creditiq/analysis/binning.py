"""Binning, weight of evidence and information value.

This is the scorecard convention and it is the heart of the Explore surface. The
maths is simple; what matters is that every edge case is handled explicitly,
because those are what a validator asks about.

  * MISSING gets its OWN bin, never an imputed value silently folded into a
    numeric bin. Missingness is often predictive in credit, and hiding it inside
    the median bin both loses that signal and misstates the bin's bad rate.

  * ZERO CELLS are handled by a Haldane-Anscombe style correction rather than by
    dropping the bin. A bin with no bads gives an infinite WoE; dropping it makes
    the information value depend on the sample size in a way that is difficult
    to interpret.

  * IV IS BIASED UPWARD IN SMALL SAMPLES. The classic interpretation bands
    (<0.02 not predictive, and so on) are quoted as though they were sample-size
    free, and they are not. `iv_null_floor` estimates the IV a column with NO
    signal at all would score on this sample, by permutation. On the CRE book
    (356 defaults) that floor is around 0.03, which is above the textbook "not
    predictive" threshold.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd

MISSING_LABEL = "Missing"
BinKind = Literal["numeric", "categorical"]


@dataclass
class Bin:
    index: int
    label: str
    lo: float | None
    hi: float | None
    levels: list[str] | None
    count: int
    events: int
    non_events: int
    event_rate: float
    woe: float
    iv_contribution: float
    pct_of_total: float
    is_special: bool = False


@dataclass
class Binning:
    column: str
    kind: BinKind
    bins: list[Bin]
    iv: float
    edges: list[float] | None
    groups: list[list[str]] | None
    monotone: bool
    monotone_direction: str
    n_total: int
    n_events: int
    warnings: list[str] = field(default_factory=list)
    n_levels_raw: int = 0
    shrinkage: float = 0.0

    def to_dict(self) -> dict:
        return {
            "column": self.column, "kind": self.kind, "iv": self.iv,
            "edges": self.edges, "groups": self.groups,
            "monotone": self.monotone, "monotone_direction": self.monotone_direction,
            "n_total": self.n_total, "n_events": self.n_events,
            "warnings": self.warnings, "n_levels_raw": self.n_levels_raw,
            "shrinkage": self.shrinkage,
            "bins": [b.__dict__ for b in self.bins],
        }


def auto_shrinkage(n_levels: int, n_events: int) -> float:
    """How hard to pull a thin level's weight toward the book average.

    Returns a pseudo-count `k`. A level with `k` events gets half its own weight
    and half the average; a level with many more keeps essentially all of its
    own. Zero means no shrinkage.

    The rule scales with how thinly the events are spread. A mortgage book with
    144 metros and 1,800 defaults averages twelve events per metro, and a metro
    with three of them should not get a weight of its own — that number is noise,
    and an unshrunk weight of evidence will happily hand it one.

    Low-cardinality variables are left alone, because shrinking a five-level
    categorical biases it for no stability gain.
    """
    if n_levels < 15 or n_events <= 0:
        return 0.0
    per_level = n_events / n_levels
    # target: a level needs roughly the average event count to earn half its own
    # weight, floored so the correction stays meaningful on very wide variables
    return float(max(per_level, 5.0))


def _woe_table(counts: pd.DataFrame, total_e: int, total_ne: int,
               shrinkage: float = 0.0) -> pd.DataFrame:
    """WoE and IV per bin, with a zero-cell correction.

    WoE = ln( (events in bin / all events) / (non-events in bin / all non-events) )

    A bin with zero events or zero non-events would give an infinite WoE. Rather
    than drop it — which silently changes the IV and the bin count — add 0.5 to
    both cells of any bin that has an empty one. This is the Haldane-Anscombe
    correction, it is standard, and it keeps the bin visible in the UI where an
    analyst can decide to merge it.
    """
    e = counts["events"].astype(float).copy()
    ne = counts["non_events"].astype(float).copy()
    empty = (e == 0) | (ne == 0)
    e[empty] += 0.5
    ne[empty] += 0.5
    pe = e / max(total_e, 1)
    pne = ne / max(total_ne, 1)
    woe = np.log(np.where(pe > 0, pe, 1e-12) / np.where(pne > 0, pne, 1e-12))
    counts = counts.copy()
    counts["woe_raw"] = woe
    if shrinkage > 0:
        # Empirical-Bayes shrinkage toward the book average. The global weight of
        # evidence is exactly zero by construction — it is a log ratio of shares
        # that each sum to one — so shrinking toward the average is shrinking
        # toward zero.
        #
        #     WoE_shrunk(b) = n_b / (n_b + k) x WoE(b)
        #
        # A level with many events keeps its weight; a level with a handful gets
        # most of it taken away.
        ev = counts["events"].astype(float).to_numpy()
        woe = woe * (ev / (ev + shrinkage))
    counts["woe"] = woe
    counts["iv_contribution"] = (pe - pne) * woe
    counts["_corrected"] = empty
    counts["_shrunk"] = shrinkage > 0
    return counts


def _monotonicity(rates: list[float]) -> tuple[bool, str]:
    r = [x for x in rates if not np.isnan(x)]
    if len(r) < 3:
        return True, "flat"
    d = np.diff(r)
    if np.all(d <= 1e-12):
        return True, "decreasing"
    if np.all(d >= -1e-12):
        return True, "increasing"
    return False, "non-monotone"


def optimal_edges(x: pd.Series, y: pd.Series, max_bins: int = 8,
                  monotone: bool = True) -> list[float]:
    """Optimal binning edges.

    Uses `optbinning` where available — it solves the binning as a constrained
    optimisation and can enforce monotonicity directly. The fallback is a
    monotone-merge routine over quantile seeds, NOT equal-width bins: equal width
    on a skewed credit variable puts 90% of the book in one bin and tells you
    nothing.
    """
    v = pd.to_numeric(x, errors="coerce")
    ok = v.notna()
    if ok.sum() < 50 or y[ok].nunique() < 2:
        return []
    try:
        from optbinning import OptimalBinning
        ob = OptimalBinning(name=str(x.name), dtype="numerical", max_n_bins=max_bins,
                            min_prebin_size=0.02,
                            monotonic_trend="auto" if monotone else None)
        ob.fit(v[ok].to_numpy(float), y[ok].to_numpy(int))
        return [float(s) for s in ob.splits]
    except Exception:
        return _monotone_merge_edges(v[ok], y[ok], max_bins, monotone)


def _monotone_merge_edges(v: pd.Series, y: pd.Series, max_bins: int,
                          monotone: bool) -> list[float]:
    """Quantile seeds, then merge adjacent bins that break monotonicity.

    A ChiMerge-flavoured fallback. It is deliberately NOT equal-width binning:
    the brief rules that out and it is the wrong answer on skewed credit data.
    """
    q = np.unique(np.nanquantile(v, np.linspace(0, 1, min(21, max(4, max_bins * 3)))))
    edges = list(q[1:-1])
    if not edges:
        return []
    for _ in range(40):
        idx = np.digitize(v, edges)
        tab = pd.DataFrame({"b": idx, "y": y}).groupby("b")["y"].agg(["sum", "count"])
        tab = tab.reindex(range(len(edges) + 1), fill_value=0)
        rate = (tab["sum"] / tab["count"].replace(0, np.nan)).to_numpy()
        small = tab["count"].to_numpy() < max(30, 0.02 * len(v))
        ok_mono, _ = _monotonicity(list(rate))
        if len(edges) <= max_bins - 1 and (not monotone or ok_mono) and not small.any():
            break
        if small.any():
            j = int(np.argmax(small))
            drop = min(max(j - 1, 0), len(edges) - 1)
        else:
            d = np.diff(np.nan_to_num(rate, nan=0.0))
            # merge across the smallest violation of the dominant direction
            sign = 1 if np.nansum(d) >= 0 else -1
            viol = np.where(np.sign(d) != sign, np.abs(d), np.inf)
            drop = int(np.argmin(viol)) if np.isfinite(viol).any() else int(np.argmin(np.abs(d)))
            drop = min(drop, len(edges) - 1)
        edges.pop(drop)
        if not edges:
            break
    return [float(e) for e in edges]


def bin_numeric(x: pd.Series, y: pd.Series, edges: list[float] | None = None,
                max_bins: int = 8, monotone: bool = True) -> Binning:
    v = pd.to_numeric(x, errors="coerce")
    yy = y.astype(int)
    if edges is None:
        edges = optimal_edges(v, yy, max_bins, monotone)
    edges = sorted(float(e) for e in (edges or []))

    miss = v.isna()
    idx = pd.Series(np.digitize(v.fillna(-np.inf), edges), index=v.index)
    idx[miss] = -1                                   # missing gets its OWN bin

    rows = []
    total_e = int(yy.sum())
    total_ne = int(len(yy) - total_e)
    labels: list[tuple[int, str, float | None, float | None, bool]] = []
    if miss.any():
        labels.append((-1, MISSING_LABEL, None, None, True))
    bounds = [-np.inf, *edges, np.inf]
    for i in range(len(bounds) - 1):
        lo, hi = bounds[i], bounds[i + 1]
        lab = (f"< {_fmt(hi)}" if np.isneginf(lo)
               else f">= {_fmt(lo)}" if np.isposinf(hi)
               else f"[{_fmt(lo)}, {_fmt(hi)})")
        labels.append((i, lab, None if np.isneginf(lo) else lo,
                       None if np.isposinf(hi) else hi, False))

    for key, lab, lo, hi, special in labels:
        m = idx == key
        n = int(m.sum())
        ev = int(yy[m].sum())
        rows.append({"key": key, "label": lab, "lo": lo, "hi": hi, "special": special,
                     "count": n, "events": ev, "non_events": n - ev})
    tab = _woe_table(pd.DataFrame(rows), total_e, total_ne)

    def _edge(v):
        """A DataFrame round trip turns None into NaN in a float column, so an
        unbounded edge comes back as nan and `is not None` becomes True. The
        dataclass declares `float | None`; honour it."""
        return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else float(v)

    bins = [
        Bin(index=i, label=r["label"], lo=_edge(r["lo"]), hi=_edge(r["hi"]), levels=None,
            count=int(r["count"]), events=int(r["events"]),
            non_events=int(r["non_events"]),
            event_rate=float(r["events"] / r["count"]) if r["count"] else float("nan"),
            woe=float(r["woe"]), iv_contribution=float(r["iv_contribution"]),
            pct_of_total=float(r["count"] / max(len(v), 1)),
            is_special=bool(r["special"]))
        for i, r in tab.iterrows()
    ]
    real = [b for b in bins if not b.is_special and b.count > 0]
    mono, direction = _monotonicity([b.event_rate for b in real])
    warnings: list[str] = []
    if tab["_corrected"].any():
        warnings.append(
            "One or more bins had no events or no non-events. A zero-cell "
            "correction was applied so the bin stays visible; consider merging it.")
    if any(b.pct_of_total < 0.02 and not b.is_special for b in bins):
        warnings.append("A bin holds under 2% of the population. Small bins give "
                        "unstable weights of evidence — merge it into a neighbour.")
    return Binning(column=str(x.name), kind="numeric", bins=bins,
                   iv=float(tab["iv_contribution"].sum()), edges=edges, groups=None,
                   monotone=mono, monotone_direction=direction,
                   n_total=int(len(v)), n_events=total_e, warnings=warnings)


def bin_categorical(x: pd.Series, y: pd.Series,
                    groups: list[list[str]] | None = None,
                    max_levels: int = 12, min_share: float = 0.01,
                    shrinkage: float | None = None) -> Binning:
    """Group a categorical, with a POPULATION FLOOR rather than a fixed top-k.

    A fixed "keep the top twelve" is arbitrary and behaves badly at both ends: it
    discards a meaningful thirteenth level on a narrow variable, and it keeps a
    twelfth level holding 0.2% of the book on a wide one. The floor keeps any
    level holding at least `min_share` of the population and folds the rest into
    a single Other, capped so the design never explodes.
    """
    s = x.astype("string")
    yy = y.astype(int)
    total_e = int(yy.sum())
    total_ne = int(len(yy) - total_e)
    n_levels_raw = int(s.nunique(dropna=True))
    if shrinkage is None:
        shrinkage = auto_shrinkage(n_levels_raw, total_e)

    if groups is None:
        vc = s.value_counts(dropna=True)
        share = vc / max(len(s), 1)
        keep = list(share.index[(share >= min_share)][:max_levels])
        if not keep:                                  # everything is tiny
            keep = list(vc.index[:max_levels])
        groups = [[str(k)] for k in keep]
        rare = [str(k) for k in vc.index if str(k) not in {str(z) for z in keep}]
        if rare:
            groups.append(rare)

    lookup: dict[str, int] = {}
    for gi, g in enumerate(groups):
        for lvl in g:
            lookup[str(lvl)] = gi

    # Categorical codes rather than a per-row lambda. On a million-row column the
    # lambda dominated the whole design-matrix build.
    cat = s.astype("category")
    lut = np.array([lookup.get(str(c), -2) for c in cat.cat.categories], dtype=np.int64)
    codes = cat.cat.codes.to_numpy()
    key = pd.Series(np.where(codes >= 0, lut[np.clip(codes, 0, max(len(lut) - 1, 0))], -1),
                    index=s.index)
    rows = []
    labels: list[tuple[int, str, list[str] | None, bool]] = []
    if key.eq(-1).any():
        labels.append((-1, MISSING_LABEL, None, True))
    for gi, g in enumerate(groups):
        lab = g[0] if len(g) == 1 else f"{g[0]} +{len(g) - 1} more"
        labels.append((gi, lab, [str(v) for v in g], False))
    if key.eq(-2).any():
        labels.append((-2, "Other (unseen)", None, True))

    for k, lab, lvls, special in labels:
        m = key == k
        n = int(m.sum())
        ev = int(yy[m].sum())
        rows.append({"key": k, "label": lab, "levels": lvls, "special": special,
                     "count": n, "events": ev, "non_events": n - ev})
    tab = _woe_table(pd.DataFrame(rows), total_e, total_ne, shrinkage=shrinkage)

    bins = [
        Bin(index=i, label=r["label"], lo=None, hi=None, levels=r["levels"],
            count=int(r["count"]), events=int(r["events"]),
            non_events=int(r["non_events"]),
            event_rate=float(r["events"] / r["count"]) if r["count"] else float("nan"),
            woe=float(r["woe"]), iv_contribution=float(r["iv_contribution"]),
            pct_of_total=float(r["count"] / max(len(s), 1)),
            is_special=bool(r["special"]))
        for i, r in tab.iterrows()
    ]
    warnings: list[str] = []
    if tab["_corrected"].any():
        warnings.append("A level had no events or no non-events; a zero-cell "
                        "correction was applied. Consider grouping it.")
    n_folded = n_levels_raw - len([g for g in groups if len(g) == 1])
    if n_folded > 0:
        warnings.append(
            f"{n_levels_raw} levels, of which {n_folded} hold under "
            f"{min_share:.0%} of the book each and were folded into a single "
            f"Other. Keeping them would spend a parameter per level on a "
            f"handful of accounts.")
    if shrinkage > 0:
        warnings.append(
            f"Weights of evidence are shrunk toward the book average with a "
            f"pseudo-count of {shrinkage:.0f} events, because {n_levels_raw} "
            f"levels share {total_e:,} events. A level with a few events would "
            f"otherwise be handed a weight it has not earned.")
    return Binning(column=str(x.name), kind="categorical", bins=bins,
                   iv=float(tab["iv_contribution"].sum()), edges=None, groups=groups,
                   # A nominal category has no natural order, so monotonicity is
                   # not a meaningful question for it.
                   monotone=True, monotone_direction="n/a",
                   n_total=int(len(s)), n_events=total_e, warnings=warnings,
                   n_levels_raw=n_levels_raw, shrinkage=float(shrinkage))


def information_value(x: pd.Series, y: pd.Series, max_bins: int = 10) -> float:
    if pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > max_bins:
        return bin_numeric(x, y, max_bins=max_bins, monotone=False).iv
    return bin_categorical(x, y).iv


def iv_null_floor(x: pd.Series, y: pd.Series, draws: int = 8,
                  seed: int = 11) -> float:
    """The IV a column with NO signal would score on THIS sample.

    Information value is biased upward in small samples, so the textbook bands
    are not sample-size free. Ten bins against a few hundred events produce a
    null IV around 0.03 for a column with no relationship whatsoever — above the
    "not predictive" threshold of 0.02. Quoting this floor beside the ranking
    stops an analyst reading noise as weak predictive power.

    Note WHY the floor is as high as it is: the procedure being tested is
    "optimally bin, then measure IV", and the binning step itself fits the
    permuted target. The floor therefore prices in the optimiser's own
    overfitting, which is exactly the thing an analyst needs warning about.
    """
    rng = np.random.default_rng(seed)
    yv = y.to_numpy()
    vals = [information_value(x, pd.Series(rng.permutation(yv), index=y.index))
            for _ in range(draws)]
    a = np.asarray(vals)
    return float(a.mean() + 2 * a.std())


def null_floor_for_shape(y: pd.Series, kind: str, n_levels: int = 10,
                         draws: int = 6, seed: int = 11) -> float:
    """The null floor for a SHAPE of variable rather than a specific column.

    The permutation null depends on the sample size, the event count and how many
    bins the procedure will cut — not on the particular values in the column. So
    it is estimated once per shape against a synthetic random variable and shared
    across every real column of that shape.

    Doing it per column is the textbook-pure version and it costs a permutation
    binning run per variable: about 48 seconds to screen a book, which is not a
    thing anyone will wait for in a meeting. This is an approximation, it is
    stated in the UI beside the number, and it moves the screen to a few seconds.
    """
    rng = np.random.default_rng(seed)
    n = len(y)
    if kind == "numeric":
        probe = pd.Series(rng.normal(size=n), index=y.index, name="_null_probe")
    else:
        # Levels are drawn with a ZIPF-LIKE concentration, not uniformly.
        #
        # A uniform 120-level probe puts 0.83% in every level, so the population
        # floor folds all of them into Other and the probe collapses to a single
        # bin — reporting a LOWER null for a wide categorical than a narrow one,
        # which is backwards. A real wide categorical has a few large levels and
        # a long thin tail, and it is the surviving large levels that carry the
        # chance signal. The probe has to have the same shape to measure it.
        k = max(2, n_levels)
        lv = np.array([f"L{i}" for i in range(k)])
        w = 1.0 / np.power(np.arange(1, k + 1), 0.75)
        probe = pd.Series(rng.choice(lv, size=n, p=w / w.sum()),
                          index=y.index, name="_null_probe")
    return iv_null_floor(probe, y, draws=draws, seed=seed)


def _fmt(v: float) -> str:
    if np.isinf(v):
        return "inf"
    a = abs(v)
    if a >= 1e6:
        return f"{v / 1e6:.1f}M"
    if a >= 1e4:
        return f"{v / 1e3:.0f}K"
    if a >= 100:
        return f"{v:.0f}"
    if a >= 1:
        return f"{v:.1f}"
    return f"{v:.3f}"


# ── which treatment does this variable actually want? ────────────────────────
def shape_diagnostic(b: Binning) -> dict:
    """Recommend how a variable should enter the model, from its own bin shape.

    "Spline or continuous?" is a real question and taste is a poor way to settle
    it. The bins already contain the answer, because the shape of the bin
    log-odds is exactly what each treatment assumes:

      continuous  assumes the log-odds are LINEAR in the variable
      spline      assumes they bend, but smoothly and without reversing
      bins        assumes nothing — the right choice when the relationship
                  genuinely reverses, or has a cliff
      woe         same fit as bins for one parameter, when the shape is
                  monotone enough for a single coefficient to carry it

    So: fit a straight line through the bin log-odds, weighted by bin size, and
    look at what is left over. A high R-squared means continuous is enough and
    cheapest. Real curvature with no reversal means a spline. A reversal means
    neither — use bins and let each level go where it wants.

    This is a recommendation, shown with its reason. It is never applied for you.
    """
    real = [x for x in b.bins if not x.is_special and x.count > 0]
    if len(real) < 4:
        return {"recommendation": "woe", "confidence": "low",
                "reason": "Too few bins to judge the shape.",
                "linear_r2": None, "monotone": b.monotone, "curvature": None}

    # bin position: the midpoint for a numeric binning, the rank otherwise
    def _mid(x) -> float | None:
        lo_ok = x.lo is not None and np.isfinite(x.lo)
        hi_ok = x.hi is not None and np.isfinite(x.hi)
        if lo_ok and hi_ok:
            return (x.lo + x.hi) / 2.0
        if lo_ok:
            return float(x.lo)          # open-ended top bin
        if hi_ok:
            return float(x.hi)          # open-ended bottom bin
        return None

    mids = [_mid(x) for x in real] if b.kind == "numeric" else [None] * len(real)
    pos = (np.array(mids, dtype=float) if all(m is not None for m in mids)
           else np.arange(len(real), dtype=float))

    w = np.array([x.count for x in real], dtype=float)
    lo = np.array([x.woe for x in real], dtype=float)     # WoE is the bin log-odds
    if np.allclose(lo, lo[0]):
        return {"recommendation": "continuous", "confidence": "low",
                "reason": "The bins barely separate — the variable carries little.",
                "linear_r2": 0.0, "monotone": b.monotone, "curvature": 0.0}

    z = (pos - pos.mean()) / (pos.std() or 1.0)
    w = w / w.sum()                     # normalised; raw bin counts overflow polyfit

    def _wls_r2(degree: int) -> float:
        """Weighted least squares through the bin log-odds, via normal equations.

        numpy.polyfit was tried and fails here: it scales the design by the raw
        weights, and bin counts in the hundreds of thousands drive LAPACK's
        scaling routine out of range — it reports an illegal parameter and the
        SVD does not converge.
        """
        V = np.vander(z, degree + 1)
        sw = np.sqrt(w)[:, None]
        coef, *_ = np.linalg.lstsq(V * sw, lo * sw.ravel(), rcond=None)
        resid = lo - V @ coef
        ss_tot = float(np.sum(w * (lo - np.average(lo, weights=w)) ** 2)) or 1.0
        return float(1.0 - np.sum(w * resid ** 2) / ss_tot)

    r2_lin = _wls_r2(1)
    r2_quad = _wls_r2(2)
    r2_cubic = _wls_r2(3) if len(real) >= 5 else r2_quad
    r2_smooth = max(r2_quad, r2_cubic)
    curvature = float(max(r2_quad - r2_lin, 0.0))

    if not b.monotone:
        # Non-monotone is not automatically a case for dummies. A seasoning hump
        # reverses direction and is still perfectly smooth — a spline fits it in
        # a few columns, where dummies spend one per bin to describe a curve.
        # What distinguishes them is whether a low-order polynomial can follow
        # the shape.
        if r2_smooth >= 0.75:
            rec, conf = "spline", "high"
            reason = (f"The event rate reverses direction, but smoothly — a curve "
                      f"follows {r2_smooth:.0%} of the shape. A spline fits that "
                      f"bend in a few columns; dummies would spend one per bin to "
                      f"describe the same curve.")
        else:
            rec, conf = "bins", "high"
            reason = (f"The event rate reverses direction and does not follow a "
                      f"smooth curve — a cubic still leaves {1 - r2_smooth:.0%} "
                      f"unexplained. Let each bin go where it wants and pay the "
                      f"parameters.")
    elif r2_lin >= 0.95:
        rec, conf = "continuous", "high"
        reason = (f"The bin log-odds are almost exactly linear (R-squared "
                  f"{r2_lin:.2f}), so one continuous column captures the shape "
                  f"and keeps the within-bin detail that binning discards.")
    elif curvature >= 0.03:
        rec, conf = "spline", "high"
        reason = (f"The relationship bends without reversing — a straight line "
                  f"leaves {1 - r2_lin:.0%} of the shape unexplained and a curve "
                  f"recovers most of it. A spline fits the bend smoothly.")
    else:
        rec, conf = "woe", "medium"
        reason = (f"Monotone but not straight (R-squared {r2_lin:.2f}). Weight of "
                  f"evidence carries a monotone shape in one parameter, which is "
                  f"the cheapest thing that fits it.")
    return {"recommendation": rec, "confidence": conf, "reason": reason,
            "linear_r2": r2_lin, "smooth_r2": r2_smooth, "monotone": b.monotone,
            "curvature": curvature}
