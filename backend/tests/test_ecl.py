"""ECL, LGD, EAD and bridge identities — the Definition-of-Done checks."""

from __future__ import annotations

import numpy as np
import pytest

from helios.models import bridge as BR


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
    from helios.models.ead import amortize
    bal = np.array([100_000.0, 50_000.0])
    path = amortize(bal, np.array([0.06, 0.09]), np.array([120.0, 60.0]), 36)
    assert (np.diff(path, axis=1) <= 1e-6).all(), "an amortizing balance rose"
    assert (path[:, -1] < bal).all()


def test_prepayment_accelerates_paydown():
    from helios.models.ead import amortize
    bal = np.array([100_000.0])
    slow = amortize(bal, np.array([0.06]), np.array([120.0]), 36, cpr=0.0)
    fast = amortize(bal, np.array([0.06]), np.array([120.0]), 36, cpr=0.15)
    assert fast[0, -1] < slow[0, -1]


def test_ccf_is_estimated_not_assumed():
    """The CRE book must yield a CCF from its own tape, not the regulatory default."""
    from helios import store
    from helios.models.ead import REGULATORY_CCF, estimate_ccf
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
    from helios import store
    from helios.mev.panel import monthly_panel
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


def test_lgd_two_stage_reproduces_the_zero_mass():
    from helios import store
    from helios.mev.panel import monthly_panel
    from helios.models.lgd import fit_lgd
    m = fit_lgd(store.analysis_frame("mortgage"), "mortgage", monthly_panel())
    # a mortgage book must have a real mass at exactly zero loss
    assert 0.30 < m.zero_loss_share < 0.70
    assert 0.0 < m.mean_severity_given_loss < 1.0
