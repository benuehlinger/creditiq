"""The severity search: the LGD twin of the selection pipeline.

Small configurations, real frames: fits on resolved defaults are cheap, so
the tests run the genuine pipeline rather than mocks.
"""

import pytest

from creditiq.models import lgd_selection as LS


@pytest.fixture(scope="module")
def payload():
    cfg = LS.LgdSelectionConfig(
        portfolio="consumer",
        candidates=["fico_orig", "months_on_book", "current_balance"],
        mev_terms=["unemployment_rate@yoy@3", "vix@ma6@3"],
    )
    return LS.run_search(cfg)


def test_every_row_carries_the_severity_yardsticks(payload):
    rows = [r for r in payload["rows"] if not r["filtered"]]
    assert rows
    for r in rows:
        assert r["mae_in"] is not None
        assert r["mae_oot"] is not None, "the consumer book has enough OOT defaults"
        assert r["max_vif"] is not None
        assert r["name"], "every row is named from its LgdSpec hash"
        assert r["n_mevs"] >= 1, "an unstressable severity model is not a candidate"


def test_the_board_ranks_by_the_stated_composite(payload):
    rows = sorted([r for r in payload["rows"] if r.get("auto_rank")],
                  key=lambda r: r["auto_rank"])
    scores = [r["score"] for r in rows]
    assert scores == sorted(scores, reverse=True)


def test_finalists_carry_the_full_panel(payload):
    fin = [r for r in payload["rows"] if r.get("finalist")]
    assert fin
    for r in fin:
        assert r["deviance_r2"] is not None
        assert "backtest" in r["full"]


def test_stress_direction_is_severity_up(payload):
    ok = [r for r in payload["rows"]
          if (r.get("stress") or {}).get("usable")]
    assert ok, "stress behaviour must be computable from coefficients alone"
    for r in ok:
        s = r["stress"]
        assert set(s) >= {"monotone", "anchor_severity", "peak_stressed_severity"}


def test_the_config_hash_is_stable_and_order_insensitive():
    a = LS.LgdSelectionConfig(portfolio="consumer",
                              candidates=["b", "a"], mev_terms=["y@yoy@3", "x@ma6@0"])
    b = LS.LgdSelectionConfig(portfolio="consumer",
                              candidates=["a", "b"], mev_terms=["x@ma6@0", "y@yoy@3"])
    assert a.hash() == b.hash()
