"""Variance inflation, on the design the model actually contains."""

from __future__ import annotations

import numpy as np
import pytest

from creditiq import store
from creditiq.analysis import screening as S
from creditiq.models import design as D
from creditiq.models.fit import generalised_vif
from creditiq.models.spec import MevSpec, ModelSpec, VariableSpec

COLS = ["fico_orig", "revolving_utilization", "interest_rate"]


def _term_vif(treatments: tuple[str, str, str]) -> dict[str, dict]:
    df, _ = store.screening_frame("consumer")
    spec = ModelSpec("consumer",
                     [VariableSpec(c, treatment=t) for c, t in zip(COLS, treatments)])
    des = D.build(df, spec)
    groups = {t: c for t, c in des.term_groups().items() if t != "seasoning"}
    return {r["term"]: r for r in generalised_vif(np.asarray(des.X, float), groups)}


def test_every_design_column_belongs_to_exactly_one_term():
    """The mapping is recorded at build time. Recovering it by parsing column
    names would break on the first treatment that changes its naming."""
    df, _ = store.screening_frame("consumer")
    spec = ModelSpec("consumer",
                     [VariableSpec("fico_orig", treatment="spline"),
                      VariableSpec("revolving_utilization", treatment="bins")],
                     mevs=[MevSpec("unemployment_rate"),
                           MevSpec("prime_rate", transform="yoy", lag_months=6)])
    des = D.build(df, spec)
    assert len(des.terms) == len(des.columns)
    assert des.terms[0] is None, "the intercept belongs to no term"
    groups = des.term_groups()
    assert sum(len(c) for c in groups.values()) == len(des.columns) - 1
    assert groups["fico_orig"] and groups["revolving_utilization"]
    assert len(groups["mev:unemployment_rate"]) == 1
    assert len(groups["seasoning"]) > 1


def test_the_treatment_changes_the_variance_inflation():
    """The screening panel used to compute this on the RAW tape columns, so the
    same variable reported the same inflation whether it entered as a spline, as
    bin indicators or as a continuous term. Those are three different designs."""
    cont = _term_vif(("spline", "bins", "continuous"))
    bins = _term_vif(("spline", "bins", "bins"))
    woe = _term_vif(("woe", "woe", "woe"))
    rates = {cont["interest_rate"]["vif"], bins["interest_rate"]["vif"],
             woe["interest_rate"]["vif"]}
    assert len(rates) == 3, "the number must respond to how the variable enters"
    # binning discards within-bin variation, so the binned pair is less collinear
    assert bins["interest_rate"]["vif"] < cont["interest_rate"]["vif"]


def test_the_raw_tape_number_was_wrong_for_a_binned_term():
    """fico_orig and interest_rate correlate at -0.976 on this book, because the
    generator prices the loan off the score. The raw-column number is near 21 for
    both. That is the right answer only when both enter as single raw columns."""
    df, _ = store.screening_frame("consumer")
    raw = {r["column"]: r["vif"] for r in S.vif(df, COLS)}
    assert raw["interest_rate"] > 15

    binned = _term_vif(("spline", "bins", "bins"))["interest_rate"]
    assert binned["df"] > 1
    assert binned["vif"] < raw["interest_rate"] / 2


def test_a_one_column_term_returns_the_ordinary_vif():
    """The generalised form has to reduce to the familiar one, or the two numbers
    in the app would be on different scales."""
    woe = _term_vif(("woe", "woe", "woe"))
    for r in woe.values():
        assert r["df"] == 1
        assert r["gvif"] == pytest.approx(r["vif"], rel=1e-9)


def test_an_aliased_term_is_reported_rather_than_returning_a_finite_number():
    """An exact linear combination gives a singular correlation block. Returning
    a large-but-finite number there reads as a severe warning; it is a structural
    defect in the specification."""
    rng = np.random.default_rng(0)
    a = rng.normal(size=(4000, 2))
    X = np.column_stack([np.ones(4000), a, a[:, 0] * 2.0 + a[:, 1]])
    out = {r["term"]: r for r in
           generalised_vif(X, {"a": [1], "b": [2], "dup": [3]})}
    assert any(r["aliased"] for r in out.values())


def test_binned_terms_drop_a_reference_level():
    """k bins produce k-1 indicators. With an intercept present, keeping all k
    would make the design singular. Missing is NOT the reference: an account with
    no value recorded is not the same as one in the lowest bin."""
    df, _ = store.screening_frame("consumer")
    spec = ModelSpec("consumer",
                     [VariableSpec("revolving_utilization", treatment="bins")])
    des = D.build(df, spec)
    cols = [des.columns[i] for i in des.term_groups()["revolving_utilization"]]
    from creditiq.analysis.binning import bin_numeric
    b = bin_numeric(df["revolving_utilization"], df["default_flag"])
    n_real = len([z for z in b.bins if not z.is_special])
    assert len([c for c in cols if not c.endswith("=Missing")]) == n_real - 1
    assert any(c.endswith("=Missing") for c in cols), "missing gets its own indicator"
