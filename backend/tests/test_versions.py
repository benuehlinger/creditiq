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
