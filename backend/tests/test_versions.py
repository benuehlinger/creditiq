"""Version identity, round trip and comparison."""

from __future__ import annotations

import json

import pytest

from creditiq.models import service as modelsvc
from creditiq.models import versions as V
from creditiq.models.naming import friendly_name
from creditiq.models.spec import MevSpec, ModelSpec, VariableSpec


def _spec(cols, mevs=("unemployment_rate",)):
    return ModelSpec("consumer", [VariableSpec(c) for c in cols],
                     [MevSpec(m) for m in mevs])


def _metrics(r):
    d = r.diagnostics
    return {"auc_test": d["test"]["auc"], "auc_oot": d["oot"]["auc"],
            "ks_test": d["test"]["ks"], "gini_test": d["test"]["gini"],
            "coefficients": {c.name: c.estimate for c in r.fit.coefficients}}


# ── identity ─────────────────────────────────────────────────────────────────
def test_variable_order_does_not_change_identity():
    a = _spec(["fico_orig", "dti"])
    b = _spec(["dti", "fico_orig"])
    assert a.hash() == b.hash()
    assert friendly_name(a.hash()) == friendly_name(b.hash())


def test_a_different_specification_gets_a_different_hash():
    assert _spec(["fico_orig", "dti"]).hash() != _spec(["fico_orig"]).hash()


def test_the_name_is_derived_from_the_hash():
    """So an identical specification always produces an identical name, and an
    accidental duplicate is visible the moment it appears in the list."""
    s = _spec(["fico_orig", "dti"])
    assert friendly_name(s.hash()) == friendly_name(s.hash())


def test_spec_survives_a_json_round_trip():
    s = _spec(["fico_orig", "dti", "loan_purpose"], ("unemployment_rate", "cpi_inflation"))
    back = ModelSpec.from_dict(json.loads(json.dumps(s.to_dict())))
    assert back.hash() == s.hash()
    assert [v.column for v in back.variables] == [v.column for v in s.variables]
    assert [(m.key, m.lag_months) for m in back.mevs] == [(m.key, m.lag_months) for m in s.mevs]


# ── the reproducibility claim ────────────────────────────────────────────────
def test_export_then_fresh_import_reproduces_identical_metrics(tmp_path, monkeypatch):
    """The Definition-of-Done check. A configuration is portable: emailed, diffed
    in git, and re-run to the same numbers."""
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    spec = _spec(["fico_orig", "revolving_utilization", "dti"])
    saved = V.save(spec, _metrics(modelsvc.run(spec)))

    blob = json.loads(json.dumps(saved.to_dict()))       # as it would travel
    modelsvc.clear()                                     # nothing left in cache
    reimported = ModelSpec.from_dict(blob["spec"])
    assert reimported.hash() == saved.hash

    fresh = _metrics(modelsvc.run(reimported))
    for k in ("auc_test", "auc_oot", "ks_test", "gini_test"):
        assert fresh[k] == pytest.approx(saved.metrics[k], abs=1e-12), f"{k} drifted"
    for name, coef in saved.metrics["coefficients"].items():
        assert fresh["coefficients"][name] == pytest.approx(coef, abs=1e-10)


