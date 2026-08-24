"""ECL, LGD, EAD and bridge identities — the Definition-of-Done checks."""

from __future__ import annotations

import numpy as np
import pytest

from creditiq.models import bridge as BR


@pytest.fixture
def parts():
    rng = np.random.default_rng(4)
    n, h = 400, 36
    def mk(scale):
        pd_ = rng.random((n, h)) * 0.012 * scale
        return {"pd": pd_,
                "survival": np.cumprod(
                    np.concatenate([np.ones((n, 1)), 1 - pd_[:, :-1]], axis=1), axis=1),
                "lgd": np.clip(rng.random((n, h)) * 0.45 * scale, 0, 1),
                "ead": rng.random((n, h)) * 1e5,
                "df": 1 / np.power(1.004, np.arange(1, h + 1))[None, :]}
    b = mk(1.0)
    s = mk(2.4)
    s["ead"] = b["ead"] * 1.08
    return b, s


# ── the survival identity ────────────────────────────────────────────────────
def test_survival_adjustment_prevents_double_counting():
    """Marginal PDs over a lifetime must never exceed 1.

    Summing CONDITIONAL hazards does — an account cannot default in month 30 if it
    already defaulted in month 12. The running survival product is what converts
    the conditional hazard into a marginal probability.
    """
    rng = np.random.default_rng(1)
    pd_t = rng.random((500, 60)) * 0.05
    surv = np.cumprod(np.concatenate([np.ones((500, 1)), 1 - pd_t[:, :-1]], axis=1), axis=1)
    mpd = pd_t * surv
    assert (mpd.sum(axis=1) <= 1.0 + 1e-9).all(), "marginal PDs exceed certainty"
    # and the naive version genuinely does breach it, which is why this matters
    assert (pd_t.sum(axis=1) > 1.0).any()


def test_survival_matches_the_closed_form():
    """cumulative default = 1 - PRODUCT(1 - PD(t)) must equal the summed marginals."""
    rng = np.random.default_rng(2)
    pd_t = rng.random((200, 40)) * 0.03
    surv = np.cumprod(np.concatenate([np.ones((200, 1)), 1 - pd_t[:, :-1]], axis=1), axis=1)
    np.testing.assert_allclose((pd_t * surv).sum(axis=1),
                               1 - np.prod(1 - pd_t, axis=1), rtol=1e-10)


# ── the bridge must reconcile ────────────────────────────────────────────────
def test_bridge_reconciles_exactly(parts):
    b, s = parts
    steps = BR.build_bridge(b, s)
    ok, resid = BR.reconciles(steps)
    assert ok, f"bridge does not reconcile: residual {resid}"
    assert abs(resid) < 1e-6


def test_bridge_endpoints_match_direct_ecl(parts):
    b, s = parts
    steps = BR.build_bridge(b, s)
    direct_base = float((b["pd"] * b["survival"] * b["lgd"] * b["ead"] * b["df"]).sum())
    direct_str = float((s["pd"] * s["survival"] * s["lgd"] * s["ead"] * s["df"]).sum())
    assert steps[0].value == pytest.approx(direct_base, rel=1e-12)
    assert steps[-1].value == pytest.approx(direct_str, rel=1e-12)


def test_shapley_totals_agree_with_the_bridge(parts):
    """Order-free attribution must reach the same total as sequential substitution,
    even though it splits the movement differently."""
    b, s = parts
    steps = BR.build_bridge(b, s)
    sh = BR.contributions_shapley(b, s)
    assert sum(sh.values()) == pytest.approx(steps[-1].value - steps[0].value, rel=1e-9)


def test_survival_step_offsets_the_pd_step(parts):
    """A book that defaults faster has fewer accounts left to default later.

    The survival step must therefore push the OPPOSITE way to the PD step. If it
    ever shares its sign, the two have been conflated and the PD contribution is
    overstated.
    """
    b, s = parts
    steps = {x.label: x.value for x in BR.build_bridge(b, s)}
    assert steps["PD"] > 0
    assert steps["Survival & mix"] < 0


# ── ECL responds in the economically correct direction ───────────────────────
def test_ecl_rises_with_pd_lgd_and_ead(parts):
    b, _ = parts
    base = float((b["pd"] * b["survival"] * b["lgd"] * b["ead"] * b["df"]).sum())
    for factor in ("pd", "lgd", "ead"):
        up = dict(b)
        up[factor] = b[factor] * 1.2
        if factor == "pd":
            up["survival"] = np.cumprod(
                np.concatenate([np.ones((b["pd"].shape[0], 1)), 1 - up["pd"][:, :-1]],
                               axis=1), axis=1)
        worse = float((up["pd"] * up["survival"] * up["lgd"] * up["ead"] * up["df"]).sum())
        assert worse > base, f"raising {factor} did not raise ECL"


def test_discounting_reduces_ecl(parts):
    b, _ = parts
    undiscounted = float((b["pd"] * b["survival"] * b["lgd"] * b["ead"]).sum())
    discounted = float((b["pd"] * b["survival"] * b["lgd"] * b["ead"] * b["df"]).sum())
    assert discounted < undiscounted


