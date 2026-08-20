"""Frequency reconciliation tests.

The headline test is `test_benchmarked_series_aggregates_back_exactly`. The brief
makes that an explicit Definition-of-Done item, because straight-line
interpolation between quarter-end points fails it and is the usual shortcut.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from helios.mev import reconcile as rc


@pytest.fixture
def rng():
    return np.random.default_rng(20260819)


# ── the identity the brief requires ──────────────────────────────────────────
@pytest.mark.parametrize("agg", ["avg", "sum", "eop"])
@pytest.mark.parametrize("scale", [1.0, 3.0e4, 1.0e-3])
def test_benchmarked_series_aggregates_back_exactly(rng, agg, scale):
    """Monthly series derived from quarterly must aggregate back to the published
    quarterly value, under that variable's own aggregation rule, at any magnitude."""
    nq = 60
    quarterly = scale * (100 + np.cumsum(rng.normal(0, 2, nq)))
    monthly = rc.denton_cholette(quarterly, nq * 3, agg)
    absr, relr = rc.aggregation_residual(monthly, quarterly, agg)
    assert relr < 1e-10, f"{agg} @ scale {scale}: relative residual {relr:.3e}"
    rc.assert_aggregates_back(monthly, quarterly, agg)


@pytest.mark.parametrize("agg", ["avg", "sum", "eop"])
def test_identity_holds_with_an_indicator(rng, agg):
    nq = 48
    quarterly = 500 + np.cumsum(rng.normal(0, 5, nq))
    indicator = 80 + np.cumsum(rng.normal(0, 1.5, nq * 3))
    monthly = rc.denton_cholette(quarterly, nq * 3, agg, indicator=indicator)
    rc.assert_aggregates_back(monthly, quarterly, agg)


def test_linear_interpolation_would_fail_the_identity(rng):
    """The shortcut this module exists to avoid. If this ever passes, the test is
    wrong — straight-line interpolation of quarter-end points does not preserve
    the quarterly average."""
    nq = 20
    quarterly = 100 + np.cumsum(rng.normal(0, 3, nq))
    qe = np.arange(nq) * 3 + 2                       # quarter-end month positions
    naive = np.interp(np.arange(nq * 3), qe, quarterly)
    _, relr = rc.aggregation_residual(naive, quarterly, "avg")
    assert relr > 1e-6, "linear interpolation unexpectedly satisfied the identity"


def test_denton_distributes_rather_than_replicating(rng):
    """Denton must interpolate a path, not repeat each quarterly value three times.

    Measured the way Denton actually defines smoothness — squared first
    differences — and by the largest single step, which a step function
    concentrates at the quarter boundary."""
    nq = 40
    quarterly = 100 + np.cumsum(rng.normal(0, 4, nq))
    monthly = rc.denton_cholette(quarterly, nq * 3, "avg")
    step = np.repeat(quarterly, 3)
    assert (np.diff(monthly) ** 2).sum() < (np.diff(step) ** 2).sum()
    assert np.abs(np.diff(monthly)).max() < np.abs(np.diff(step)).max()
    assert not np.allclose(monthly, step)


# ── growth rates go through the level, never directly ────────────────────────
def test_growth_level_round_trip(rng):
    g = rng.normal(2.5, 2.0, 80)
    back = rc.level_to_growth(rc.growth_to_level(g, 4), 4)
    assert np.abs(back - g).max() < 1e-9


def test_growth_benchmarking_preserves_the_quarterly_level(rng):
    """Quarterly growth -> monthly growth must leave the implied quarterly LEVEL
    path unchanged. This is the check that catches interpolating a rate."""
    g_q = rng.normal(2.0, 3.0, 40)
    g_m = rc.benchmark_growth_quarterly_to_monthly(g_q)
    assert len(g_m) == len(g_q) * 3
    q_level = rc.growth_to_level(g_q, 4)
    m_level = rc.growth_to_level(g_m, 12)
    # month 3k of the monthly level must equal quarter k of the quarterly level
    np.testing.assert_allclose(m_level[3::3], q_level[1:], rtol=1e-9)


def test_yoy_growth_to_level_reconstruction():
    """A constant 10% YoY must compound the level by 10% every four quarters."""
    g = np.full(12, 10.0)
    lv = rc.level_from_yoy_growth(g)
    assert lv[:4].tolist() == [100.0] * 4
    np.testing.assert_allclose(lv[4:8], 110.0)
    np.testing.assert_allclose(lv[8:12], 121.0)


# ── aggregation matrix + down-frequency ──────────────────────────────────────
def test_aggregation_matrix_shapes_and_rules():
    C = rc.build_aggregation_matrix(12, "avg")
    assert C.shape == (4, 12)
    np.testing.assert_allclose(C.sum(axis=1), 1.0)
    C = rc.build_aggregation_matrix(12, "sum")
    np.testing.assert_allclose(C.sum(axis=1), 3.0)
    C = rc.build_aggregation_matrix(12, "eop")
    assert C[0].tolist() == [0, 0, 1] + [0] * 9


def test_max_aggregation_is_rejected_for_benchmarking():
    """`max` has no linear form, so it must never reach the benchmarking path."""
    with pytest.raises(ValueError, match="not linear"):
        rc.build_aggregation_matrix(12, "max")


@pytest.mark.parametrize("agg,expected", [("avg", 16.0), ("eop", 31.0), ("sum", 496.0),
                                          ("max", 31.0)])
def test_down_frequency_follows_the_metadata_not_a_global_rule(agg, expected):
    idx = pd.date_range("2020-01-01", periods=31, freq="D")
    s = pd.Series(np.arange(1, 32, dtype=float), index=idx)
    out = rc.to_monthly_downfreq(s, agg)
    assert out.iloc[0] == pytest.approx(expected)
