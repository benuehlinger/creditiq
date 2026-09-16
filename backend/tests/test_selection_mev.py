"""Stage 2 of the automated search: the macro rules are load-bearing.

Every model the search emits must be stressable (at least one macro term) and
defensible (at most three, one variant per underlying series, no near-duplicate
pair). These are product rules, not tuning choices, so each one gets a wall.
"""

import numpy as np
import pandas as pd
import pytest

from creditiq.models import selection as S
from creditiq.models.spec import MevSpec


def _cfg(**kw):
    rules = S.SelectionRules(**kw.pop("rules", {}))
    return S.SelectionConfig(
        portfolio="consumer",
        candidates=[S.CandidateVar(column=c) for c in ("fico_orig", "dti")],
        rules=rules, **kw)


TERMS = ["unemployment_rate@yoy@0", "unemployment_rate@diff@3",
         "real_gdp_growth@yoy@0", "real_disp_income_growth@yoy@3"]


def _mev(key="unemployment_rate", transform="yoy", lag=0):
    return MevSpec(key=key, transform=transform, lag_months=lag)


# ── combination constraints ──────────────────────────────────────────────────
def test_never_two_variants_of_one_family():
    a = _mev(transform="yoy", lag=0)
    b = _mev(transform="diff", lag=3)
    assert not S._combo_allowed((a, b), {}, cap=0.7)


def test_never_the_same_mev_at_two_lags():
    a = _mev(transform="yoy", lag=0)
    b = _mev(transform="yoy", lag=6)
    assert not S._combo_allowed((a, b), {}, cap=0.7)


def test_correlated_pairs_are_skipped_and_the_cap_is_respected():
    a = _mev("unemployment_rate", "yoy", 0)
    b = _mev("real_gdp_growth", "yoy", 0)
    ka = (a.key, a.transform, a.lag_months)
    kb = (b.key, b.transform, b.lag_months)
    assert not S._combo_allowed((a, b), {(ka, kb): -0.85}, cap=0.7)
    assert S._combo_allowed((a, b), {(ka, kb): -0.55}, cap=0.7)
    # the lookup is order-insensitive
    assert not S._combo_allowed((a, b), {(kb, ka): 0.9}, cap=0.7)


def test_enumeration_counts_and_the_one_mev_floor():
    """Three independent families with no correlation: C(3,1)+C(3,2)+C(3,3)=7
    combinations, and none of size zero."""
    ms = [_mev("unemployment_rate"), _mev("real_gdp_growth"),
          _mev("bbb_yield")]
    cfg = _cfg()
    survivors = {"stepwise": ms}

    # bypass the series build: pretend uncorrelated
    orig = S._variant_correlations
    S._variant_correlations = lambda variants, lo, hi: {}
    try:
        combos = S.enumerate_combos(cfg, survivors)
    finally:
        S._variant_correlations = orig
    got = combos["stepwise"]
    assert len(got) == 7
    assert all(1 <= len(c) <= 3 for c in got)


def test_max_mevs_is_a_hard_ceiling():
    ms = [_mev(k) for k in ("unemployment_rate", "real_gdp_growth",
                            "bbb_yield", "hpi")]
    cfg = _cfg(rules={"min_mevs": 2, "max_mevs": 3})
    orig = S._variant_correlations
    S._variant_correlations = lambda variants, lo, hi: {}
    try:
        combos = S.enumerate_combos(cfg, {"stepwise": ms})
    finally:
        S._variant_correlations = orig
    sizes = {len(c) for c in combos["stepwise"]}
    assert sizes == {2, 3}


# ── the term list comes from the Macro surface ───────────────────────────────
def test_terms_parse_and_deduplicate():
    """The search takes `key@transform@lag` verbatim, deduplicated; it never
    sweeps the transformation library on its own."""
    cfg = _cfg(mev_terms=["unemployment_rate@yoy@0", "unemployment_rate@yoy@0",
                          "real_gdp_growth", "bbb_yield@diff@6"])
    variants = S.mev_variants(cfg)
    assert len(variants) == 3
    plain = next(m for m in variants if m.key == "real_gdp_growth")
    assert plain.transform == "level" and plain.lag_months == 0
    lagged = next(m for m in variants if m.key == "bbb_yield")
    assert lagged.transform == "diff" and lagged.lag_months == 6