# ── comparison ───────────────────────────────────────────────────────────────
def test_compare_reports_the_variable_set_diff(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    a = _spec(["fico_orig", "dti"])
    b = _spec(["fico_orig", "dti", "prior_delinq_count"])
    va = V.save(a, _metrics(modelsvc.run(a)))
    vb = V.save(b, _metrics(modelsvc.run(b)))
    c = V.compare([va.hash, vb.hash])
    assert set(c["variables"]["shared"]) == {"fico_orig", "dti"}
    assert c["variables"]["added"][vb.hash] == ["prior_delinq_count"]
    assert c["variables"]["missing"][va.hash] == ["prior_delinq_count"]


def test_compare_flags_a_coefficient_sign_flip(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    a = _spec(["fico_orig"])
    va = V.save(a, {"coefficients": {"fico_orig_woe": 0.61}})
    vb = V.save(_spec(["fico_orig", "dti"]), {"coefficients": {"fico_orig_woe": -0.12}})
    c = V.compare([va.hash, vb.hash])
    flips = [r["variable"] for r in c["coefficients"] if r["sign_flip"]]
    assert "fico_orig" in flips


def test_compare_handles_four_versions(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    hs = [V.save(_spec(["fico_orig", "dti"][: 1 + i % 2] + [f"x{i}"]),
                 {"auc_test": 0.7 + i / 100}).hash for i in range(4)]
    c = V.compare(hs)
    assert len(c["versions"]) == 4


# ── lifecycle ────────────────────────────────────────────────────────────────
def test_exactly_one_champion_per_portfolio(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    a = V.save(_spec(["fico_orig"]), {})
    b = V.save(_spec(["fico_orig", "dti"]), {})
    V.promote(a.hash)
    assert V.champion("consumer").hash == a.hash
    V.promote(b.hash)
    assert V.champion("consumer").hash == b.hash
    assert V.load(a.hash).status == "challenger"


def test_renaming_never_breaks_a_reference(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    v = V.save(_spec(["fico_orig"]), {})
    V.update(v.hash, name="the one we showed the board")
    assert V.load(v.hash).name == "the one we showed the board"
    assert V.load(v.hash).hash == v.hash


def test_lineage_only_links_parents_that_exist(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    a = V.save(_spec(["fico_orig"]), {})
    V.save(_spec(["fico_orig", "dti"]), {}, parent_hash=a.hash)
    V.save(_spec(["dti"]), {}, parent_hash="deadbeefdeadbeef")   # dangling
    g = V.lineage("consumer")
    assert len(g["nodes"]) == 3
    assert len(g["edges"]) == 1, "a dangling parent must not produce an edge"


def test_a_malformed_file_does_not_break_the_list(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    V.save(_spec(["fico_orig"]), {})
    (tmp_path / "broken.json").write_text("{not json")
    assert len(V.list_all("consumer")) == 1


def test_a_version_records_the_data_it_was_fitted_on():
    """A specification reproduces exactly against a DIFFERENT panel and returns
    different coefficients, a different AUC and a different loss number while
    still calling itself the same model. Moving the panel open from 2015 to 2008
    left seven saved versions whose stored metrics described a dataset that no
    longer existed, and nothing on screen said so."""
    from creditiq.models import versions as V
    from creditiq.models.spec import LgdSpec, ModelSpec, VariableSpec
    spec = ModelSpec("cre", [VariableSpec("dscr_reported")],
                     lgd=LgdSpec("cre", drivers=("current_ltv",)))
    v = V.save(spec, {})
    try:
        assert v.data_fingerprint
        assert v.data_is_current()
    finally:
        V.delete(v.hash)


def test_a_version_from_a_superseded_panel_is_visible_as_one():
    from creditiq.models import versions as V
    from creditiq.models.spec import ModelSpec, VariableSpec
    v = V.save(ModelSpec("cre", [VariableSpec("dscr_reported")]), {})
    try:
        V.update(v.hash, data_fingerprint="deadbeefcafe")
        assert V.load(v.hash).data_is_current() is False
    finally:
        V.delete(v.hash)


def test_replacing_a_version_supersedes_it():
    """A hash is derived from the specification, so a changed specification
    cannot keep the old hash. Replacing transfers status, tags and the starred
    flag to the new version and removes the old file."""
    from creditiq.models import versions as V
    from creditiq.models.spec import LgdSpec, ModelSpec, VariableSpec
    a = V.save(ModelSpec("cre", [VariableSpec("dscr_reported")],
                         lgd=LgdSpec("cre", drivers=("current_ltv",))), {})
    V.update(a.hash, status="champion", starred=True, tags=["review"])
    b = V.save(ModelSpec("cre", [VariableSpec("dscr_reported"), VariableSpec("risk_rating")],
                         lgd=LgdSpec("cre", drivers=("current_ltv",))), {}, replaces=a.hash)
    try:
        assert b.hash != a.hash
        assert V.load(a.hash) is None, "the replaced version must be removed"
        assert b.status == "champion" and b.starred and b.tags == ["review"]
        assert b.replaced_hash == a.hash
    finally:
        V.delete(b.hash)


def test_a_child_of_a_replaced_version_is_repointed():
    """Otherwise superseding a node drops every branch that hung from it."""
    from creditiq.models import versions as V
    from creditiq.models.spec import LgdSpec, ModelSpec, VariableSpec
    root = V.save(ModelSpec("cre", [VariableSpec("dscr_reported")],
                            lgd=LgdSpec("cre", drivers=("current_ltv",))), {})
    child = V.save(ModelSpec("cre", [VariableSpec("risk_rating")],
                             lgd=LgdSpec("cre", drivers=("current_ltv",))), {},
                   parent_hash=root.hash)
    new = V.save(ModelSpec("cre", [VariableSpec("dscr_reported"), VariableSpec("utilisation")],
                           lgd=LgdSpec("cre", drivers=("current_ltv",))), {},
                 replaces=root.hash)
    try:
        assert V.load(child.hash).parent_hash == new.hash
    finally:
        for h in (child.hash, new.hash):
            V.delete(h)


def test_saving_without_replaces_keeps_both():
    from creditiq.models import versions as V
    from creditiq.models.spec import LgdSpec, ModelSpec, VariableSpec
    a = V.save(ModelSpec("cre", [VariableSpec("dscr_reported")],
                         lgd=LgdSpec("cre", drivers=("current_ltv",))), {})
    b = V.save(ModelSpec("cre", [VariableSpec("risk_rating")],
                         lgd=LgdSpec("cre", drivers=("current_ltv",))), {},
               parent_hash=a.hash)
    try:
        assert V.load(a.hash) is not None
        assert V.load(b.hash).parent_hash == a.hash
    finally:
        for h in (a.hash, b.hash):
            V.delete(h)


# ── the roll-up reports on a selectable model set ────────────────────────────
def test_the_rollup_defaults_to_the_adopted_models():
    from creditiq.models import rollup as R
    r = R.run(with_tornado=False)
    assert r.is_adopted
    assert all(p["source"] in ("champion", "default") for p in r.portfolios)


def test_selecting_a_different_version_marks_the_result_as_not_adopted():
    """The roll-up is the executive number. A figure produced by a hand-picked
    combination of versions is a different object from the one produced by the
    adopted models, and swapping one book here moves the total by 19%."""
    from creditiq.models import rollup as R
    base = R.run(with_tornado=False)
    options = base.available["cre"]
    alt = next((v["hash"] for v in options
                if v["hash"] != base.portfolios[-1]["version_hash"]), None)
    if alt is None:
        pytest.skip("only one saved version on this book")
    r = R.run(with_tornado=False, selection={"cre": alt})
    assert r.is_adopted is False
    cre = next(p for p in r.portfolios if p["portfolio"] == "cre")
    assert cre["source"] == "selected"
    assert cre["version_hash"] == alt


def test_an_unknown_or_mismatched_version_falls_back_rather_than_failing():
    """A stale link should not produce a number attributed to a model that is not
    there. It falls back to the champion and reports that source."""
    from creditiq.models import rollup as R
    _, source, _ = R.spec_for("cre", "0000000000000000")
    assert source in ("champion", "default")
    # a version belonging to another book is not accepted for this one
    mortgage = [v for v in __import__(
        "creditiq.models.versions", fromlist=["x"]).list_all("mortgage")]
    if mortgage:
        _, src2, _ = R.spec_for("cre", mortgage[0].hash)
        assert src2 in ("champion", "default")


def test_a_saved_version_measures_the_severity_model_too():
    """A version records the PD statistics AND the LGD statistics.

    Half the loss number comes from severity. A record that measured only
    discrimination on PD described half of what produced the figure.
    """
    from creditiq.api import main as api_main
    from creditiq.models import rollup as R

    spec, _, _ = R.spec_for("mortgage")
    m = api_main._lgd_metrics_for(spec)
    assert m["lgd_basis"] == "out of time"
    assert m["lgd_n"] > 0
    # Bias is the signed gap between the two means it is derived from.
    assert m["lgd_bias"] == pytest.approx(
        m["lgd_mean_predicted"] - m["lgd_mean_actual"], abs=1e-12)
    assert 0.0 < m["lgd_rmse"] < 1.0


def test_in_sample_severity_bias_is_identically_zero():
    """Why the stored figure must be out of time.

    A fractional logit carrying an intercept reproduces the mean of the fitting
    sample exactly, so in sample every specification reports no bias at all. An
    in-sample figure would say the model is perfectly calibrated regardless of
    whether it is.
    """
    from creditiq.api import main as api_main
    from creditiq.models import lgd as LGD, lgd_diag as LD, rollup as R
    from creditiq.mev import panel as mevpanel

    spec, _, _ = R.spec_for("mortgage")
    d = api_main._lgd_frame("mortgage")
    m = LGD.fit_lgd(d.assign(default_flag=1), spec.lgd, mevpanel.monthly_panel())
    diag = LD.diagnostics(m, d)
    assert diag["mean_predicted"] == pytest.approx(diag["mean_actual"], abs=1e-6)


def test_bias_compares_on_distance_from_zero():
    """`zero` is a third comparison direction.

    For a bias neither the largest nor the smallest signed value is the good
    one — the good one is nearest nothing.
    """
    keys = {k: good for k, _, good in _metric_keys()}
    assert keys["lgd_bias"] == "zero"
    assert keys["lgd_rmse"] == "down"
    assert keys["auc_test"] == "up"


def _metric_keys():
    """The compare table's metric list, read from the source of truth."""
    import inspect
    import creditiq.models.versions as V
    src = inspect.getsource(V.compare)
    start = src.index("metric_keys = [")
    end = src.index("]", start)
    return eval(src[start + len("metric_keys = "):end + 1])   # noqa: S307


def test_the_pd_half_has_its_own_identity_and_ignores_lgd():
    """`pd_hash` covers the PD specification only."""
    import dataclasses

    from creditiq.models.spec import LgdSpec, ModelSpec, VariableSpec

    # Built here rather than read from `rollup.spec_for`, which returns whichever
    # version is PROMOTED. With a champion carrying one LGD driver, the change
    # below was a no-op and the assertion failed for an unrelated reason.
    spec = ModelSpec(
        portfolio="mortgage",
        variables=[VariableSpec("fico_orig"), VariableSpec("current_ltv")],
        lgd=LgdSpec(portfolio="mortgage", drivers=("current_ltv", "hpi_yoy")),
    )
    before, pair_before = spec.pd_hash(), spec.hash()
    spec.lgd = dataclasses.replace(spec.lgd, drivers=spec.lgd.drivers[:1])
    assert spec.pd_hash() == before, "the PD identity moved when only LGD changed"
    assert spec.hash() != pair_before, "the PAIR identity must move when either half does"


def test_changing_pd_leaves_the_severity_model_untouched():
    """Why iterating PD against a settled LGD costs nothing.

    Severity is fitted on resolved defaults and never sees the PD
    specification. Swapping the PD side out must leave the LGD model identical —
    same specification hash, same coefficients, same calibration. This is what
    makes "open a version, change PD, save as new" a cheap operation rather than
    a re-approval of the severity model.
    """
    import copy

    from creditiq.api import main as api_main
    from creditiq.models import rollup as R

    spec, _, _ = R.spec_for("mortgage")
    alt = copy.deepcopy(spec)
    alt.variables = alt.variables[:1]
    alt.mevs = []

    assert alt.lgd.hash() == spec.lgd.hash()
    a, b = api_main._lgd_metrics_for(alt), api_main._lgd_metrics_for(spec)
    # `pd_hash` is the one key that SHOULD move; every severity figure must not.
    assert a.pop("pd_hash") != b.pop("pd_hash")
    assert a == b, "the severity model moved when only the PD side changed"
    assert alt.hash() != spec.hash(), "a new pairing must get a new Model ID"
