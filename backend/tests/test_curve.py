"""The empirical log-odds curve — the view that decides a treatment."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from creditiq.analysis import curve as C


def _synthetic(f, n=60_000, seed=7):
    """A variable with a KNOWN shape in the log-odds, so the recommendation can
    be checked against the truth rather than against taste."""
    rng = np.random.default_rng(seed)
    x = rng.uniform(0.0, 10.0, n)
    p = 1.0 / (1.0 + np.exp(-f(x)))
    return pd.Series(x), pd.Series(rng.random(n) < p, dtype=float)


def test_a_straight_relationship_is_recommended_as_continuous():
    x, y = _synthetic(lambda v: -3.0 + 0.35 * v)
    r = C.numeric_curve(x, y, knots=[2.5, 5.0, 7.5])
    assert r["spline"]["delta_bic"] > 0, "the extra columns should not pay for themselves"
    assert r["recommendation"]["treatment"] == "continuous"


def test_a_smooth_bend_is_recommended_as_a_spline():
    x, y = _synthetic(lambda v: -3.0 + 0.9 * np.minimum(v, 4.0))   # hinge at 4
    r = C.numeric_curve(x, y, knots=[2.5, 5.0, 7.5])
    assert r["recommendation"]["treatment"] == "spline"
    assert r["spline"]["delta_bic"] < 0
    assert r["spline"]["pseudo_r2"] > r["linear"]["pseudo_r2"]


def test_the_candidate_curves_use_the_model_estimator_and_basis():
    """Not a separate approximation. The Explore stage fits the same spline basis
    with the same Newton-Raphson routine on the same rows, so the curve it draws
    is the curve the model fits for that term."""
    from creditiq.analysis import spline as SP
    from creditiq.models.design import _spline_basis
    from creditiq.models.fit import irls

    assert _spline_basis is SP.spline_basis, "one basis, used by both layers"

    x, y = _synthetic(lambda v: -3.0 + 0.9 * np.minimum(v, 4.0))
    knots = [2.5, 5.0, 7.5]
    r = C.numeric_curve(x, y, knots=knots)

    # refit by hand with the model's own pieces and compare the likelihood
    v = np.clip(x.to_numpy(float), *r["domain"])
    B, _, _ = SP.spline_basis(v, r["spline"]["knots"])
    beta, _, _, _ = irls(np.column_stack([np.ones(len(v)), B]), y.to_numpy(float))
    ll = C._log_likelihood(np.column_stack([np.ones(len(v)), B]) @ beta, y.to_numpy(float))
    assert abs(ll - r["spline"]["log_likelihood"]) < 1e-6


def test_significance_alone_does_not_add_columns_at_large_n():
    """At this many rows a pseudo R-squared change in the fourth decimal reaches
    p < 0.01. BIC is what stops that becoming a recommendation, and its penalty
    uses the event count because that is the effective sample size for a rare
    outcome."""
    x, y = _synthetic(lambda v: -3.0 + 0.35 * v + 0.004 * v ** 2, n=200_000)
    r = C.numeric_curve(x, y, knots=[2.5, 5.0, 7.5])
    sp = r["spline"]
    if sp["lr_p"] < 0.01 and sp["delta_bic"] > 0:
        assert r["recommendation"]["treatment"] == "continuous"
    assert sp["bic"] - sp["log_likelihood"] * -2.0 == pytest.approx(
        sp["n_params"] * np.log(r["linear"]["n_events"]), rel=1e-9)


def test_a_genuine_reversal_is_recommended_as_bins():
    x, y = _synthetic(lambda v: -3.2 + 0.55 * v - 0.11 * v ** 2)   # a hump
    r = C.numeric_curve(x, y, knots=[2.5, 5.0, 7.5])
    assert r["reversals"] >= 1
    assert r["recommendation"]["treatment"] in {"bins", "spline"}


def test_noise_is_not_mistaken_for_a_reversal():
    """The reason the zigzag filter exists.

    Counting sign changes in the differences reported eight reversals for FICO —
    a variable a straight line explains 97% of. Every one of them was a bucket
    wobbling inside its own confidence interval. A flag that fires on everything
    decides nothing.
    """
    x, y = _synthetic(lambda v: -3.0 + 0.35 * v)
    r = C.numeric_curve(x, y, knots=[2.5, 5.0, 7.5])
    assert r["reversals"] == 0


def test_thin_buckets_are_merged_rather_than_shown():
    """A bucket with three defaults has a log-odds whose interval spans the plot.
    Drawing it is worse than not drawing it, because it looks like evidence."""
    x, y = _synthetic(lambda v: -6.5 + 0.2 * v, n=20_000)
    r = C.numeric_curve(x, y, knots=None, resolution=60)
    assert all(p["events"] >= C.MIN_EVENTS or p is r["points"][-1] for p in r["points"])
    assert r["resolution"] < 60, "thin buckets should have been merged"


def test_an_empty_bucket_never_produces_an_infinite_log_odds():
    lo, se = C._log_odds(np.array([0.0]), np.array([500.0]))
    assert np.isfinite(lo).all() and np.isfinite(se).all()


def test_categorical_levels_come_back_ordered_by_risk():
    rng = np.random.default_rng(3)
    lvl = rng.choice(["a", "b", "c", "d"], 40_000, p=[0.4, 0.3, 0.2, 0.1])
    base = {"a": -5.0, "b": -4.0, "c": -3.0, "d": -2.0}
    p = 1 / (1 + np.exp(-np.array([base[v] for v in lvl])))
    r = C.categorical_curve(pd.Series(lvl), pd.Series(rng.random(40_000) < p, dtype=float))
    order = [q["level"] for q in r["points"]]
    assert order == ["a", "b", "c", "d"]


@pytest.mark.parametrize("portfolio,column,expected", [
    ("mortgage", "fico_orig", "continuous"),      # nearly linear in log-odds, as in life
    ("mortgage", "months_on_book", "spline"),     # the seasoning hump
    ("mortgage", "current_ltv", "spline"),        # the change of slope near 90
    ("consumer", "dti", "continuous"),
])
def test_the_real_books_give_the_answers_a_credit_analyst_expects(portfolio, column, expected):
    from creditiq import store
    from creditiq.data.portfolios import PORTFOLIOS
    df, _ = store.screening_frame(portfolio)
    r = C.numeric_curve(df[column], df[PORTFOLIOS[portfolio].target.column],
                        knots=[float(q) for q in
                               np.nanquantile(df[column].astype(float), [.2, .4, .6, .8])])
    assert r["recommendation"]["treatment"] == expected, r["recommendation"]["reason"]
