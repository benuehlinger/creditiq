"""Binning a driver against a FRACTIONAL target.

The PD binning machinery bins against a binary outcome: it counts events and
non-events, and the weight of evidence is the log ratio of their shares. None of
that transfers to realised severity, which is a proportion observed once per
default. There are no events to count.

The analogues that do transfer:

  bin statistic     mean severity in the bin, not an event rate
  bin weight        logit(mean_b) - logit(mean_overall)
  strength          deviance R-squared of the binned model against an
                    intercept-only model, on the same quasi-likelihood the LGD
                    model is fitted with

The weight is exactly the coefficient a saturated fractional logit would give
bin b relative to the book mean, so encoding a bin by its weight and fitting one
coefficient reproduces the binned fit — which is what weight of evidence does on
the PD side. Calling it "weight of evidence" would be borrowing a name for a
different quantity, so it is called the severity weight.

Information value is NOT computed. It is a divergence between two conditional
distributions, of events and non-events, and a fractional target has neither.
Reporting an information value here would be a number with no referent.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

# Below this many defaults a bin mean is an average of a handful of severities.
MIN_BIN = 25


def _logit(p: np.ndarray | float) -> np.ndarray | float:
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def _quasi_ll(mu: np.ndarray, y: np.ndarray) -> float:
    """Bernoulli quasi-likelihood on a continuous target in [0, 1]."""
    m = np.clip(mu, 1e-9, 1 - 1e-9)
    return float(np.sum(y * np.log(m) + (1 - y) * np.log(1 - m)))


@dataclass
class SeverityBin:
    index: int
    label: str
    lo: float | None
    hi: float | None
    levels: list[str] | None
    n: int
    mean: float
    se: float
    weight: float
    share: float
    is_special: bool = False


@dataclass
class SeverityBinning:
    column: str
    kind: str                       # numeric | categorical
    bins: list[SeverityBin]
    edges: list[float] | None
    n_total: int
    book_mean: float
    # Deviance R-squared of the binned model against intercept-only, on the
    # quasi-likelihood. The fractional analogue of "how much does this binning
    # explain", and directly comparable across drivers.
    deviance_r2: float
    monotone: bool
    direction: str
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "column": self.column, "kind": self.kind, "edges": self.edges,
            "n_total": self.n_total, "book_mean": self.book_mean,
            "deviance_r2": self.deviance_r2, "monotone": self.monotone,
            "direction": self.direction, "warnings": self.warnings,
            "bins": [b.__dict__ for b in self.bins],
        }


def _merge_to_min(idx: np.ndarray, n_bins: int, y: np.ndarray) -> np.ndarray:
    """Absorb bins left to right until each carries MIN_BIN observations."""
    out = idx.copy()
    target = 0
    carried = 0
    for b in range(n_bins):
        m = out == b
        carried += int(m.sum())
        out[m] = target
        if carried >= MIN_BIN:
            target += 1
            carried = 0
    # a thin final bin folds back into its neighbour
    last = out.max()
    if last > 0 and (out == last).sum() < MIN_BIN:
        out[out == last] = last - 1
    return out


def bin_severity(x: pd.Series, y: pd.Series, max_bins: int = 5,
                 edges: list[float] | None = None,
                 monotone: bool = True) -> SeverityBinning:
    """Bin a driver against realised severity."""
    yy = np.clip(pd.to_numeric(y, errors="coerce").to_numpy(float), 0.0, 1.0)
    book = float(np.nanmean(yy))
    warnings: list[str] = []

    numeric = pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > 8
    if numeric:
        v = pd.to_numeric(x, errors="coerce").to_numpy(float)
        ok = np.isfinite(v) & np.isfinite(yy)
        if edges:
            cuts = [float(e) for e in edges]
            idx = np.digitize(v[ok], cuts)
            n_bins = len(cuts) + 1
        else:
            q = np.unique(np.quantile(v[ok], np.linspace(0, 1, max_bins + 1)))
            cuts = [float(z) for z in q[1:-1]]
            idx = np.digitize(v[ok], cuts) if cuts else np.zeros(ok.sum(), int)
            n_bins = len(cuts) + 1
            idx = _merge_to_min(idx, n_bins, yy[ok])
            keep = sorted(set(int(i) for i in idx))
            remap = {b: i for i, b in enumerate(keep)}
            idx = np.array([remap[int(i)] for i in idx])
            # rebuild the surviving cut points
            cuts = [cuts[b - 1] for b in keep if b > 0]
            n_bins = len(keep)
        labels, los, his = [], [], []
        bounds = [-np.inf, *cuts, np.inf]
        for b in range(n_bins):
            lo, hi = bounds[b], bounds[b + 1]
            los.append(None if not np.isfinite(lo) else float(lo))
            his.append(None if not np.isfinite(hi) else float(hi))
            labels.append(
                f"< {hi:.4g}" if not np.isfinite(lo)
                else f">= {lo:.4g}" if not np.isfinite(hi)
                else f"[{lo:.4g}, {hi:.4g})")
        levels: list[list[str] | None] = [None] * n_bins
        yv = yy[ok]
    else:
        s = x.astype(str).where(x.notna(), "Missing")
        cats = s.value_counts()
        keep = list(cats.index[:12])
        lut = {c: i for i, c in enumerate(keep)}
        mapped = s.map(lut)
        ok = mapped.notna().to_numpy() & np.isfinite(yy)
        idx = mapped[ok].to_numpy(int)
        n_bins = len(keep)
        labels = [str(k) for k in keep]
        los = his = [None] * n_bins
        levels = [[str(k)] for k in keep]
        cuts = None
        yv = yy[ok]
        if len(cats) > 12:
            warnings.append(f"{len(cats) - 12} levels beyond the largest twelve "
                            f"are not shown.")

    bins: list[SeverityBin] = []
    fitted = np.full(len(yv), book)
    for b in range(n_bins):
        m = idx == b
        n = int(m.sum())
        if n == 0:
            continue
        mean = float(yv[m].mean())
        se = float(yv[m].std(ddof=1) / np.sqrt(n)) if n > 1 else 0.0
        fitted[m] = mean
        bins.append(SeverityBin(
            index=len(bins), label=labels[b], lo=los[b], hi=his[b],
            levels=levels[b], n=n, mean=mean, se=se,
            weight=float(_logit(mean) - _logit(book)),
            share=float(n / max(len(yv), 1)),
        ))
        if n < MIN_BIN:
            warnings.append(f"Bin “{labels[b]}” holds {n} defaults; its mean is "
                            f"an average of a handful of severities.")

    ll_bin = _quasi_ll(fitted, yv)
    ll_null = _quasi_ll(np.full(len(yv), book), yv)
    r2 = float(1.0 - ll_bin / ll_null) if ll_null else 0.0

    means = [b.mean for b in bins]
    d = np.diff(means) if len(means) > 2 else np.array([0.0])
    mono = bool(np.all(d >= -1e-12) or np.all(d <= 1e-12))
    direction = ("increasing" if len(means) > 1 and means[-1] > means[0]
                 else "decreasing" if len(means) > 1 else "flat")
    if monotone and not mono:
        warnings.append("Mean severity is not monotone across the bins.")

    return SeverityBinning(
        column=str(x.name), kind="numeric" if numeric else "categorical",
        bins=bins, edges=cuts, n_total=int(len(yv)), book_mean=book,
        deviance_r2=r2, monotone=mono, direction=direction, warnings=warnings)
