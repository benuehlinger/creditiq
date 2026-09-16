"""The review record: two rankings side by side, and an audit that says why.

The rules under test are the ones a model-validation reader will check first:
a rejection without a justification does not save, a re-rank away from the
automated order without a justification does not save, and every change that
did save is in the audit with who, when, before and after.
"""

import time

import pytest
from fastapi.testclient import TestClient

import creditiq.api.main as api_main
from creditiq.api.main import app
from creditiq.models import runcache
from creditiq.models import selection as sel
from creditiq.models import selection_store as selstore

client = TestClient(app)

CFG = {"candidates": [{"column": "fico_orig"}],
       "mev_families": ["unemployment_rate"]}


def _rows():
    return [
        {"hash": "aaa111", "name": "first", "auto_rank": 1, "n_mevs": 1,
         "filtered": False, "finalist": True},
        {"hash": "bbb222", "name": "second", "auto_rank": 2, "n_mevs": 2,
         "filtered": False, "finalist": False},
        {"hash": "ccc333", "name": "third", "auto_rank": 3, "n_mevs": 1,
         "filtered": False, "finalist": False},
    ]


@pytest.fixture()
def board(monkeypatch, tmp_path):
    """A seeded leaderboard in a temporary cache, plus a temporary review dir."""
    from creditiq.models import versions as V
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path / "versions")
    monkeypatch.setattr(runcache, "CACHE_DIR", tmp_path / "cache")
    api_main._SEL_RESULTS.clear()
    cfg = sel.SelectionConfig.from_dict({**CFG, "portfolio": "consumer"})
    payload = {"config_hash": cfg.hash(), "data_fingerprint": "fp",
               "n_combos": 3, "n_rows": 3, "n_filtered": 0,
               "rows": _rows(), "cores": [], "scenarios": []}
    runcache.save("consumer", "selection", cfg.hash(), payload)
    yield cfg.hash()
    api_main._SEL_RESULTS.clear()


def _post_row(config, model_hash, **body):
    return client.post(f"/api/selection/consumer/review/{model_hash}",
                       params={"config": config}, json=body)


# ── the gates ────────────────────────────────────────────────────────────────
def test_rejecting_without_a_justification_is_refused(board):
    r = _post_row(board, "aaa111", reviewer="ben", status="rejected")
    assert r.status_code == 400
    assert "justification" in r.json()["detail"]


def test_rejecting_with_one_lands_in_the_audit(board):
    r = _post_row(board, "aaa111", reviewer="ben", status="rejected",
                  reason_code="weak_stress_response",
                  justification="Peak PD barely moves under the severe path.")
    assert r.status_code == 200
    review = client.get("/api/selection/consumer/review",
                        params={"config": board}).json()
    assert review["rows"]["aaa111"]["status"] == "rejected"
    fields = {a["field"] for a in review["audit"]
              if a["model_hash"] == "aaa111"}
    assert {"status", "reason_code", "justification"} <= fields
    assert all(a["reviewer"] == "ben" and a["at"] for a in review["audit"])


def test_a_rank_away_from_auto_needs_a_justification(board):
    r = client.post("/api/selection/consumer/review/order",
                    params={"config": board},
                    json={"reviewer": "ben",
                          "order": ["bbb222", "aaa111", "ccc333"]})
    assert r.status_code == 400
    assert "justification" in r.json()["detail"]

    r = client.post("/api/selection/consumer/review/order",
                    params={"config": board},
                    json={"reviewer": "ben",
                          "order": ["bbb222", "aaa111", "ccc333"],
                          "justifications": {
                              "bbb222": "Preferred sign story for the book.",
                              "aaa111": "Counterintuitive MEV mix."}})
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert rows["bbb222"]["user_rank"] == 1
    assert rows["aaa111"]["user_rank"] == 2
    assert rows["ccc333"]["user_rank"] == 3      # unchanged rank, no text needed


def test_the_auto_rank_is_never_mutated(board):
    client.post("/api/selection/consumer/review/order",
                params={"config": board},
                json={"reviewer": "ben",
                      "order": ["ccc333", "bbb222", "aaa111"],
                      "justifications": {"ccc333": "j", "aaa111": "j"}})
    results = client.get("/api/selection/consumer/results",
                         params={"config": board}).json()
    assert [r["auto_rank"] for r in results["rows"]] == [1, 2, 3]


def test_reviewer_is_required(board):
    r = _post_row(board, "aaa111", reviewer="", status="challenger")
    assert r.status_code == 400
    assert "reviewer" in r.json()["detail"]


def test_unknown_models_and_reason_codes_are_refused(board):
    assert _post_row(board, "zzz999", reviewer="ben",
                     status="challenger").status_code == 404
    r = _post_row(board, "aaa111", reviewer="ben", status="rejected",
                  reason_code="not_a_code", justification="x")
    assert r.status_code == 400
    assert "reason_code" in r.json()["detail"]


# ── the export ───────────────────────────────────────────────────────────────
def test_the_audit_exports_as_csv_and_round_trips(board):
    _post_row(board, "aaa111", reviewer="ben", status="champion")
    _post_row(board, "bbb222", reviewer="ben", status="rejected",
              reason_code="business_judgment", justification="Board asked.")
    r = client.get("/api/selection/consumer/review/export",
                   params={"config": board})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    import csv as _csv
    import io as _io
    rows = list(_csv.DictReader(_io.StringIO(r.text)))
    assert {row["field"] for row in rows} >= {"status", "justification"}
    assert all(row["reviewer"] == "ben" for row in rows)
    assert any(row["after"] == "rejected" for row in rows)


def test_partial_updates_do_not_blank_other_fields(board):
    _post_row(board, "aaa111", reviewer="ben", status="rejected",
              reason_code="other", justification="Original reason.")
    _post_row(board, "aaa111", reviewer="ben", status="challenger")
    row = client.get("/api/selection/consumer/review",
                     params={"config": board}).json()["rows"]["aaa111"]
    assert row["status"] == "challenger"
    assert row["justification"] == "Original reason."
