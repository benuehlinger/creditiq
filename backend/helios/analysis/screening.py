"""Variable screening: information value, leakage, correlation, VIF, stability.

The leakage guardrail is the part worth reading. A naive rule — "information
value above 0.5 means leakage" — is wrong in both directions. It fires on FICO,
which legitimately scores 0.82 on a consumer book and is the single most defensible
variable a scorecard can carry, and it misses a moderately leaky variable that
happens to score 0.45.

Leakage has a SHAPE, not just a size. An outcome-contaminated variable
concentrates nearly all the events into a tiny slice of the population, because
it is really a restatement of the outcome. A genuinely strong predictor spreads
its power across the whole range.

The discriminator is MAX BIN LIFT: the largest ratio, over bins, of the share of
events captured to the share of population held.

    lift(bin) = (events in bin / all events) / (rows in bin / all rows)

On the consumer book the planted `collections_referral_flag` reaches a lift above
200x, because 93% of defaults sit in a bin holding 0.4% of the population. FICO,
with a comparable information value, peaks around 6x. The two are not close, and
the rule separates them cleanly.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.cluster import hierarchy
from scipy.spatial.distance import squareform

from .binning import (Binning, bin_categorical, bin_numeric, iv_null_floor,
                      null_floor_for_shape)

# The classic interpretation bands. Quoted in the UI beside the null floor,
# because they are NOT sample-size free and are routinely presented as if they were.
IV_BANDS = [
    (0.02, "not predictive"),
    (0.10, "weak"),
    (0.30, "medium"),
    (0.50, "strong"),
    (float("inf"), "suspicious — check for leakage"),
]

LEAKAGE_LIFT = 25.0     # a bin capturing 25x its population share
LEAKAGE_IV = 0.75


@dataclass
class Screen:
    column: str
    kind: str
    iv: float
    iv_band: str
    iv_null_floor: float
    above_null: bool
    max_bin_lift: float
    leakage_risk: str            # none | review | likely
    leakage_reason: str
    monotone: bool
    monotone_direction: str
    missing_pct: float
    n_unique: int
    expected_sign: int | None
    observed_sign: int | None
    sign_ok: bool | None
    psi: float | None = None
    warnings: list[str] = field(default_factory=list)


def _band(iv: float) -> str:
    for hi, name in IV_BANDS:
        if iv < hi:
            return name
    return IV_BANDS[-1][1]


def max_bin_lift(b: Binning) -> tuple[float, str]:
    """Largest event-capture lift over the bins, and the bin that produced it."""
    if not b.n_events:
        return 0.0, ""
    best, label = 0.0, ""
    for bn in b.bins:
        if bn.count == 0:
            continue
        share_events = bn.events / b.n_events
        share_rows = bn.count / max(b.n_total, 1)
        if share_rows <= 0:
            continue
        lift = share_events / share_rows
        if lift > best:
            best, label = lift, bn.label
    return float(best), label


def leakage_verdict(b: Binning) -> tuple[str, str, float]:
    """Classify a variable as clean, worth a look, or leakage-shaped."""
    lift, where = max_bin_lift(b)
    if lift >= LEAKAGE_LIFT and b.iv >= LEAKAGE_IV:
        return ("likely",
                f"Bin “{where}” captures {lift:.0f}x its share of the population. "
                f"A variable that concentrates the outcome this hard is usually a "
                f"restatement of it, recorded at or after the event, and is not "
                f"knowable at the decision point.", lift)
    if b.iv >= 0.5:
        return ("review",
                f"Information value {b.iv:.2f} is in the strong band, but the "
                f"strongest bin only lifts {lift:.1f}x, which is the profile of a "
                f"genuinely predictive variable rather than a contaminated one. "
                f"Confirm it is knowable at the decision point.", lift)
    return ("none", "", lift)


def observed_sign(b: Binning) -> int | None:
    """Direction of the relationship, from the fitted bins.

    Positive means a higher value of the variable goes with a higher event rate.
    Compared against the portfolio's economic prior so a sign flip is caught at
    SELECTION time, not after a model is fitted around it.
    """
    real = [x for x in b.bins if not x.is_special and x.count > 0]
    if len(real) < 3 or b.kind != "numeric":
        return None
    r = np.array([x.event_rate for x in real])
    if np.all(np.isnan(r)):
        return None
    return 1 if r[-1] > r[0] else -1


def screen_column(x: pd.Series, y: pd.Series, expected: int | None = None,
                  max_bins: int = 8, with_null: bool = True,
                  null_floor: float | None = None) -> tuple[Screen, Binning]:
    numeric = pd.api.types.is_numeric_dtype(x) and x.nunique(dropna=True) > 12
    b = bin_numeric(x, y, max_bins=max_bins) if numeric else bin_categorical(x, y)
    risk, reason, lift = leakage_verdict(b)
    if null_floor is not None:
        floor = null_floor
    else:
        floor = iv_null_floor(x, y) if with_null else 0.0
    obs = observed_sign(b)
    return (
        Screen(
            column=str(x.name), kind=b.kind, iv=b.iv, iv_band=_band(b.iv),
            iv_null_floor=floor, above_null=b.iv > floor,
            max_bin_lift=lift, leakage_risk=risk, leakage_reason=reason,
            monotone=b.monotone, monotone_direction=b.monotone_direction,
            missing_pct=float(x.isna().mean() * 100),
            n_unique=int(x.nunique(dropna=True)),
            expected_sign=expected, observed_sign=obs,
            sign_ok=None if (expected is None or obs is None) else (expected == obs),
            warnings=b.warnings,
        ),
        b,
    )


# ── stability over time ──────────────────────────────────────────────────────
def psi(expected: pd.Series, actual: pd.Series, bins: int = 10) -> float:
    """Population stability index against a baseline period.

    Time-instability is often the real reason a variable should be dropped, and
    almost no tool shows it at SELECTION time — by the time anyone looks, the
    model is built.

        PSI = sum over bins of (actual% - expected%) x ln(actual% / expected%)

    Bands: below 0.10 stable, 0.10-0.25 some shift, above 0.25 unstable.
    """
    e = pd.to_numeric(expected, errors="coerce").dropna()
    a = pd.to_numeric(actual, errors="coerce").dropna()
    if len(e) < 50 or len(a) < 50:
        return float("nan")
    edges = np.unique(np.nanquantile(e, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        return 0.0
    edges[0], edges[-1] = -np.inf, np.inf
    pe = np.histogram(e, edges)[0] / len(e)
    pa = np.histogram(a, edges)[0] / len(a)
    # a zero cell makes the log infinite; floor both at a half-observation
    pe = np.where(pe == 0, 0.5 / len(e), pe)
    pa = np.where(pa == 0, 0.5 / len(a), pa)
    return float(np.sum((pa - pe) * np.log(pa / pe)))


def psi_over_time(df: pd.DataFrame, column: str, date_col: str = "performance_date",
                  baseline_months: int = 12, freq: str = "QS") -> list[dict]:
    d = df[[date_col, column]].dropna(subset=[date_col])
    start = d[date_col].min()
    base = d.loc[d[date_col] < start + pd.DateOffset(months=baseline_months), column]
    out = []
    for period, grp in d.groupby(pd.Grouper(key=date_col, freq=freq)):
        if len(grp) < 50:
            continue
        out.append({"period": period.strftime("%Y-%m-%d"),
                    "psi": psi(base, grp[column]), "n": int(len(grp))})
    return out


# ── correlation and multicollinearity ────────────────────────────────────────
def correlation(df: pd.DataFrame, columns: list[str],
                method: str = "pearson") -> dict:
    """Correlation matrix, hierarchically clustered so related variables sit
    together and the blocks are visible rather than scattered."""
    num = df[columns].apply(pd.to_numeric, errors="coerce")
    num = num.loc[:, num.std(numeric_only=True).fillna(0) > 0]
    c = num.corr(method=method).fillna(0.0)
    cols = list(c.columns)
    order = cols
    if len(cols) > 2:
        dist = 1.0 - c.abs().to_numpy()
        np.fill_diagonal(dist, 0.0)
        dist = (dist + dist.T) / 2
        z = hierarchy.linkage(squareform(dist, checks=False), method="average")
        order = [cols[i] for i in hierarchy.leaves_list(z)]
    c = c.loc[order, order]
    return {"columns": order,
            "matrix": [[float(v) for v in row] for row in c.to_numpy()],
            "method": method}


def high_correlation_pairs(df: pd.DataFrame, columns: list[str],
                           threshold: float = 0.90) -> list[dict]:
    num = df[columns].apply(pd.to_numeric, errors="coerce")
    c = num.corr().abs()
    out = []
    cols = list(c.columns)
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            v = c.iloc[i, j]
            if np.isfinite(v) and v >= threshold:
                out.append({"a": cols[i], "b": cols[j], "corr": float(c.iloc[i, j])})
    return sorted(out, key=lambda r: -r["corr"])


def vif(df: pd.DataFrame, columns: list[str]) -> list[dict]:
    """Variance inflation factor for the current selection.

    VIF_j = 1 / (1 - R2_j), where R2_j comes from regressing variable j on all the
    others. Above 5 is usually called a problem; above 10 is severe. Computed from
    the inverse correlation matrix, whose diagonal IS the VIF vector — one matrix
    inversion instead of one regression per variable, so it can update live as an
    analyst adds and removes variables.
    """
    num = df[columns].apply(pd.to_numeric, errors="coerce").dropna()
    keep = [c for c in num.columns if num[c].std() > 0]
    if len(keep) < 2:
        return [{"column": c, "vif": 1.0} for c in columns]
    c = num[keep].corr().to_numpy()
    try:
        inv = np.linalg.pinv(c)
    except np.linalg.LinAlgError:
        return [{"column": c_, "vif": float("nan")} for c_ in keep]
    return [{"column": keep[i], "vif": float(max(inv[i, i], 1.0))} for i in range(len(keep))]


def cluster_representatives(df: pd.DataFrame, columns: list[str],
                            ivs: dict[str, float], threshold: float = 0.7) -> list[dict]:
    """One-per-cluster assist: group correlated variables, recommend the highest
    information value in each group. A suggestion the analyst accepts or rejects,
    never something that happens to them."""
    num = df[columns].apply(pd.to_numeric, errors="coerce")
    num = num.loc[:, num.std(numeric_only=True).fillna(0) > 0]
    cols = list(num.columns)
    if len(cols) < 2:
        return [{"cluster": 0, "members": cols, "recommended": cols[0] if cols else None}]
    c = num.corr().abs().fillna(0).to_numpy()
    dist = 1.0 - c
    np.fill_diagonal(dist, 0.0)
    dist = (dist + dist.T) / 2
    z = hierarchy.linkage(squareform(dist, checks=False), method="average")
    labels = hierarchy.fcluster(z, t=1.0 - threshold, criterion="distance")
    out = []
    for cl in sorted(set(labels)):
        members = [cols[i] for i in range(len(cols)) if labels[i] == cl]
        best = max(members, key=lambda m: ivs.get(m, 0.0))
        out.append({"cluster": int(cl), "members": members, "recommended": best})
    return out
