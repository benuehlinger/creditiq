"""Ranking and stress behaviour: the numbers a reviewer sorts by.

The composite is checked against a hand-computed example, because a ranking
that cannot be reproduced on paper is a ranking nobody can defend in front of
model validation.
"""

import numpy as np
import pytest

from creditiq.models import selection as S


def _row(**kw):
    base = {"filtered": False, "auc_in": 0.75, "auc_oot": 0.72,
            "all_significant": True, "core_shifted": False, "max_vif": 1.0,
            "stress": {"monotone": True}}
    base.update(kw)
    return base


def test_composite_rank_matches_a_hand_computed_example():
    r1 = _row(auc_oot=0.75, auc_in=0.76, max_vif=1.0)
    r2 = _row(auc_oot=0.70, auc_in=0.80, all_significant=False,
              stress={"monotone": False}, core_shifted=True, max_vif=20.0)
    r3 = _row(auc_oot=0.72, auc_in=0.73, stress={"monotone": False},
              max_vif=2.0)
    rows = [r2, r3, r1]                    # deliberately out of order
    S.composite_rank(rows)

    # By hand, with span = 0.75 - 0.70 = 0.05 and the VIF flag line at 5:
    #   r1: .30(1) + .15 + .15 + .10 + .20(1) + .10(1 - .01/.10)  =  0.99
    #   r2: .30(0) + 0 + 0 + 0 + .20(-1) + .10(1 - min(.10/.10,1)) = -0.20
    #   r3: .30(.4) + .15 + 0 + .10 + .20(1) + .10(.9)            =  0.66
    assert r1["score"] == pytest.approx(0.99, abs=1e-9)
    assert r2["score"] == pytest.approx(-0.20, abs=1e-9)
    assert r3["score"] == pytest.approx(0.66, abs=1e-9)
    assert (r1["auto_rank"], r3["auto_rank"], r2["auto_rank"]) == (1, 2, 3)


def test_vif_credit_spans_full_credit_to_penalty():
    """Full credit to the flag line, zero at twice it, floored at -1."""
    assert S._vif_credit(1.0, 5.0) == pytest.approx(1.0)
    assert S._vif_credit(5.0, 5.0) == pytest.approx(1.0)
    assert S._vif_credit(7.5, 5.0) == pytest.approx(0.5)
    assert S._vif_credit(10.0, 5.0) == pytest.approx(0.0)
    assert S._vif_credit(15.0, 5.0) == pytest.approx(-0.5)
    assert S._vif_credit(20.0, 5.0) == pytest.approx(-1.0)
    assert S._vif_credit(22.0, 5.0) == pytest.approx(-1.0)   # floored


def test_a_severely_collinear_model_cannot_win_on_discrimination_alone():
    """The whole point of the penalty: best-in-field out-of-time AUC does not
    buy a VIF-22 model the top of the board over a clean one that is worst in
    field on AUC and identical everywhere else."""
    clean = _row(auc_oot=0.70, auc_in=0.70, max_vif=1.0)
    collinear = _row(auc_oot=0.80, auc_in=0.80, max_vif=22.0)
    S.composite_rank([collinear, clean])

    assert clean["score"] > collinear["score"]
    assert clean["auto_rank"] == 1


def test_the_vif_penalty_tracks_the_configured_flag_line():
    """A reviewer who loosens max_vif to 10 moves the penalty with it."""
    row = _row(max_vif=10.0)
    S.composite_rank([row], max_vif=10.0)
    strict = _row(max_vif=10.0)
    S.composite_rank([strict], max_vif=5.0)
    assert row["score"] > strict["score"]


def test_filtered_rows_are_never_ranked():
    rows = [_row(), _row(filtered=True, filter_reason="max_vif")]
    S.composite_rank(rows)
    assert rows[0]["auto_rank"] == 1
    assert rows[1]["auto_rank"] is None
    assert rows[1]["score"] is None


def test_auc_falls_back_to_in_sample_when_oot_is_thin():
    rows = [_row(auc_oot=None, auc_in=0.80), _row(auc_oot=0.70, auc_in=0.71)]
    S.composite_rank(rows)
    assert rows[0]["auto_rank"] == 1


