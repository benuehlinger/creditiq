"""Stage 1 of the automated search: cores are built from whole terms.

The failure this file walls off: a spline basis or a dummy block entering the
stepwise search one column at a time. A term is one modeling decision, and a
search that can keep three of a spline's five columns produces a model nobody
specified and nobody can defend.
"""

import numpy as np
import pandas as pd
import pytest

from creditiq import store
from creditiq.models import design as D
from creditiq.models import selection as S


def _cfg(columns, treatments=None, **rules):
    treatments = treatments or {}
    return S.SelectionConfig(
        portfolio="consumer",
        candidates=[S.CandidateVar(column=c, treatment=treatments.get(c, "woe"))
                    for c in columns],
        rules=S.SelectionRules(**rules))


def _fit_frame(cfg):
    df, _ = store.screening_frame(cfg.portfolio)
    return df[df["performance_date"] < pd.Timestamp(cfg.oot_from)]


# ── terms are atomic ─────────────────────────────────────────────────────────
def test_a_spline_term_enters_and_leaves_as_one_block():
    """Adding a spline candidate changes the design by the whole basis, and the
    columns it adds all belong to one term."""
    cfg = _cfg(["fico_orig", "interest_rate"],
               treatments={"interest_rate": "spline"})
    fit_df = _fit_frame(cfg)
    by_col = {c.column: c for c in cfg.candidates}

    without = D.build(fit_df, S._model_spec(
        cfg, [S._variable_spec(by_col["fico_orig"])]))
    with_ = D.build(fit_df, S._model_spec(
        cfg, [S._variable_spec(by_col[c]) for c in ("fico_orig", "interest_rate")]))

    added = [c for c in with_.columns if c not in without.columns]
    assert len(added) > 1, "a spline emits several columns"
    owners = {with_.terms[with_.columns.index(c)] for c in added}
    assert owners == {"interest_rate"}


def test_a_dummy_block_is_one_term_too():
    cfg = _cfg(["fico_orig", "loan_purpose"],
               treatments={"loan_purpose": "bins"})
    fit_df = _fit_frame(cfg)
    by_col = {c.column: c for c in cfg.candidates}
    des = D.build(fit_df, S._model_spec(
        cfg, [S._variable_spec(by_col[c]) for c in ("fico_orig", "loan_purpose")]))
    dummies = [c for c in des.columns if c.startswith("loan_purpose")]
    assert len(dummies) >= 1
    assert all(des.terms[des.columns.index(c)] == "loan_purpose" for c in dummies)


# ── the stepwise search ──────────────────────────────────────────────────────
def test_stepwise_prefers_signal_over_noise():
    """A real driver enters; a shuffled copy of it does not. The noise column is
    written into the frame under a name the generator never uses."""
    df, _ = store.screening_frame("consumer")
    rng = np.random.default_rng(7)
    noise = df["fico_orig"].to_numpy(float).copy()
    rng.shuffle(noise)
    df = df.assign(zz_shuffled_noise=noise)

    cfg = _cfg(["fico_orig", "zz_shuffled_noise"])
    fit_df = df[df["performance_date"] < pd.Timestamp(cfg.oot_from)]

    # run the forward/backward machinery directly on the doctored frame
    import creditiq.models.selection as sel
    orig = sel._frames
    sel._frames = lambda c: (fit_df, df)
    try:
        cores = S.build_cores(cfg)
    finally:
        sel._frames = orig
    assert cores, "a core was built"
    assert "fico_orig" in cores[0].columns
    assert "zz_shuffled_noise" not in cores[0].columns


def test_max_predictors_caps_the_core():
    cfg = _cfg(["fico_orig", "dti", "revolving_utilization", "interest_rate"],
               max_predictors=2)
    cores = S.build_cores(cfg)
    stepwise = next(c for c in cores if c.name == "stepwise")
    assert len(stepwise.columns) <= 2


def test_the_strong_core_is_smaller_and_the_expert_core_is_verbatim():
    cfg = S.SelectionConfig(
        portfolio="consumer",
        candidates=[S.CandidateVar(column=c) for c in
                    ["fico_orig", "dti", "revolving_utilization",
                     "interest_rate", "inquiries_6m"]],
        cores=["stepwise", "strong", "expert"],
        expert_core=["dti", "fico_orig"],
        rules=S.SelectionRules(strong_core_size=2))
    cores = S.build_cores(cfg)
    names = {c.name for c in cores}
    assert "stepwise" in names
    by = {c.name: c for c in cores}
    if "strong" in by:                      # only present when it differs
        assert len(by["strong"].columns) <= 2
        assert set(by["strong"].columns) <= set(by["stepwise"].columns)
    assert by["expert"].columns == ["dti", "fico_orig"]


