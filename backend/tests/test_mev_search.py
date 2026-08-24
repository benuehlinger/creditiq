"""The macro transformation search: stationarity, effective sample size, signs."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from creditiq.analysis import mev_search as M


def test_a_random_walk_is_not_stationary_and_its_difference_is():
    """The filter the search exists for. Two independent random walks correlate
    at whatever level chance puts them, and a regression of one on the other
    reports a relationship that is not there."""
    rng = np.random.default_rng(11)
    idx = pd.date_range("2008-01-01", periods=216, freq="MS")
    walk = pd.Series(np.cumsum(rng.normal(0, 1, 216)), index=idx)
    assert M._adf(walk)["stationary"] is False
    assert M._adf(walk.diff())["stationary"] is True


def test_the_effective_sample_size_falls_with_serial_correlation():
    """216 monthly observations of a smooth series are not 216 independent ones.
    Without this adjustment the reported significance is meaningless."""
    rng = np.random.default_rng(3)
    n = 216
    white = rng.normal(0, 1, n)
    smooth = pd.Series(white).rolling(12, min_periods=1).mean().to_numpy()
    assert M._effective_n(white, white) == pytest.approx(n, rel=0.2)
    assert M._effective_n(smooth, smooth) < n / 2


def test_a_spurious_correlation_between_two_random_walks_loses_its_significance():
    rng = np.random.default_rng(7)
    idx = pd.date_range("2008-01-01", periods=216, freq="MS")
    a = pd.Series(np.cumsum(rng.normal(0, 1, 216)), index=idx)
    b = pd.Series(np.cumsum(rng.normal(0, 1, 216)), index=idx)
    c = M._correlate(a, b)
    naive_t = c["r"] * np.sqrt((c["n"] - 2) / (1 - c["r"] ** 2))
    assert abs(naive_t) > 2, "the unadjusted statistic would call this significant"
    assert c["n_effective"] < c["n"]


def test_a_candidate_column_round_trips():
    c = M.Candidate("unemployment_rate", "yoy", 6)
    assert c.column == "unemployment_rate@yoy@6"
    assert M.Candidate.parse(c.column) == c
    assert M.Candidate.parse("not a candidate") is None


def test_only_projectable_variables_are_offered():
    """A term with no published forward path cannot be projected, so it cannot
    enter a model that has to be stressed."""
    from creditiq.models.scenario_service import PROJECTION_MEVS
    lib = M.library("cre")
    assert {r["key"] for r in lib["rows"]} <= set(PROJECTION_MEVS)


def test_the_library_covers_every_transform_and_lag():
    lib = M.library("cre")
    assert {r["transform"] for r in lib["rows"]} == {t[0] for t in M.TRANSFORMS}
    assert {r["lag_months"] for r in lib["rows"]} == set(M.LAGS)
    assert lib["n_candidates"] == pytest.approx(
        lib["n_bases"] * len(M.TRANSFORMS) * len(M.LAGS), rel=0.15)


def test_the_search_finds_the_drivers_the_book_was_generated_from():
    """Commercial real estate was generated with a commercial property term, a
    BBB yield term and a GDP term. A search that cannot recover them is not
    measuring anything."""
    lib = M.library("cre")
    ok = [r for r in lib["rows"] if r["stationary"] and r["pd_r"] is not None]
    ok.sort(key=lambda r: -abs(r["pd_r"]))
    top = {r["key"] for r in ok[:20]}
    assert {"cre_price_index", "bbb_yield"} & top


def test_a_term_is_ranked_against_both_targets():
    """The two statistics are computed on different populations, so they are not
    comparable in size: PD is a monthly series over the estimation window, LGD is
    one observation per resolved default."""
    lib = M.library("cre")
    row = next(r for r in lib["rows"] if r["pd_r"] is not None and r["lgd_r"] is not None)
    assert row["pd_n"] >= 24
    assert row["lgd_n"] >= 30
    assert row["lgd_n_effective"] <= lib["lgd_months"]


def test_severity_is_correlated_per_default_not_on_a_monthly_mean():
    """A monthly mean reaches five resolutions in fourteen months on this book,
    which is too few to correlate anything against. The loan-level statistic uses
    all 381, and caps the effective sample size at the number of distinct months
    because a macro variable takes one value per month."""
    rows = M.lgd_rows("cre")
    assert len(rows) > 300
    lib = M.library("cre")
    r = next(x for x in lib["rows"] if x["lgd_r"] is not None)
    assert r["lgd_n"] > 300, "every default is used"
    assert r["lgd_n_effective"] <= lib["lgd_months"], (
        "a hundred defaults in one month carry one observation of the macro term")


def test_a_shortlisted_term_reaches_the_lgd_model_through_the_same_transform():
    """The search, the PD design matrix, the LGD design matrix and the scenario
    projection all build a term through `apply_mev_transform`. If they did not,
    a term selected here would mean something different in each place."""
    from creditiq import store
    from creditiq.mev.panel import monthly_panel
    from creditiq.models.design import apply_mev_transform
    from creditiq.models.lgd import attach_macro

    col = "cre_price_index@yoy@3"
    df = store.analysis_frame("cre")
    d = attach_macro(df.loc[df["default_flag"] == 1].copy(), monthly_panel(), (col,))
    assert col in d.columns

    panel = monthly_panel()
    want = apply_mev_transform(panel["cre_price_index"], "yoy").shift(3)
    idx = pd.DatetimeIndex(d["performance_date"]).to_period("M").to_timestamp()
    assert np.allclose(d[col].to_numpy(float), want.reindex(idx).to_numpy(float),
                       equal_nan=True)


def test_prior_resolves_under_the_name_the_portfolio_uses():
    """A book declares its prior under whichever series it fitted.

    The commercial book names `cre_price_index_yoy`; the search enumerates the
    base `cre_price_index`. Looking the prior up under the base key alone found
    nothing, so every commercial property candidate reported no prior.
    """
    lib = M.library("cre")
    prop = [r for r in lib["rows"] if r["key"] == "cre_price_index"]
    assert prop, "expected commercial property candidates"
    assert all(r["expected_sign"] == -1 for r in prop)


def test_sign_check_is_reported_per_target():
    """The table shows one correlation at a time; the check must match it."""
    lib = M.library("mortgage")
    for r in lib["rows"]:
        for t in ("pd", "lgd"):
            obs, ok = r[f"{t}_observed_sign"], r[f"{t}_sign_ok"]
            if r["expected_sign"] is None or obs is None:
                assert ok is None
            else:
                assert ok is (r["expected_sign"] == obs)
            if r[f"{t}_r"] is not None:
                assert obs == (1 if r[f"{t}_r"] > 0 else -1)


def test_no_prior_is_not_a_failed_prior():
    """`sign_ok is None` must stay distinct from False — the UI draws a dash."""
    lib = M.library("consumer")
    undeclared = [r for r in lib["rows"] if r["expected_sign"] is None]
    assert undeclared
    assert all(r["pd_sign_ok"] is None for r in undeclared)
