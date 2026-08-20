"""Frequency reconciliation — every MEV lands on ONE monthly grid.

The problem: FRED is mostly monthly, some daily, some weekly, some quarterly.
CCAR is quarterly. The loan panel is monthly. A validator will check what happens
at the seams, so nothing here is implicit.

Three rules, and all three are driven by the per-variable metadata in
`registry.py`, never by a global default:

1. DOWN-frequency (daily / weekly -> monthly). Collapse by the variable's own
   aggregation rule: period-average for rates and continuously-measured indices,
   end-of-period where the CCAR definition is end-of-period, sum for flows,
   period-maximum for the VIX (the Fed defines its path that way).

2. UP-frequency (quarterly -> monthly). Denton-Cholette PROPORTIONAL FIRST
   DIFFERENCE benchmarking, optionally against a monthly indicator series
   (Chow-Lin style). The requirement is an identity, not an approximation: the
   derived monthly series must aggregate back EXACTLY to the published quarterly
   value under that variable's own aggregation rule. `assert_aggregates_back`
   checks it and the test suite asserts it. Straight-line interpolation between
   quarter-end points does not satisfy this and is not used anywhere.

3. GROWTH RATES ARE NEVER INTERPOLATED DIRECTLY. A growth rate is a ratio of
   levels; averaging two ratios is not the ratio of the averaged levels. So:
   growth -> cumulative LEVEL index -> benchmark the LEVEL -> re-difference to a
   monthly growth rate. `growth_to_level` and `level_to_growth` are that pair.
   This is the most common macro-modelling error and the round trip is tested.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .registry import Mev

MONTHS_PER_Q = 3


# ── aggregation ──────────────────────────────────────────────────────────────
def _agg_func(agg: str):
    return {"avg": np.mean, "eop": lambda a: a[-1], "sum": np.sum, "max": np.max}[agg]


def build_aggregation_matrix(n_months: int, agg: str, offset: int = 0) -> np.ndarray:
    """C, shape (n_quarters, n_months): C @ monthly == quarterly, exactly.

    `max` has no linear form. It is handled outside the benchmarking path — a
    max-aggregated variable is monthly-native here (VIX is daily), so it never
    reaches the quarterly-to-monthly step.
    """
    if agg == "max":
        raise ValueError("max aggregation is not linear; it cannot be benchmarked")
    nq = (n_months - offset) // MONTHS_PER_Q
    C = np.zeros((nq, n_months))
    for q in range(nq):
        cols = slice(offset + q * MONTHS_PER_Q, offset + (q + 1) * MONTHS_PER_Q)
        if agg == "avg":
            C[q, cols] = 1.0 / MONTHS_PER_Q
        elif agg == "sum":
            C[q, cols] = 1.0
        elif agg == "eop":
            C[q, offset + (q + 1) * MONTHS_PER_Q - 1] = 1.0
        else:
            raise ValueError(f"unknown aggregation rule {agg!r}")
    return C


def to_monthly_downfreq(s: pd.Series, agg: str) -> pd.Series:
    """Daily or weekly -> monthly, by the variable's own rule."""
    g = s.resample("MS")
    out = {"avg": g.mean(), "eop": g.last(), "sum": g.sum(), "max": g.max()}[agg]
    return out.dropna()


# ── Denton-Cholette proportional first-difference benchmarking ───────────────
def denton_cholette(
    quarterly: np.ndarray,
    n_months: int,
    agg: str,
    indicator: np.ndarray | None = None,
    offset: int = 0,
) -> np.ndarray:
    """Distribute a quarterly series onto a monthly grid.

    Minimises the squared first differences of the ratio x_t / z_t, subject to
    C @ x == quarterly. z is the monthly indicator (Chow-Lin style) or a flat
    series when no related monthly series exists.

    Solved as an equality-constrained least squares problem through its KKT
    system, so the constraint holds to machine precision rather than
    approximately.
    """
    T = n_months
    z = np.ones(T) if indicator is None else np.asarray(indicator, dtype=float).copy()
    if z.shape != (T,):
        raise ValueError(f"indicator must have {T} monthly points, got {z.shape}")
    # A zero or sign-flipping indicator makes the proportional objective blow up.
    if np.any(np.abs(z) < 1e-12):
        z = np.where(np.abs(z) < 1e-12, np.sign(z) * 1e-12 + 1e-12, z)

    C = build_aggregation_matrix(T, agg, offset)
    y = np.asarray(quarterly, dtype=float)
    if y.shape[0] != C.shape[0]:
        raise ValueError(f"got {y.shape[0]} quarterly points but the monthly grid "
                         f"supports {C.shape[0]} whole quarters")

    # objective in u = x / z :  min ||D u||^2
    D = np.zeros((T - 1, T))
    rows = np.arange(T - 1)
    D[rows, rows] = -1.0
    D[rows, rows + 1] = 1.0
    H = 2.0 * (D.T @ D)
    # tiny ridge keeps the KKT block non-singular when T is large and D'D is rank T-1
    H[np.diag_indices_from(H)] += 1e-10

    # Scale the target to O(1) before solving. GDP arrives in billions, and an
    # unscaled KKT system loses ~8 digits on a series that large — enough to
    # break the aggregation identity in absolute terms.
    scale = float(np.mean(np.abs(y))) or 1.0
    y_s = y / scale
    A = C * z                      # C @ diag(z)
    k, n = A.shape
    KKT = np.zeros((n + k, n + k))
    KKT[:n, :n] = H
    KKT[:n, n:] = A.T
    KKT[n:, :n] = A
    rhs = np.concatenate([np.zeros(n), y_s])
    lu = np.linalg.solve
    sol = lu(KKT, rhs)
    # One step of iterative refinement. The KKT block is symmetric indefinite and
    # mildly ill-conditioned; refinement buys back the digits that matter for the
    # exact-aggregation identity the brief requires.
    for _ in range(2):
        sol = sol + lu(KKT, rhs - KKT @ sol)
    return sol[:n] * z * scale