# ── stress behaviour ─────────────────────────────────────────────────────────
def _stress_row(beta: float):
    """A minimal row carrying one unemployment term with unit scale."""
    label = S.MevSpec(key="unemployment_rate", transform="yoy").label()
    col = f"mev:{label}"
    p = 0.02
    return {
        "name": "hand-built", "mevs": [
            {"key": "unemployment_rate", "transform": "yoy",
             "lag_months": 0, "label": label}],
        "coefficients": [{"name": col, "estimate": beta}],
        "mev_scale": {col: {"mean": 0.0, "std": 1.0}},
        "anchor_logit": float(np.log(p / (1 - p))),
    }


def test_stress_peaks_order_by_scenario_severity():
    """Unemployment swings harder under the severe scenario, so with an
    economically-signed coefficient the severe peak must exceed the baseline
    peak and the anchor. (A counter-economic sign is caught by the sign-check
    column, not here: the severe scenario also has the deeper recovery leg, so
    a peak exists either way.)"""
    cfg = S.SelectionConfig(portfolio="consumer", candidates=[
        S.CandidateVar(column="fico_orig")])
    good = _stress_row(beta=0.5)
    S.stress_check(cfg, [good])
    st = good["stress"]
    assert st["usable"]
    assert st["monotone"] is True
    assert st["peak_pd"]["severely_adverse"] > st["peak_pd"]["baseline"]
    assert st["peak_stressed_pd"] > st["anchor_pd"]


def test_stress_response_grows_with_the_coefficient():
    cfg = S.SelectionConfig(portfolio="consumer", candidates=[
        S.CandidateVar(column="fico_orig")])
    small, large = _stress_row(beta=0.05), _stress_row(beta=0.3)
    S.stress_check(cfg, [small, large])
    assert large["stress"]["peak_stressed_pd"] > small["stress"]["peak_stressed_pd"]


def test_stress_smoothness_is_a_second_difference():
    cfg = S.SelectionConfig(portfolio="consumer", candidates=[
        S.CandidateVar(column="fico_orig")])
    row = _stress_row(beta=0.5)
    S.stress_check(cfg, [row])
    s = row["stress"]["smoothness"]
    assert s is not None and 0.0 <= s < 0.5


def test_a_row_with_no_usable_path_says_so():
    cfg = S.SelectionConfig(portfolio="consumer", candidates=[
        S.CandidateVar(column="fico_orig")])
    row = _stress_row(beta=0.5)
    row["mev_scale"] = {}                  # the scale is gone: not usable
    S.stress_check(cfg, [row])
    assert row["stress"]["usable"] is False
    assert row["stress"]["monotone"] is None


# ── the whole search, small ──────────────────────────────────────────────────
def test_run_search_end_to_end_small():
    """A tiny but complete run: two candidates, one macro family, one finalist.
    This is the wall for the payload contract the API and the board rely on."""
    cfg = S.SelectionConfig(
        portfolio="consumer",
        candidates=[S.CandidateVar(column="fico_orig"),
                    S.CandidateVar(column="dti")],
        cores=["stepwise"],
        mev_terms=["unemployment_rate@yoy@0", "unemployment_rate@diff@3",
                   "real_gdp_growth@yoy@0"],
        rules=S.SelectionRules(top_n_full=1))
    seen = []
    payload = S.run_search(cfg, progress=lambda *a: seen.append(a))

    assert payload["config_hash"] == cfg.hash()
    assert payload["data_fingerprint"]
    assert payload["n_rows"] == len(payload["rows"]) > 0
    assert all(1 <= r["n_mevs"] <= 3 for r in payload["rows"])
    ranked = [r for r in payload["rows"] if r["auto_rank"]]
    assert ranked, "at least one ranked row"
    # NO automatic finalist pass. It was the one stage that left the thinned
    # screening frame and re-fitted the top rows on the full panel — fifteen
    # minutes on a 22-million-row tape, for models nobody had chosen. Every
    # figure the board ranks on is computed for every row on the lean path,
    # and opening a row as a draft refits on full data anyway.
    assert not any(r["finalist"] for r in payload["rows"])
    for r in payload["rows"]:
        assert r["auc_oot"] is not None or r["filtered"], (
            "ranking inputs must exist for every row without a full fit")
    # The top row is ranked on the same statistics as every other row.
    top = min(ranked, key=lambda r: r["auto_rank"])
    assert top["auto_rank"] == 1
    assert top["score"] is not None and top["max_vif"] is not None

    # progress was verbose: stages present, labels name what is being fitted
    stages = {s[0] for s in seen}
    assert stages >= {1, 2, 3}
    assert 4 not in stages, "the full-panel refit stage is gone"
    assert any("screening" in s[4] for s in seen)
