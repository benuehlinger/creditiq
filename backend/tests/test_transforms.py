"""How a variable enters the model: discretizer and encoder as separate choices."""

from __future__ import annotations

import numpy as np
import pytest
from scipy import stats

from creditiq import store
from creditiq.models import design as D
from creditiq.models import fit as F
from creditiq.models.spec import TREATMENTS, MevSpec, ModelSpec, VariableSpec


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


# ── the leakage guard ────────────────────────────────────────────────────────
def test_a_transform_fitted_on_the_full_panel_never_leaks_into_a_train_fit(df):
    """The binning must be fitted on the training slice alone.

    A cache keyed only on the column and its edges will hand a map fitted on the
    FULL panel back to a fit that should never have seen the test rows. The
    symptom is quiet — the same specification returns a slightly better AUC
    depending on what ran before it — which is how the original bug was found:
    0.78998 with the leak against 0.78950 without.
    """
    spec = _spec("fico_orig", "woe", extra=())
    full = D.build(df, spec)
    half = df.iloc[: len(df) // 2]
    train = D.build(half, spec)

    a = full.woe_maps["fico_orig"]
    b = train.woe_maps["fico_orig"]
    assert a["edges"] != b["edges"] or a["woe"] != b["woe"], (
        "the training design reused the full-panel binning — the cache is not "
        "keyed on which rows the transform was fitted on")


def test_the_same_slice_still_reuses_its_cached_transform(df):
    """The guard must not defeat the cache it is guarding, or every refit pays
    for optimal binning again."""
    spec = _spec("fico_orig", "woe", extra=())
    first = D.build(df, spec)
    second = D.build(df, spec)
    assert first.woe_maps["fico_orig"]["edges"] == second.woe_maps["fico_orig"]["edges"]


# ── spline knots ─────────────────────────────────────────────────────────────
def test_knots_come_from_the_variables_own_quantiles(df):
    """The original bug: the spline treatment reused the SEASONING knots — 3, 6,
    12 ... 144 months — for every variable. On FICO, which runs 540 to 830, every
    one sits below the minimum, so each hinge reduces to an affine copy of the
    variable. The hinge matrix had rank 2 and the basis emitted nine columns,
    seven of them floating-point residue, which the model then fitted."""
    from creditiq.models.design import SEASONING_KNOTS, _spline_basis, quantile_knots

    fico = df["fico_orig"].to_numpy(float)
    ks = quantile_knots(fico, 4)
    assert len(ks) == 4
    assert all(fico.min() < k < fico.max() for k in ks), ks

    good, _, _ = _spline_basis(fico, ks)
    assert np.linalg.matrix_rank(good) == good.shape[1], "quantile basis is deficient"

    # the old behaviour must now collapse rather than emit noise
    bad, _, _ = _spline_basis(fico, SEASONING_KNOTS)
    assert bad.shape[1] == np.linalg.matrix_rank(bad)
    assert bad.shape[1] <= 2, f"{bad.shape[1]} columns from a rank-2 hinge matrix"


def test_knot_count_controls_the_column_count(df):
    from creditiq.models.design import _spline_basis, quantile_knots
    fico = df["fico_orig"].to_numpy(float)
    for n in (2, 4, 6):
        B, _, _ = _spline_basis(fico, quantile_knots(fico, n))
        assert B.shape[1] == n + 1, f"{n} knots gave {B.shape[1]} columns"


def test_the_seasoning_knots_still_suit_months_on_book(df):
    """They were designed for it, and there they are full rank."""
    from creditiq.models.design import SEASONING_KNOTS, _spline_basis
    mob = df["months_on_book"].to_numpy(float)
    B, _, _ = _spline_basis(mob, SEASONING_KNOTS)
    assert B.shape[1] >= 6 and np.linalg.matrix_rank(B) == B.shape[1]


# ── the shape diagnostic ─────────────────────────────────────────────────────
def test_bin_edges_are_none_not_nan_at_the_boundaries(df):
    """A DataFrame round trip turns None into NaN in a float column, so an
    unbounded edge came back as nan and `is not None` was True for it."""
    from creditiq.analysis.binning import bin_numeric
    b = bin_numeric(df["fico_orig"], df["default_flag"])
    real = [x for x in b.bins if not x.is_special]
    assert real[0].lo is None and real[-1].hi is None


def test_shape_diagnostic_recommends_continuous_for_a_linear_relationship(df):
    from creditiq.analysis.binning import bin_numeric, shape_diagnostic
    d = shape_diagnostic(bin_numeric(df["fico_orig"], df["default_flag"]))
    assert d["recommendation"] == "continuous"
    assert d["linear_r2"] > 0.95
    assert d["reason"]


def test_shape_diagnostic_recommends_a_flexible_form_for_a_hump():
    """A seasoning curve reverses direction, so neither a straight line nor a
    single weight can carry it."""
    from creditiq.analysis.binning import bin_numeric, shape_diagnostic
    rng = np.random.default_rng(5)
    n = 200_000
    age = rng.integers(1, 120, n).astype(float)
    hump = np.exp(-((np.log(age) - np.log(30)) ** 2) / 0.6)
    y = (rng.random(n) < 0.002 + 0.03 * hump).astype(int)
    import pandas as pd
    d = shape_diagnostic(bin_numeric(pd.Series(age, name="age"), pd.Series(y)))
    assert d["recommendation"] in ("spline", "bins"), d
    assert not d["monotone"]


def test_every_recommendation_carries_a_reason(df):
    """It is a suggestion shown to a human, so it has to say why."""
    from creditiq.analysis.binning import bin_numeric, shape_diagnostic
    for col in ("fico_orig", "dti", "months_on_book", "annual_income"):
        d = shape_diagnostic(bin_numeric(df[col], df["default_flag"]))
        assert d["reason"] and len(d["reason"]) > 40
        assert d["recommendation"] in ("woe", "bins", "continuous", "spline")
