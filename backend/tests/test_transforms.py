"""How a variable enters the model: discretizer and encoder as separate choices."""

from __future__ import annotations

import numpy as np
import pytest
from scipy import stats

from helios import store
from helios.models import design as D
from helios.models import fit as F
from helios.models.spec import TREATMENTS, MevSpec, ModelSpec, VariableSpec


@pytest.fixture(scope="module")
def df():
    return store.analysis_frame("consumer")


def _spec(col, treatment, extra=("dti",)):
    return ModelSpec("consumer",
                     [VariableSpec(col, treatment=treatment),
                      *[VariableSpec(c) for c in extra]],
                     [MevSpec("unemployment_rate")])


# ── the four treatments are genuinely different ──────────────────────────────
@pytest.mark.parametrize("treatment,expect_one_column", [
    ("woe", True), ("continuous", True), ("bins", False), ("spline", False),
])
def test_treatment_controls_the_column_count(df, treatment, expect_one_column):
    spec = _spec("fico_orig", treatment)
    des = D.build(df, spec)
    cols = [c for c in des.columns if c.startswith("fico_orig")]
    assert cols, f"{treatment} produced no columns for fico_orig"
    assert (len(cols) == 1) is expect_one_column, f"{treatment} gave {len(cols)} columns"


def test_dummies_use_a_reference_level(df):
    """k bins must give k-1 indicators, or the design is not full rank."""
    woe = D.build(df, _spec("fico_orig", "woe"))
    n_bins = len(woe.woe_maps["fico_orig"]["woe"])
    dummies = D.build(df, _spec("fico_orig", "bins"))
    cols = [c for c in dummies.columns if c.startswith("fico_orig=")]
    non_missing = [c for c in cols if not c.endswith("=Missing")]
    assert len(non_missing) == n_bins - 1


def test_treatment_changes_the_specification_hash(df):
    """Otherwise two different models would share a version identity."""
    hashes = {t: _spec("fico_orig", t).hash() for t in TREATMENTS}
    assert len(set(hashes.values())) == len(TREATMENTS), hashes


# ── the fact worth showing an analyst ────────────────────────────────────────
def test_woe_buys_the_same_fit_as_dummies_for_one_parameter(df):
    """Weight of evidence is CONSTRUCTED so a single coefficient reproduces the
    empirical bin log-odds. So k-1 free indicators should buy essentially nothing
    over one WoE column — which is exactly why WoE is the scorecard convention.

    Asserted with a likelihood-ratio test rather than by eyeballing the numbers.
    """
    woe_des = D.build(df, _spec("fico_orig", "woe"))
    bin_des = D.build(df, _spec("fico_orig", "bins"))
    woe_fit = F.fit(woe_des, _spec("fico_orig", "woe"))
    bin_fit = F.fit(bin_des, _spec("fico_orig", "bins"))

    dof = bin_des.X.shape[1] - woe_des.X.shape[1]
    assert dof > 0
    lr = 2 * (bin_fit.log_likelihood - woe_fit.log_likelihood)
    p = 1 - stats.chi2.cdf(max(lr, 0.0), dof)
    assert p > 0.10, (f"dummies improved the fit significantly (chi2={lr:.2f} on "
                      f"{dof} df, p={p:.4f}) — WoE is not reproducing the bin log-odds")


def test_continuous_keeps_information_that_binning_discards(df):
    """Same one parameter, better fit, because binning throws away within-bin
    variation. Worth showing rather than asserting that binning is free."""
    woe = F.fit(D.build(df, _spec("fico_orig", "woe")), _spec("fico_orig", "woe"))
    cont = F.fit(D.build(df, _spec("fico_orig", "continuous")),
                 _spec("fico_orig", "continuous"))
    assert cont.log_likelihood > woe.log_likelihood


# ── the collinearity traps ───────────────────────────────────────────────────
def test_explicit_months_on_book_suppresses_the_automatic_seasoning_spline(df):
    """Both would put two orthogonal bases of the SAME variable in the design.

    The ridge does not error on that — it silently halves every coefficient
    across the duplicated columns, which is far worse than failing.
    """
    spec = ModelSpec("consumer",
                     [VariableSpec("months_on_book", treatment="spline"),
                      VariableSpec("fico_orig")],
                     [MevSpec("unemployment_rate")], seasoning_spline=True)
    des = D.build(df, spec)
    assert not [c for c in des.columns if c.startswith("seasoning_")]
    assert [c for c in des.columns if c.startswith("months_on_book_")]


def test_vif_detects_a_rank_deficient_design():
    """A pseudo-inverse alone reports VIF 1.00 on exactly duplicated columns —
    the guardrail declaring perfect health on a singular design. The eigenspectrum
    is checked first so an exact dependence is reported as such."""
    rng = np.random.default_rng(0)
    n = 4000
    a = rng.normal(size=n)
    X = np.column_stack([np.ones(n), a, a.copy(), rng.normal(size=n)])
    y = (rng.random(n) < 0.05).astype(int)
    des = D.Design(X=X, columns=["intercept", "a", "a_copy", "noise"], y=y,
                   dates=np.zeros(n), accounts=np.arange(n), woe_maps={},
                   means=np.zeros(3), stds=np.ones(3))
    r = F.fit(des, ModelSpec("consumer"))
    vif = {c.name: c.vif for c in r.coefficients}
    assert np.isinf(vif["a"]) or np.isinf(vif["a_copy"]), vif
    assert r.separation_warning and "rank deficient" in r.separation_warning


def test_the_planted_collinear_pair_shows_a_high_vif(df):
    """fico_refreshed correlates above 0.95 with fico_orig by construction. Both
    should carry a loud variance inflation, and typically a sign flip with it."""
    spec = ModelSpec("consumer",
                     [VariableSpec("fico_orig", treatment="continuous"),
                      VariableSpec("fico_refreshed", treatment="continuous")], [])
    r = F.fit(D.build(df, spec), spec)
    vif = {c.name: c.vif for c in r.coefficients}
    assert vif["fico_orig"] > 10 and vif["fico_refreshed"] > 10, vif


# ── saved versions keep loading ──────────────────────────────────────────────
@pytest.mark.parametrize("legacy,expected", [
    ("woe", "woe"), ("raw", "continuous"), ("spline", "spline"),
])
def test_a_version_saved_before_the_split_still_loads(legacy, expected):
    """A saved specification that no longer loads would break the reproducibility
    claim outright, so the old field is migrated rather than rejected."""
    blob = {"portfolio": "consumer", "mevs": [], "sample": {},
            "variables": [{"column": "fico_orig", "transform": legacy}]}
    spec = ModelSpec.from_dict(blob)
    assert spec.variables[0].treatment == expected