# ── EAD ──────────────────────────────────────────────────────────────────────
def test_amortization_paydown_is_monotone():
    from creditiq.models.ead import amortize
    bal = np.array([100_000.0, 50_000.0])
    path = amortize(bal, np.array([0.06, 0.09]), np.array([120.0, 60.0]), 36)
    assert (np.diff(path, axis=1) <= 1e-6).all(), "an amortizing balance rose"
    assert (path[:, -1] < bal).all()


def test_prepayment_accelerates_paydown():
    from creditiq.models.ead import amortize
    bal = np.array([100_000.0])
    slow = amortize(bal, np.array([0.06]), np.array([120.0]), 36, cpr=0.0)
    fast = amortize(bal, np.array([0.06]), np.array([120.0]), 36, cpr=0.15)
    assert fast[0, -1] < slow[0, -1]


def test_ccf_is_estimated_not_assumed():
    """The CRE book must yield a CCF from its own tape, not the regulatory default."""
    from creditiq import store
    from creditiq.models.ead import REGULATORY_CCF, estimate_ccf
    ccf, n, note = estimate_ccf(store.load("cre").panel)
    assert n > 50, f"only {n} facilities in the CCF cohort"
    assert 0.0 <= ccf <= 1.0
    assert ccf != REGULATORY_CCF, "fell back to the regulatory factor"
    assert "excluded" in note


# ── LGD ──────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("portfolio,mev,expect_positive", [
    ("consumer", "unemployment_rate", True),      # worse labour market, worse recovery
    ("mortgage", "hpi_yoy", False),               # rising prices, better recovery
    ("cre", "cre_price_index_yoy", False),
])
def test_realised_lgd_moves_with_the_cycle(portfolio, mev, expect_positive):
    """A downturn LGD that does not move is the most common thing a validator
    catches. The realised severity in the DATA must carry the relationship before
    any model can find it."""
    import pandas as pd
    from creditiq import store
    from creditiq.mev.panel import monthly_panel
    p = store.load(portfolio).panel
    d = p[p["default_flag"] == 1]
    when = pd.DatetimeIndex(d["performance_date"]).to_period("M").to_timestamp()
    m = monthly_panel()[mev].reindex(when).to_numpy()
    lo, hi = np.nanquantile(m, 0.25), np.nanquantile(m, 0.75)
    low_q = d["lgd_realised"][m <= lo].mean()
    high_q = d["lgd_realised"][m >= hi].mean()
    if expect_positive:
        assert high_q > low_q * 1.05, f"{portfolio}: LGD flat in {mev}"
    else:
        assert low_q > high_q * 1.05, f"{portfolio}: LGD flat in {mev}"


def test_the_zero_loss_mass_is_reported():
    from creditiq import store
    from creditiq.mev.panel import monthly_panel
    from creditiq.models.lgd import fit_lgd
    m = fit_lgd(store.analysis_frame("mortgage"), "mortgage", monthly_panel())
    # A mortgage book resolves a material share of defaults with no loss. The
    # single fractional logit does not model that mass separately, so the share
    # is reported as a descriptive statistic.
    assert 0.20 < m.zero_loss_share < 0.70
    assert 0.0 < m.mean_severity_given_loss < 1.0


# ── the scenario that is actually run ────────────────────────────────────────
def test_the_default_projection_uses_the_published_fed_path():
    """Winsorizing the forward path is a defensible technique. It is off by default.

    On the CRE book it clips the Fed's commercial property fall from -24.1% to
    -10.7% — this panel starts in 2015 and never saw a property crash — which
    removes 60% of the loss. A headline reading "severely adverse" while quietly
    running a milder path reports the wrong figure.
    """
    import inspect
    from creditiq.models import scenario_service as SS
    default = inspect.signature(SS.run).parameters["cap_to_fitted_range"].default
    assert default is False, "the default projection must be the Fed's published path"


def test_constraining_the_path_can_only_reduce_the_stress():
    """Mortgage, because it is the book that still leaves its window.

    Commercial real estate used to be the example here. Since the panel opens in
    2008 its fitted range contains the 2009 property crash and the supervisory
    path no longer leaves it, so there is nothing to constrain and no alternative
    figure to price. That is the fix working, not the test failing.
    """
    from creditiq.models import rollup as R
    from creditiq.models import scenario_service as SS
    spec, _, _ = R.spec_for("mortgage")
    r = SS.run(spec)
    assert any(e.outside for e in r.extrapolation)
    alt = r.alternative_ecl.get("severely_adverse")
    assert alt is not None, "a flagged breach must always price the constrained view too"
    assert alt <= r.results["severely_adverse"].ecl


def test_the_crisis_window_puts_commercial_property_back_inside_the_evidence():
    """The reason the panel starts in 2008.

    On a 2015-2025 window the supervisory commercial property path sat 2.1
    standard deviations outside the fitted floor, and 60% of the stressed CRE
    loss was extrapolation. Estimating through 2009 is the actual fix — not
    winsorizing the path, which caps the stress along with the extrapolation.
    """
    from creditiq.models import rollup as R
    from creditiq.models import scenario_service as SS
    spec, _, _ = R.spec_for("cre")
    breached = {e.key for e in SS.run(spec).extrapolation if e.outside}
    assert "cre_price_index_yoy" not in breached