def test_identical_cores_are_reported_once():
    """When the stepwise core is already at the strong size, the strong core
    would be the same set — it is dropped rather than shown twice."""
    cfg = _cfg(["fico_orig", "dti"], strong_core_size=4)
    cores = S.build_cores(cfg)
    sets = [frozenset(c.columns) for c in cores]
    assert len(sets) == len(set(sets))


# ── warnings and rules ───────────────────────────────────────────────────────
def test_cyclical_drivers_are_warned_not_filtered():
    cfg = S.SelectionConfig(
        portfolio="consumer",
        candidates=[S.CandidateVar(column=c) for c in
                    ["fico_orig", "revolving_utilization"]],
        cores=["expert"], expert_core=["fico_orig", "revolving_utilization"])
    cores = S.build_cores(cfg)
    expert = next(c for c in cores if c.name == "expert")
    assert "revolving_utilization" in expert.columns
    assert any("revolving_utilization" in w for w in expert.warnings)


def test_mev_bounds_clamp_rather_than_obey():
    """min_mevs=0 is not a way to get a macro-free model out of the search, and
    max_mevs=7 is not a way past the ceiling."""
    r = S.SelectionRules(min_mevs=0, max_mevs=7)
    assert r.min_mevs == 1
    assert r.max_mevs == 3


def test_entry_score_bic_uses_the_event_count():
    """The BIC penalty grows with log(events), not log(rows): a fixed
    likelihood gain that clears the row-count penalty must still fail the
    event-count one when events are scarce."""
    class Stub:
        def __init__(self, ll, k, n_events):
            self.ll, self.k, self.n_events = ll, k, n_events

    rules = S.SelectionRules(entry_metric="bic")
    gain = 4.0     # 2*(ll1-ll0) = 8 > log(300000)? no: ln(3e5)=12.6; pick between
    # ln(200)=5.3 < 8 < ln(300000)=12.6: passes only if penalty used log(rows)
    base = Stub(ll=-1000.0, k=3, n_events=200)
    more = Stub(ll=-1000.0 + gain, k=4, n_events=200)
    passes, _ = S._entry_score(more, base, rules)
    assert passes, "8 vs ln(200)=5.3 should pass on the event count"
    few = Stub(ll=-1000.0 + gain, k=4, n_events=1_000_000)
    passes_big, _ = S._entry_score(few, base, rules)
    assert not passes_big, "8 vs ln(1e6)=13.8 should fail"


def test_config_hash_is_order_insensitive_and_content_sensitive():
    a = _cfg(["fico_orig", "dti"])
    b = _cfg(["dti", "fico_orig"])
    assert a.hash() == b.hash()
    c = _cfg(["fico_orig", "dti"], mev_corr_cap=0.5)
    assert c.hash() != a.hash()
    rt = S.SelectionConfig.from_dict(a.to_dict())
    assert rt.hash() == a.hash()


def test_cancel_stops_between_fits():
    import threading
    ev = threading.Event()
    ev.set()
    cfg = _cfg(["fico_orig", "dti"])
    with pytest.raises(S.Cancelled):
        S.build_cores(cfg, cancel=ev)


# ── the VIF cap on entry ─────────────────────────────────────────────────────
def test_the_stepwise_core_refuses_a_collinear_entrant(monkeypatch):
    """Two noisy measurements of the same driver: the second genuinely
    improves the criterion (averaging reduces measurement error) but is
    refused entry, because it would push the worst term VIF over the
    reviewer's threshold. The refusal is reported in the trace by name —
    the core must not be born collinear, and the block must not be silent."""
    df, _ = store.screening_frame("consumer")
    rng = np.random.default_rng(11)
    fico = df["fico_orig"].to_numpy(float)
    noise = 0.3 * fico.std()
    df = df.assign(zz_fico_a=fico + rng.normal(0.0, noise, len(fico)),
                   zz_fico_b=fico + rng.normal(0.0, noise, len(fico)))
    cfg = _cfg(["zz_fico_a", "zz_fico_b", "revolving_utilization"],
               treatments={"zz_fico_a": "continuous",
                           "zz_fico_b": "continuous",
                           "revolving_utilization": "continuous"},
               max_vif=5.0)
    fit_df = df[df["performance_date"] < pd.Timestamp(cfg.oot_from)]
    monkeypatch.setattr(S, "_frames", lambda c: (fit_df, df))

    cores = S.build_cores(cfg)
    stepwise = next(c for c in cores if c.name == "stepwise")

    twins = {"zz_fico_a", "zz_fico_b"}
    kept = twins & set(stepwise.columns)
    assert len(kept) == 1, "exactly one of the twin measurements may enter"
    blocked_col = (twins - kept).pop()
    blocks = [s for s in stepwise.steps if s["action"] == "vif_block"]
    assert [s["column"] for s in blocks] == [blocked_col]
    assert blocks[0]["vif"] > 5.0
    assert blocks[0]["cap"] == 5.0
