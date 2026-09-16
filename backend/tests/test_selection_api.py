"""The selection job API: verbose progress, clean state transitions, honest 404s.

The search itself is exercised in test_selection_metrics.py; here the engine
is stubbed so these tests wall off the API contract alone — a run that starts
and reports, a status that names what is being fitted, a cancel that lands,
and a results endpoint that computes nothing.
"""

import time

import pytest
from fastapi.testclient import TestClient

import creditiq.api.main as api_main
from creditiq.api.main import app
from creditiq.models import runcache
from creditiq.models import selection as sel

client = TestClient(app)

CFG = {
    "candidates": [{"column": "fico_orig"}, {"column": "dti"}],
    "cores": ["stepwise"],
    "mev_families": ["unemployment_rate"],
    "rules": {"top_n_full": 1},
}


def _payload(cfg_hash):
    row = {"hash": "abc123", "name": "stub", "auto_rank": 1, "n_mevs": 1,
           "filtered": False, "finalist": True}
    return {"config_hash": cfg_hash, "data_fingerprint": "fp", "n_combos": 3,
            "n_rows": 1, "n_filtered": 0, "rows": [row], "cores": [],
            "scenarios": ["baseline", "severely_adverse"]}


@pytest.fixture()
def stub_search(monkeypatch, tmp_path):
    """A fast fake run_search that still exercises progress and checkpoints."""
    monkeypatch.setattr(runcache, "CACHE_DIR", tmp_path)
    api_main._SEL.pop("consumer", None)
    api_main._SEL_RESULTS.clear()

    def fake(cfg, progress=None, cancel=None, checkpoint=None):
        for step, label in [(1, "building the stepwise core: testing fico_orig"),
                            (2, "screening macro variants against the stepwise "
                                "core: unemployment_rate YoY")]:
            if progress:
                progress(2, sel.N_STAGES, step, 2, label)
            time.sleep(0.05)
        payload = _payload(cfg.hash())
        if checkpoint:
            checkpoint(payload)
        return payload

    monkeypatch.setattr(sel, "run_search", fake)
    yield
    api_main._SEL.pop("consumer", None)
    api_main._SEL_RESULTS.clear()


def _wait_done(key="consumer", timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = client.get(f"/api/selection/{key}/status").json()
        if s["state"] in ("done", "error", "cancelled"):
            return s
        time.sleep(0.05)
    raise AssertionError("search never finished")


# ── validation ───────────────────────────────────────────────────────────────
def test_unknown_candidate_columns_are_rejected():
    r = client.post("/api/selection/consumer/run", json={
        "config": {"candidates": [{"column": "does_not_exist"}]}})
    assert r.status_code == 400
    assert "does_not_exist" in r.json()["detail"]


def test_a_config_is_required():
    r = client.post("/api/selection/consumer/run", json={})
    assert r.status_code == 400
    assert "configuration" in r.json()["detail"]


def test_min_mevs_clamps_at_the_api_edge():
    """A hand-edited config with min_mevs 0 arrives clamped to 1 before the
    search ever starts."""
    r = client.post("/api/selection/consumer/preview", json={
        "config": {**CFG, "rules": {"min_mevs": 0, "max_mevs": 9}}})
    assert r.status_code == 200


# ── the job ──────────────────────────────────────────────────────────────────
def test_run_reports_verbose_progress_then_done(stub_search):
    r = client.post("/api/selection/consumer/run", json={"config": CFG})
    assert r.status_code == 200
    assert r.json()["state"] == "running"

    saw_label = False
    t0 = time.time()
    while time.time() - t0 < 10:
        s = client.get("/api/selection/consumer/status").json()
        if s["state"] == "running" and "core" in (s.get("label") or ""):
            saw_label = True
            assert s["n_stages"] == sel.N_STAGES
            assert s["stage_no"] >= 1
            assert "elapsed_s" in s
        if s["state"] == "done":
            break
        time.sleep(0.02)
    s = _wait_done()
    assert s["state"] == "done"
    assert saw_label, "the polled status carried a verbose fitting label"


def test_a_second_run_while_running_does_not_stack(stub_search, monkeypatch):
    import threading
    gate = threading.Event()

    def slow(cfg, progress=None, cancel=None, checkpoint=None):
        gate.wait(5)
        return _payload(cfg.hash())

    monkeypatch.setattr(sel, "run_search", slow)
    r1 = client.post("/api/selection/consumer/run", json={"config": CFG})
    assert r1.json()["state"] == "running"
    r2 = client.post("/api/selection/consumer/run", json={"config": CFG})
    assert r2.json()["state"] == "running"    # the running one, not a new one
    gate.set()
    _wait_done()


def test_results_is_a_lookup_never_a_computation(stub_search):
    cfg_hash = sel.SelectionConfig.from_dict(
        {**CFG, "portfolio": "consumer"}).hash()
    r = client.get("/api/selection/consumer/results",
                   params={"config": cfg_hash})
    assert r.status_code == 404
    assert "Run the search" in r.json()["detail"]

    client.post("/api/selection/consumer/run", json={"config": CFG})
    _wait_done()
    r = client.get("/api/selection/consumer/results",
                   params={"config": cfg_hash})
    assert r.status_code == 200
    body = r.json()
    assert body["n_rows"] == 1
    assert "current" in body


def test_cancel_lands_between_fits(stub_search, monkeypatch):
    def cancellable(cfg, progress=None, cancel=None, checkpoint=None):
        for i in range(200):
            if cancel is not None and cancel.is_set():
                raise sel.Cancelled()
            time.sleep(0.02)
        return _payload(cfg.hash())

    monkeypatch.setattr(sel, "run_search", cancellable)
    client.post("/api/selection/consumer/run", json={"config": CFG})
    time.sleep(0.1)
    client.post("/api/selection/consumer/cancel")
    s = _wait_done()
    assert s["state"] == "cancelled"


def test_an_engine_error_is_reported_not_swallowed(stub_search, monkeypatch):
    def broken(cfg, progress=None, cancel=None, checkpoint=None):
        raise ValueError("no core survived the stepwise rules")

    monkeypatch.setattr(sel, "run_search", broken)
    client.post("/api/selection/consumer/run", json={"config": CFG})
    s = _wait_done()
    assert s["state"] == "error"
    assert "no core survived" in s["error"]


# ── saved configurations ─────────────────────────────────────────────────────
def test_configs_round_trip(stub_search, tmp_path, monkeypatch):
    from creditiq.models import versions as V
    monkeypatch.setattr(V, "VERSIONS_DIR", tmp_path)
    client.post("/api/selection/consumer/run",
                json={"config": CFG, "save_as": "quarterly rebuild"})
    _wait_done()
    listing = client.get("/api/selection/consumer/configs").json()["configs"]
    assert len(listing) == 1
    assert listing[0]["name"] == "quarterly rebuild"
    got = client.get(
        f"/api/selection/consumer/configs/{listing[0]['id']}").json()
    assert got["config"]["rules"]["min_mevs"] >= 1
    r = client.delete(f"/api/selection/consumer/configs/{listing[0]['id']}")
    assert r.status_code == 200
    assert client.get("/api/selection/consumer/configs").json()["configs"] == []