def test_the_extrapolation_check_covers_lgd_drivers_not_just_pd_terms():
    """Mortgage LGD takes hpi_yoy. Clipping the house-price fall moved mortgage
    ECL by a third while the panel reported nothing out of range, because it was
    only inspecting the PD model's macro terms. Severity is where a housing
    stress bites."""
    from creditiq.models import rollup as R
    from creditiq.models import scenario_service as SS
    spec, _, _ = R.spec_for("mortgage")
    assert "hpi_yoy" not in {m.key for m in spec.mevs}, "spec changed; pick another case"
    flagged = {e.key for e in SS.run(spec).extrapolation if e.outside}
    assert "hpi_yoy" in flagged


def test_a_transformed_macro_lgd_term_is_projected_on_the_scenario_path():
    """A severity model carrying a term from the macro search must receive that
    term, built from the SCENARIO path through the same transform the fit used.

    The projection attached a fixed block of three macro columns and nothing
    else, so any LGD specification promoted from the macro search produced a
    design with fewer columns than the model had coefficients. It raised on a
    shape mismatch, which was luck: had one driver been dropped and another
    added, the coefficients would have been applied to the wrong columns and
    returned a number.
    """
    from creditiq.models import scenario_service as SS
    from creditiq.models.spec import LgdSpec, MevSpec, ModelSpec, VariableSpec

    spec = ModelSpec(
        "cre", [VariableSpec("dscr_reported"), VariableSpec("current_ltv")],
        mevs=[MevSpec("cre_price_index", transform="yoy", lag_months=3)],
        lgd=LgdSpec("cre", drivers=("current_ltv", "cre_price_index@yoy@3")))
    r = SS.run(spec, force=True)
    assert "cre_price_index@yoy@3" in r.lgd.columns
    assert r.results["severely_adverse"].ecl > r.results["baseline"].ecl


def test_scoring_an_lgd_model_without_every_fitted_driver_is_an_error():
    """Not a silently shorter design."""
    import pytest
    from creditiq import store
    from creditiq.mev.panel import monthly_panel
    from creditiq.models.lgd import LgdSpec, design_for, fit_lgd

    df = store.analysis_frame("cre")
    m = fit_lgd(df, LgdSpec("cre", drivers=("current_ltv", "workout_months")),
                monthly_panel())
    d = df.loc[df["default_flag"] == 1].drop(columns=["workout_months"])
    with pytest.raises(ValueError, match="workout_months"):
        design_for(d, m)


def test_stressed_default_rates_never_fall_below_baseline():
    """A severely adverse scenario that reduces the default rate is wrong.

    The commercial specification carried a BBB yield term that fitted -0.11
    against a positive prior at p = 0.18 — an insignificant term with the wrong
    sign. Under stress the yield widens immediately while the property fall
    builds over the following year, so that coefficient pushed stressed PD to
    0.63x baseline for the first nine months of the projection. Dropping it also
    improved test AUC.
    """
    from creditiq.models import rollup as R
    from creditiq.models import scenario_service as SS
    from creditiq.models.spec import LgdSpec, MevSpec, ModelSpec, VariableSpec
    # The shipped defaults. A saved champion is the user's own artefact and may
    # legitimately carry anything; the roll-up now reports its sign flips rather
    # than using it silently.
    for portfolio, (cols, mevs) in R.FALLBACK_SPECS.items():
        spec = ModelSpec(portfolio, [VariableSpec(c) for c in cols],
                         [MevSpec(m) for m in mevs],
                         lgd=LgdSpec.default_for(portfolio))
        r = SS.run(spec)
        base = [m["marginal_pd"] for m in r.results["baseline"].monthly]
        sev = [m["marginal_pd"] for m in r.results["severely_adverse"].monthly]
        worst = min(s / max(b, 1e-12) for b, s in zip(base, sev))
        assert worst > 0.95, (
            f"{portfolio}: stressed marginal PD falls to {worst:.2f}x baseline")


def test_no_default_specification_ships_with_a_sign_flip():
    """The roll-up headline is produced by these. A term the platform's own sign
    check flags should not be in the specification it ships with."""
    from creditiq.data.portfolios import PORTFOLIOS
    from creditiq.models import rollup as R
    from creditiq.models import service as MS
    from creditiq.models.spec import LgdSpec, MevSpec, ModelSpec, VariableSpec
    for portfolio, (cols, mevs) in R.FALLBACK_SPECS.items():
        spec = ModelSpec(portfolio, [VariableSpec(c) for c in cols],
                         [MevSpec(m) for m in mevs],
                         lgd=LgdSpec.default_for(portfolio))
        priors = PORTFOLIOS[portfolio].expected_signs
        for c in MS.run(spec).fit.coefficients:
            if not c.name.startswith("mev:"):
                continue
            prior = priors.get(c.name[4:].split()[0])
            if prior is None:
                continue
            assert prior == (1 if c.estimate > 0 else -1), (
                f"{portfolio}: {c.name} fits {c.estimate:+.4f} against prior {prior}")
