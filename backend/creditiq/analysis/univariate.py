"""One variable on its own, before any target.

The binning and shape panels answer "how does this column relate to default".
They cannot answer "what does this column look like", and that question comes
first: a column with 78% of its mass at zero produces two quantile buckets no
matter how good the target relationship is, and the shape panel reports the
two buckets without ever saying why there are only two.

Everything here is descriptive. Nothing is fixed, imputed or transformed — a
finding is reported with the number behind it and, where there is one, the
treatment that answers it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Conventional readings of the third and fourth moments. They are rules of
# thumb, stated as such, not tests.
SKEW_MODERATE = 0.5
SKEW_STRONG = 1.0
HEAVY_TAIL_EXCESS_KURTOSIS = 3.0


def _skew_note(g1: float) -> str:
    a = abs(g1)
    side = "right" if g1 > 0 else "left"
    if a < SKEW_MODERATE:
        return "Near symmetric."
    if a < SKEW_STRONG:
        return (f"Moderately {side}-skewed. A linear term is usually still "
                f"reasonable; binning or a spline will fit the tail better.")
    return (f"Strongly {side}-skewed. A linear term is driven by the {side} "
            f"tail. Bin it, spline it, or model a transform of it.")


def describe_numeric(x: pd.Series, name: str = "",
                     y: pd.Series | None = None) -> dict:
    """Shape, spread, concentration and the findings that follow from them.

    `y` is the target, and is used only to put an event RATE on each
    histogram bar. The bars are equal-width, so the rate beneath them is the
    relationship read on the same axis as the shape — which is the pairing
    quantile bins cannot show, because their volume is flat by construction.
    """
    raw_n = int(len(x))
    xs = pd.to_numeric(x, errors="coerce")
    keep = xs.notna()
    v = xs[keep].to_numpy(dtype=float)
    yv = (pd.to_numeric(y, errors="coerce")[keep].fillna(0).to_numpy(dtype=float)
          if y is not None else None)
    n = int(v.size)
    out: dict = {
        "column": name or str(x.name), "kind": "numeric",
        "n": n, "n_missing": raw_n - n,
        "missing_pct": float((raw_n - n) / raw_n * 100) if raw_n else 0.0,
        "n_unique": int(pd.unique(v).size) if n else 0,
        "findings": [],
    }
    if not n:
        out["findings"].append(
            {"severity": "critical", "label": "Entirely missing",
             "detail": "No values to describe."})
        return out

    qs = [1, 5, 10, 25, 50, 75, 90, 95, 99]
    q = np.percentile(v, qs)
    mean, std = float(v.mean()), float(v.std(ddof=1)) if n > 1 else 0.0
    median = float(q[4])
    iqr = float(q[5] - q[3])
    # Third and fourth standardised moments, excess kurtosis (normal = 0).
    if std > 0 and n > 2:
        z = (v - mean) / std
        skew = float((z ** 3).mean())
        kurt = float((z ** 4).mean() - 3.0)
    else:
        skew = kurt = 0.0

    # The single most common value and its share: the statistic that explains
    # a collapsed binning, and the one a histogram hides by spreading mass
    # across a bar.
    vals, counts = np.unique(v, return_counts=True)
    top_i = int(np.argmax(counts))
    mode_share = float(counts[top_i] / n * 100)

    fence_lo, fence_hi = q[3] - 3 * iqr, q[5] + 3 * iqr
    out |= {
        "mean": mean, "std": std, "median": median,
        "min": float(v.min()), "max": float(v.max()),
        "percentiles": {f"p{p:02d}": float(val) for p, val in zip(qs, q)},
        "iqr": iqr,
        # Dispersion relative to level, undefined through a mean of zero.
        "cv": float(std / abs(mean)) if abs(mean) > 1e-12 else None,
        "skew": skew, "kurtosis_excess": kurt,
        "skew_note": _skew_note(skew),
        "mode": float(vals[top_i]), "mode_share_pct": mode_share,
        "zero_pct": float((v == 0).mean() * 100),
        "negative_pct": float((v < 0).mean() * 100),
        "n_outliers": int(((v < fence_lo) | (v > fence_hi)).sum()),
        "outlier_fence": [float(fence_lo), float(fence_hi)],
    }

    # Histograms on EQUAL-WIDTH bins. The binning panels below use quantile
    # bins, which carry equal counts by construction and draw a flat
    # rectangle — informative about risk, useless about shape.
    #
    # BOTH ranges are returned, and the full one is what the interface shows
    # first. Trimming to p01-p99 by default would hide the long tail, which
    # is the single thing a reader opens a histogram to see; the trimmed view
    # is the follow-up question ("what does the body look like"), not the
    # opening one.
    def _hist(lo: float, hi: float, nbins: int = 48) -> dict | None:
        if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
            return None
        clipped = np.clip(v, lo, hi)
        counts, edges = np.histogram(clipped, bins=nbins, range=(lo, hi))
        h = {"edges": [float(e) for e in edges],
             "counts": [int(c) for c in counts],
             "below": int((v < lo).sum()), "above": int((v > hi).sum()),
             "window": [float(lo), float(hi)]}
        if yv is not None:
            # Events per bar, so the rate underneath reads on the same axis.
            idx = np.clip(np.digitize(clipped, edges[1:-1]), 0, nbins - 1)
            ev = np.bincount(idx, weights=yv, minlength=nbins)
            h["events"] = [int(e) for e in ev]
            # A rate on a near-empty bar is noise; report it as unavailable
            # rather than drawing a spike the reader has to learn to ignore.
            h["rates"] = [float(e / c) if c >= 50 else None
                          for e, c in zip(ev, counts)]
        return h

    full = _hist(float(v.min()), float(v.max()))
    if full:
        out["histogram"] = full
    trimmed = _hist(float(q[0]), float(q[8]))
    # Only worth offering when it actually differs from the full range.
    if trimmed and (trimmed["below"] or trimmed["above"]):
        out["histogram_trimmed"] = trimmed

    # A log transform is only defined on non-negative data, and is only worth
    # offering when it actually helps. Both are checked rather than assumed.
    if v.min() >= 0 and abs(skew) >= SKEW_MODERATE:
        lv = np.log1p(v)
        ls, lstd = float(lv.mean()), float(lv.std(ddof=1)) if n > 1 else 0.0
        if lstd > 0:
            lskew = float((((lv - ls) / lstd) ** 3).mean())
            out["log1p_skew"] = lskew
            if abs(lskew) < abs(skew) * 0.6:
                out["findings"].append({
                    "severity": "good", "label": "A log transform would help",
                    "detail": (f"Skew falls from {skew:.2f} to {lskew:.2f} under "
                               f"log(1+x). The same shape is available without "
                               f"transforming the column, by binning or splining "
                               f"it.")})

    if mode_share >= 25:
        out["findings"].append({
            "severity": "serious", "label": "Concentrated at one value",
            "detail": (f"{mode_share:.0f}% of rows hold {vals[top_i]:,.4g}. "
                       f"Quantile bins cannot split a point mass, so the binning "
                       f"collapses to few buckets however many are requested. "
                       f"Treat that value as its own bin, or model the column as "
                       f"an indicator plus a continuous part.")})
    if out["zero_pct"] >= 10 and vals[top_i] == 0:
        out["findings"].append({
            "severity": "warning", "label": "Zero-inflated",
            "detail": (f"{out['zero_pct']:.0f}% of rows are exactly zero. On an "
                       f"amount column that is usually a different state rather "
                       f"than a small amount — nothing paid, nothing drawn — and "
                       f"it belongs in its own bin so the continuous part "
                       f"describes the rows where something happened.")})
    if abs(skew) >= SKEW_STRONG:
        out["findings"].append({
            "severity": "warning", "label": "Strongly skewed",
            "detail": _skew_note(skew)})
    if kurt >= HEAVY_TAIL_EXCESS_KURTOSIS:
        out["findings"].append({
            "severity": "warning", "label": "Heavy tails",
            "detail": (f"Excess kurtosis {kurt:.1f}: extreme values are far more "
                       f"common than a normal distribution implies. A mean and a "
                       f"standard deviation describe this column poorly; the "
                       f"percentiles below describe it well.")})
    if out["missing_pct"] >= 20:
        out["findings"].append({
            "severity": "warning", "label": "Substantially missing",
            "detail": (f"{out['missing_pct']:.1f}% of rows have no value. "
                       f"Missing takes its own bin and its own weight, so the "
                       f"column is usable — but that bin is carrying a fifth of "
                       f"the book.")})
    if out["n_unique"] <= 2:
        out["findings"].append({
            "severity": "warning", "label": "Effectively binary",
            "detail": f"Only {out['n_unique']} distinct values."})
    return out


def describe_categorical(x: pd.Series, name: str = "", top: int = 15) -> dict:
    """Levels, concentration, and the long thin tail that binning must handle."""
    raw_n = int(len(x))
    s = x.dropna().astype(str)
    n = int(len(s))
    out: dict = {
        "column": name or str(x.name), "kind": "categorical",
        "n": n, "n_missing": raw_n - n,
        "missing_pct": float((raw_n - n) / raw_n * 100) if raw_n else 0.0,
        "findings": [],
    }
    if not n:
        out["findings"].append(
            {"severity": "critical", "label": "Entirely missing",
             "detail": "No values to describe."})
        return out

    vc = s.value_counts()
    share = vc / n
    out |= {
        "n_unique": int(vc.size),
        "levels": [{"level": str(k), "count": int(c), "pct": float(c / n * 100)}
                   for k, c in vc.head(top).items()],
        # Herfindahl: 1 means one level holds everything, 1/k means even.
        "concentration_hhi": float((share ** 2).sum()),
        "top_level_pct": float(share.iloc[0] * 100),
        "n_levels_under_1pct": int((share < 0.01).sum()),
        "pct_in_thin_levels": float(share[share < 0.01].sum() * 100),
    }
    if out["n_unique"] > 20:
        out["findings"].append({
            "severity": "warning", "label": "Wide categorical",
            "detail": (f"{out['n_unique']} levels, {out['n_levels_under_1pct']} of "
                       f"them under 1% of the book. Weight of evidence on a thin "
                       f"level fits noise; the binning collapses the tail into an "
                       f"Other bin and shrinks the rest toward the book average.")})
    if out["top_level_pct"] >= 90:
        out["findings"].append({
            "severity": "serious", "label": "One level dominates",
            "detail": (f"{out['top_level_pct']:.0f}% of rows are "
                       f"{out['levels'][0]['level']!r}. There is little to "
                       f"separate: the column is close to constant.")})
    if out["missing_pct"] >= 20:
        out["findings"].append({
            "severity": "warning", "label": "Substantially missing",
            "detail": f"{out['missing_pct']:.1f}% of rows have no value."})
    return out


def describe(x: pd.Series, name: str = "", y: pd.Series | None = None) -> dict:
    numeric = (pd.api.types.is_numeric_dtype(x)
               and not pd.api.types.is_bool_dtype(x)
               and x.nunique(dropna=True) > 12)
    return (describe_numeric(x, name, y) if numeric
            else describe_categorical(x, name))