def test_a_base_and_its_derived_form_are_one_family():
    assert S.mev_family("hpi_yoy") == "hpi"
    assert S.mev_family("cre_price_index_yoy") == "cre_price_index"
    assert S.mev_family("real_gdp_growth") == "real_gdp"
    a = MevSpec(key="hpi", transform="level", lag_months=0)
    b = MevSpec(key="hpi_yoy", transform="level", lag_months=0)
    assert not S._combo_allowed((a, b), {}, cap=0.7)


def test_screen_keeps_only_right_sign_and_loose_p_and_reports_removals():
    """Survivors fit the economic prior at the loose cutoff, and anything
    removed from the hand-picked list is reported with a reason, never
    dropped silently."""
    cfg = _cfg(mev_terms=TERMS)
    cores = S.build_cores(cfg)
    survivors, screened_out = S.screen_mevs(cfg, cores[:1], progress=None)
    kept = survivors[cores[0].name]
    assert kept, "at least one shortlisted term survives on this book"
    assert len(kept) + len(screened_out) == len(S.mev_variants(cfg))
    assert all(o["reason"] for o in screened_out)
    fit_df, _ = S._frames(cfg)
    prior = S._sign_prior(cfg.portfolio)
    for m in kept:
        lean = S._lean_fit(fit_df, S._model_spec(cfg, cores[0].variables, (m,)))
        coef = next(c for c in lean.fit.coefficients
                    if c.name == f"mev:{m.label()}")
        expected = prior(m.key)
        if expected is not None:
            assert (1 if coef.estimate > 0 else -1) == expected
        assert coef.p_value < cfg.rules.mev_screen_p


# ── joint rows ───────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def small_run():
    """One tiny end-to-end pass on the consumer book, shared by the row tests."""
    cfg = _cfg(mev_terms=TERMS)
    cores = S.build_cores(cfg)
    survivors, _ = S.screen_mevs(cfg, cores)
    combos = S.enumerate_combos(cfg, survivors)
    rows = S.joint_fit_rows(cfg, cores, combos)
    return cfg, cores, rows


def test_every_row_has_one_to_three_mevs(small_run):
    _, _, rows = small_run
    assert rows
    assert all(1 <= r["n_mevs"] <= 3 for r in rows)
    assert all(r["mevs"] for r in rows)


def test_rows_are_unique_by_hash_and_carry_lineage(small_run):
    _, _, rows = small_run
    hashes = [r["hash"] for r in rows]
    assert len(hashes) == len(set(hashes))
    assert all(r["lineage"] and r["lineage"][0]["method"] for r in rows)


def test_row_metrics_are_present_and_sane(small_run):
    _, _, rows = small_run
    for r in rows:
        assert 0.5 < r["auc_in"] < 1.0
        assert r["max_p"] is not None
        assert r["spec"]["mevs"], "the spec itself carries the macro terms"


def test_identical_variable_sets_from_two_cores_merge():
    """Two cores with the same variables (different names) plus the same combo
    produce one row with both lineages."""
    cfg = _cfg(mev_terms=TERMS[:2])
    cores = S.build_cores(cfg)
    core = cores[0]
    twin = S.Core(name="expert", columns=core.columns, variables=core.variables,
                  warnings=[], lean=core.lean, coefficients=core.coefficients,
                  steps=[])
    m = S.screen_mevs(cfg, [core])[0][core.name][:1]
    assert m
    combos = {core.name: [tuple(m)], "expert": [tuple(m)]}
    rows = S.joint_fit_rows(cfg, [core, twin], combos)
    assert len(rows) == 1
    assert {ln["core"] for ln in rows[0]["lineage"]} == {core.name, "expert"}


def test_core_shift_flags_a_constructed_flip():
    core = S.Core(name="stepwise", columns=["x"], variables=[], warnings=[],
                  lean=None, coefficients={"x_woe": 0.8}, steps=[])

    class FakeCoef:
        def __init__(self, name, est):
            self.name, self.estimate = name, est

    class FakeLean:
        class fit:                                     # noqa: N801
            coefficients = [FakeCoef("x_woe", -0.5)]

    flags = S._core_shift(core, FakeLean, pct=30.0)
    assert flags and flags[0]["flipped"]

    class FakeLeanSmall:
        class fit:                                     # noqa: N801
            coefficients = [FakeCoef("x_woe", 0.75)]

    assert S._core_shift(core, FakeLeanSmall, pct=30.0) == []


def test_combo_bound_counts_family_constrained_subsets():
    """Four terms in three families: singles 4, pairs across families
    2x1 + 2x1 + 1x1 = 5, triples 2x1x1 = 2, so 11 in all."""
    cfg = _cfg(mev_terms=TERMS)
    assert S.combo_bound(cfg) == 11