def aggregation_residual(monthly: np.ndarray, quarterly: np.ndarray, agg: str,
                         offset: int = 0) -> tuple[float, float]:
    """Return (absolute, relative) worst aggregation residual."""
    C = build_aggregation_matrix(len(monthly), agg, offset)
    y = np.asarray(quarterly, dtype=float)
    resid = np.abs(C @ monthly - y)
    if not resid.size:
        return 0.0, 0.0
    denom = max(float(np.mean(np.abs(y))), 1e-12)
    return float(resid.max()), float(resid.max() / denom)


def assert_aggregates_back(monthly: np.ndarray, quarterly: np.ndarray, agg: str,
                           offset: int = 0, rtol: float = 1e-10) -> float:
    """The identity the brief requires: the derived monthly series aggregates back
    to the published quarterly value.

    Checked on a RELATIVE scale. A series measured in billions cannot be held to
    an absolute 1e-12 in float64 — there are not enough digits. Relative 1e-10 is
    at the edge of what double precision allows and is far tighter than any
    economic interpretation of the number.
    """
    absr, relr = aggregation_residual(monthly, quarterly, agg, offset)
    if relr > rtol:
        raise AssertionError(
            f"benchmarked monthly series does not aggregate back: worst residual "
            f"{absr:.3e} absolute, {relr:.3e} relative > {rtol:.1e}")
    return absr


# ── growth rates: level round trip ───────────────────────────────────────────
def growth_to_level(growth_pct_annualized: np.ndarray, periods_per_year: int,
                    base: float = 100.0) -> np.ndarray:
    """Annualized % growth -> a cumulative level index.

    A growth rate must never be interpolated directly. Convert it to the level it
    describes, benchmark the LEVEL, then re-difference. The level returned has
    one more point than the input: the base, then one point per growth
    observation.
    """
    g = np.asarray(growth_pct_annualized, dtype=float) / 100.0
    factors = (1.0 + g) ** (1.0 / periods_per_year)
    return base * np.concatenate([[1.0], np.cumprod(factors)])


def level_to_growth(level: np.ndarray, periods_per_year: int) -> np.ndarray:
    """Inverse of `growth_to_level`. Returns annualized % growth, one point shorter."""
    lv = np.asarray(level, dtype=float)
    ratio = lv[1:] / lv[:-1]
    return (ratio ** periods_per_year - 1.0) * 100.0


def level_from_yoy_growth(yoy_growth_pct: np.ndarray, base: float = 100.0,
                          periods_per_year: int = 4) -> np.ndarray:
    """Reconstruct a level index from year-over-year growth.

    The first `periods_per_year` observations become the base year at `base`;
    every later point compounds off the same period one year earlier. The base is
    arbitrary — only the shape and the growth of the result carry meaning.
    """
    g = np.asarray(yoy_growth_pct, dtype=float)
    lv = np.empty_like(g)
    lv[:periods_per_year] = base
    for t in range(periods_per_year, len(g)):
        lv[t] = lv[t - periods_per_year] * (1.0 + g[t] / 100.0)
    return lv


def benchmark_growth_quarterly_to_monthly(
    quarterly_growth_pct: np.ndarray,
    indicator_monthly: np.ndarray | None = None,
) -> np.ndarray:
    """The correct path for a growth variable.

    quarterly annualized growth -> quarterly level -> monthly level (benchmarked
    end-of-period, so each quarter's level lands exactly on the published value)
    -> monthly annualized growth.
    """
    q_level = growth_to_level(quarterly_growth_pct, periods_per_year=4)  # nq + 1 points
    nq = len(quarterly_growth_pct)
    n_months = nq * MONTHS_PER_Q
    # Benchmark the level so that the LAST month of each quarter equals the
    # quarterly level. q_level[0] is the base and anchors month 0.
    m_level = denton_cholette(q_level[1:], n_months, agg="eop",
                              indicator=indicator_monthly)
    assert_aggregates_back(m_level, q_level[1:], agg="eop")
    full = np.concatenate([[q_level[0]], m_level])
    return level_to_growth(full, periods_per_year=12)


# ── the public entry point ───────────────────────────────────────────────────
def to_monthly(s: pd.Series, mev: Mev,
               indicator: pd.Series | None = None) -> pd.Series:
    """Any native frequency -> the canonical monthly grid, per this MEV's metadata."""
    s = s.sort_index()
    if mev.native in ("D", "W"):
        return to_monthly_downfreq(s, mev.agg)
    if mev.native == "M":
        out = s.copy()
        out.index = out.index.to_period("M").to_timestamp()
        return out
    if mev.native == "Q":
        idx = s.index.to_period("Q")
        months = pd.date_range(idx.min().start_time, idx.max().end_time, freq="MS")
        ind = None
        if indicator is not None:
            ind = indicator.reindex(months).interpolate().bfill().ffill().to_numpy()
        vals = denton_cholette(s.to_numpy(dtype=float), len(months), mev.agg, ind)
        assert_aggregates_back(vals, s.to_numpy(dtype=float), mev.agg)
        return pd.Series(vals, index=months, name=s.name)
    raise ValueError(f"unknown native frequency {mev.native!r}")
