"""Severity diagnostics — the fractional-response versions, not the binary ones."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from creditiq import store
from creditiq.analysis.severity_binning import bin_severity
from creditiq.mev.panel import monthly_panel
from creditiq.models import lgd as LGD
from creditiq.models import lgd_diag as D


@pytest.fixture(scope="module")
def defaults():
    df = store.analysis_frame("cre")
    return LGD.attach_macro(df.loc[df["default_flag"] == 1].copy(), monthly_panel())


def _fit(treatments=()):
    base = LGD.LgdSpec.default_for("cre")
    spec = LGD.LgdSpec(base.portfolio, base.drivers, base.categoricals,
                       treatments=tuple(treatments))
    return LGD.fit_lgd(store.analysis_frame("cre"), spec, monthly_panel())


def test_robust_errors_differ_from_the_naive_ones():
    """The quasi-likelihood assumes Var(y|x) = mu(1-mu), which is false for a
    proportion with mass at both ends. The naive covariance is therefore wrong,
    and wrong in the direction that makes a term look significant."""
    m = _fit()
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    X = LGD.design_for(d, m)
    y = np.clip(d["lgd_realised"].to_numpy(float), 0, 1)
    mu = np.clip(1 / (1 + np.exp(-(X @ m.beta))), 1e-9, 1 - 1e-9)
    naive = np.linalg.pinv((X * (mu * (1 - mu))[:, None]).T @ X)
    robust = m.covariance
    assert robust is not None
    ratio = np.sqrt(np.diag(robust)) / np.sqrt(np.diag(naive))
    assert not np.allclose(ratio, 1.0, atol=0.05), (
        "robust and naive errors are indistinguishable — the sandwich is not applied")


def test_every_coefficient_carries_a_robust_standard_error():
    for c in _fit().coefficients:
        assert c["std_error"] is not None and c["std_error"] > 0
        assert c["p_value"] is not None and 0.0 <= c["p_value"] <= 1.0


def test_the_link_test_rejects_a_misspecified_mean_and_a_spline_repairs_it():
    """The whole reason the Explore stage offers transformations. With every
    driver linear the logit link does not describe the conditional mean; splining
    the two strongest drivers fixes it at the same fit quality."""
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    linear = D.diagnostics(_fit(), d)
    spline = D.diagnostics(
        _fit((("current_ltv", "spline"), ("cre_price_index_yoy", "spline"))), d)
    assert linear["link_test"]["p_value"] < 0.05, "the test case no longer fails"
    assert spline["link_test"]["p_value"] > 0.05
    assert spline["deviance_r2"] >= linear["deviance_r2"] - 1e-6


def test_the_diagnostics_are_fractional_not_binary():
    """No AUC, no KS: realised severity has no classes to separate."""
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    g = D.diagnostics(_fit(), d)
    assert "auc" not in g and "ks" not in g
    assert 0.0 < g["deviance_r2"] < 1.0
    assert -1.0 <= g["spearman"] <= 1.0
    assert 0.0 < g["mae"] < 1.0
    assert g["mean_predicted"] == pytest.approx(g["mean_actual"], abs=0.02)


def test_the_backtest_reports_a_split_it_cannot_support():
    """Rather than returning statistics from a handful of defaults."""
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    # A boundary late enough that nothing resolves after it. The commercial book
    # used to be thin enough that any late split failed; it now carries 2,385
    # workouts, so the split has to be constructed rather than assumed.
    thin = D.backtest(_fit(), d, "2025-12-15")
    assert thin["usable"] is False and "note" in thin
    assert str(thin["n_test"]) in thin["note"], "the note must state the counts"
    ok = D.backtest(_fit(), d, "2022-01-01")
    assert ok["usable"] and ok["test"]["n"] >= 20
    assert ok["test"]["spearman"] < ok["train"]["spearman"], (
        "an out-of-time split that does not degrade is suspicious")


def test_severity_binning_reports_no_information_value():
    """It is a divergence between event and non-event distributions. A fractional
    target has neither, so the number would have no referent."""
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    b = bin_severity(d["current_ltv"], d["lgd_realised"])
    payload = b.to_dict()
    assert "iv" not in payload and "information_value" not in payload
    assert 0.0 < payload["deviance_r2"] < 1.0


def test_a_bin_weight_is_the_logit_shift_against_the_book_mean():
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    b = bin_severity(d["current_ltv"], d["lgd_realised"])
    lg = lambda p: np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
    for z in b.bins:
        assert z.weight == pytest.approx(lg(z.mean) - lg(b.book_mean), abs=1e-9)


def test_a_binning_map_carries_from_the_fit_to_scoring():
    """Re-deriving it on the rows being scored would apply the coefficients to
    different columns."""
    m = _fit((("current_ltv", "weight"),))
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    assert "current_ltv" in m.maps
    half = d.iloc[: len(d) // 2]
    assert LGD.design_for(half, m).shape[1] == len(m.columns)


def test_weight_of_evidence_is_not_offered_for_severity():
    """It is ln[(events_b / all events) / (non-events_b / all non-events)]. A
    fractional target has neither events nor non-events, so the quantity is not
    defined. A mean encoding on the logit scale IS defined and was offered for a
    while; it measured worse than both alternatives and read as weight of
    evidence, so it was removed."""
    import typing
    from creditiq.models.spec import LgdTreatment
    assert set(typing.get_args(LgdTreatment)) == {"bins", "continuous", "spline"}


def test_a_saved_specification_carrying_the_removed_option_still_loads():
    b = LGD.LgdSpec.default_for("cre")
    old = LGD.LgdSpec(b.portfolio, b.drivers, b.categoricals,
                      treatments=(("current_ltv", "weight"),))
    assert old.treatment_of("current_ltv") == "bins"
    m = LGD.fit_lgd(store.analysis_frame("cre"), old, monthly_panel())
    assert m.columns


def test_severity_knots_are_placed_against_the_severity_fit():
    """The same search the PD side uses, scored on the fractional
    quasi-likelihood. It has to beat quantile placement or it is not doing
    anything."""
    from creditiq.analysis.curve import auto_knots_severity
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    r = auto_knots_severity(d["current_ltv"], d["lgd_realised"], 3)
    assert len(r["knots"]) == 3
    assert r["gain_over_quantile"] >= 0
    lo, hi = d["current_ltv"].quantile([0.01, 0.99])
    for a, b2 in zip(r["knots"], r["knots"][1:]):
        assert b2 - a > 0.08 * (hi - lo) * 0.99, "knots must stay apart"


def test_the_severity_spline_is_selected_on_a_quasi_likelihood_criterion():
    """A spline basis needs no adjustment for a fractional target — it transforms
    the COVARIATE, not the response. Everything built on the likelihood does.

    BIC is derived from a genuine likelihood; applied unscaled to a
    quasi-log-likelihood it misprices the extra columns by exactly the dispersion
    factor. And twice the quasi-log-likelihood difference is not chi-squared, so
    the block is tested with a Wald statistic from the sandwich covariance
    instead of a likelihood-ratio test.
    """
    from creditiq.analysis.curve import severity_curve
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    r = severity_curve(d["current_ltv"], d["lgd_realised"], knots=[40.0, 60.0, 80.0])
    spl = r["candidates"]["spline"]

    assert "lr_statistic" not in spl, "a quasi-LR statistic is not chi-squared"
    assert spl["wald"] is not None and spl["wald_df"] == 3
    assert 0.0 <= spl["wald_p"] <= 1.0

    phi = spl["dispersion"]
    assert phi > 0 and abs(phi - 1.0) > 0.05, (
        "if the dispersion were one there would be nothing to correct")
    # the scaled criterion must differ from the unscaled one by the dispersion
    lin = r["candidates"]["linear"]
    unscaled = (-2 * spl["log_likelihood"] + spl["n_params"] * np.log(lin["n"])) - \
               (-2 * lin["log_likelihood"] + lin["n_params"] * np.log(lin["n"]))
    assert abs(unscaled - spl["delta_bic"]) > 1.0, (
        "the dispersion correction is not being applied")


def test_the_pd_side_keeps_a_real_likelihood_ratio_test():
    """It fits a genuine logistic likelihood, so an LR test IS available there.
    The two sides are deliberately different."""
    import numpy as np
    import pandas as pd
    from creditiq.analysis.curve import numeric_curve
    rng = np.random.default_rng(4)
    x = rng.uniform(0, 10, 40_000)
    p = 1 / (1 + np.exp(-(-3 + 0.9 * np.minimum(x, 4.0))))
    y = (rng.random(40_000) < p).astype(float)
    r = numeric_curve(pd.Series(x), pd.Series(y), knots=[2.5, 5.0, 7.5])
    assert r["spline"]["lr_p"] is not None
    assert "dispersion" not in r["spline"]


def test_the_severity_curve_fits_both_candidate_forms():
    from creditiq.analysis.curve import severity_curve
    d = LGD.attach_macro(
        store.analysis_frame("cre").query("default_flag == 1").copy(), monthly_panel())
    r = severity_curve(d["current_ltv"], d["lgd_realised"], knots=[40.0, 60.0, 80.0])
    lin, spl = r["candidates"]["linear"], r["candidates"]["spline"]
    assert lin["n"] == r["n"]
    assert spl["deviance_r2"] >= lin["deviance_r2"] - 1e-9, (
        "the spline contains the line, so it cannot fit worse")
    assert spl["n_params"] > lin["n_params"]
    assert len(spl["fitted"]) == len(r["grid"])


def test_the_treatment_is_part_of_the_lgd_model_identity():
    a = _fit()
    b = _fit((("current_ltv", "spline"),))
    assert a.spec.hash() != b.spec.hash()
    assert len(b.columns) > len(a.columns)


def test_thin_periods_are_holes_rather_than_omissions():
    """A cohort with too few workouts must leave a gap, not disappear.

    Omitting it left no trace in the series, so a chart on a time axis joined
    the points either side and drew a band straight across months where nothing
    had resolved — inventing a level the book cannot support one for.
    """
    from creditiq.api import main as api_main
    from creditiq.models import lgd_diag as D

    d = api_main._lgd_frame("cre")
    rows = D.severity_over_time(d, freq="MS")
    thin = [r for r in rows if r["too_thin"]]
    assert thin, "commercial workouts cluster in downturns, so quiet months stay thin"
    for r in thin:
        assert r["actual"] is None and r["lo95"] is None and r["hi95"] is None

    cov = D.severity_coverage(d, "MS")
    assert cov["periods_kept"] + cov["periods_dropped"] == cov["periods_total"]
    assert cov["periods_kept"] == sum(1 for r in rows if not r["too_thin"])

    # Grouping wider must raise COVERAGE — the share of periods carrying a
    # point. Comparing raw counts is wrong and asserted the opposite of the
    # truth: a quarter view has a third of the periods to begin with, so it can
    # plot fewer of them while filling a far greater share.
    share = lambda c: c["periods_kept"] / c["periods_total"]
    assert share(D.severity_coverage(d, "QS")) > share(cov)


def test_the_severity_backtest_carries_a_time_series():
    """The backtest was a table of yearly means, which cannot show a turn."""
    from creditiq.api import main as api_main
    from creditiq.models import lgd as LGD, lgd_diag as D, rollup as R
    from creditiq.mev import panel as mevpanel

    spec, _, _ = R.spec_for("mortgage")
    d = api_main._lgd_frame("mortgage")
    m = LGD.fit_lgd(d.assign(default_flag=1), spec.lgd, mevpanel.monthly_panel())
    bt = D.backtest(m, d, "2022-01-01", freq="MS")

    assert bt["period_freq"] == "month"
    plotted = [r for r in bt["by_period"] if not r["too_thin"]]
    assert len(plotted) > 50
    for r in plotted:
        # Both series present, and the miss flag agrees with the interval.
        assert r["predicted"] is not None
        assert r["calibrated"] is (r["lo95"] <= r["predicted"] <= r["hi95"])
