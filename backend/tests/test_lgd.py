"""Loss given default as a chosen specification, and the Model ID that covers it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from creditiq import store
from creditiq.api.main import app
from creditiq.mev.panel import monthly_panel
from creditiq.models.lgd import LgdSpec, candidates, fit_lgd
from creditiq.models.spec import ModelSpec, VariableSpec

client = TestClient(app)


def test_candidates_only_offer_columns_that_exist_on_defaulted_rows():
    """Severity is fitted on defaults only. A driver that is well populated on
    the full tape and empty among defaults is useless here, and offering it is
    how an analyst ends up with a model that silently drops half its terms."""
    c = candidates(store.analysis_frame("cre"), "cre", monthly_panel())
    assert c["n_defaults"] > 0
    assert all(r["filled"] >= 0.5 for r in c["numeric"])
    # The 12-level cap blocks wide identity-like categoricals (a 144-level
    # metro). Cohort labels (vintage, origination year) are exempt: they are
    # offered as categoricals PRECISELY so they can never enter as a linear
    # term, and their levels bin down at fit time.
    from creditiq.analysis.screening import is_cohort_label
    import pandas as pd
    for r in c["categorical"]:
        if is_cohort_label(pd.Series([], name=r["column"], dtype=float)) \
                or "vintage" in r["column"]:
            continue
        assert 2 <= r["levels"] <= 12, r["column"]


def test_the_macro_block_is_reachable():
    """It does not exist on the tape — it is joined at the default month. An
    earlier version scanned the columns before attaching it, which hid exactly
    the drivers that make downturn LGD respond."""
    c = candidates(store.analysis_frame("mortgage"), "mortgage", monthly_panel())
    assert "hpi_yoy" in {r["column"] for r in c["numeric"] if r["macro"]}


def test_lgd_is_cached_on_the_specification_not_the_portfolio():
    """Keyed on the portfolio alone, the first analyst's severity model would be
    served to everyone who asked afterwards — the same class of bug as saving a
    version with the wrong macro terms: silent, and only visible in the number."""
    from creditiq.models import scenario_service as SS
    a = SS.lgd_model("cre", LgdSpec("cre", drivers=("current_ltv",)))
    b = SS.lgd_model("cre", LgdSpec("cre", drivers=("current_ltv", "workout_months")))
    assert a.spec.hash() != b.spec.hash()
    assert list(a.columns) != list(b.columns)


def test_the_driver_order_is_not_part_of_the_identity():
    assert (LgdSpec("cre", drivers=("a", "b")).hash()
            == LgdSpec("cre", drivers=("b", "a")).hash())


def test_severity_moves_with_the_macro_driver():
    """A downturn LGD that does not respond is the most common thing a validator
    writes up. Commercial property falling one standard deviation has to raise
    predicted severity, and by a visible amount."""
    r = client.get("/api/portfolios/cre/lgd/sensitivity")
    assert r.status_code == 200
    rows = {x["driver"]: x for x in r.json()["sensitivity"]}
    cre = rows["cre_price_index_yoy"]
    assert cre["down"] > cre["up"], "a property price fall must raise severity"
    assert cre["down"] - cre["up"] > 0.05, "the response is too small to be real"


def test_the_fitted_mean_matches_the_realised_mean():
    """A fractional logit is estimated by quasi-likelihood, so the fitted mean
    should track the sample mean closely when an intercept is present."""
    df, mev = store.analysis_frame("mortgage"), monthly_panel()
    m = fit_lgd(df, LgdSpec.default_for("mortgage"), mev)
    predicted = sum(c["predicted"] * c["n"] for c in m.calibration)
    n = sum(c["n"] for c in m.calibration)
    assert abs(predicted / n - m.mean_lgd) < 0.02


# ── the Model ID covers both halves ──────────────────────────────────────────
def test_the_lgd_specification_changes_the_model_id():
    """An ECL number is PD x LGD x EAD. A hash covering only the hazard model
    would let two models share a name while carrying severity specifications
    twenty points apart in a downturn."""
    pd_only = ModelSpec("cre", [VariableSpec("dscr_reported")])
    with_a = ModelSpec("cre", [VariableSpec("dscr_reported")],
                       lgd=LgdSpec("cre", drivers=("current_ltv",)))
    with_b = ModelSpec("cre", [VariableSpec("dscr_reported")],
                       lgd=LgdSpec("cre", drivers=("current_ltv", "workout_months")))
    assert len({pd_only.hash(), with_a.hash(), with_b.hash()}) == 3


def test_a_half_built_model_names_the_half_that_exists():
    """USER-DIRECTED (2026-09-16, see DECISIONS): each half carries its own
    name from its own hash, and the pair is the two names collated — never a
    third minted name. A half-built model therefore IS named (the half that
    exists), and the response still says which half is missing."""
    r = client.post("/api/model/identity",
                    json={"portfolio": "cre", "variables": [{"column": "dscr_reported"}]})
    body = r.json()
    assert body["complete"] is False
    assert body["name"] == body["pd_name"] and body["pd_name"]
    assert body["lgd_name"] is None
    assert "LGD drivers" in body["missing"]


def test_a_model_id_needs_both_halves():
    r = client.post("/api/model/identity", json={
        "portfolio": "cre", "variables": [{"column": "dscr_reported"}],
        "lgd": {"drivers": ["current_ltv"], "categoricals": []}})
    body = r.json()
    assert body["complete"] is True
    assert body["name"]


def test_saving_without_an_lgd_model_is_refused():
    """Not a nag. A saved version is meant to be the thing that produced a loss
    number, and half of that number is severity."""
    r = client.post("/api/versions", json={
        "portfolio": "cre", "variables": [{"column": "dscr_reported"}], "mevs": []})
    assert r.status_code == 400
    assert "LGD" in r.json()["detail"]


def test_a_saved_version_can_be_loaded_back_whole():
    from creditiq.models import versions as vstore
    spec = ModelSpec("cre", [VariableSpec("dscr_reported")],
                     lgd=LgdSpec("cre", drivers=("current_ltv",)))
    v = vstore.save(spec, {})
    try:
        r = client.get(f"/api/versions/{v.hash}")
        assert r.status_code == 200
        back = ModelSpec.from_dict(r.json()["spec"])
        # The identity survives the round trip. If it did not, "re-run it to
        # identical results" would be a claim rather than a property.
        assert back.hash() == spec.hash()
        assert back.lgd is not None and back.lgd.drivers == ("current_ltv",)
    finally:
        vstore.delete(v.hash)


def test_per_column_settings_are_mappings_on_the_wire():
    """`treatments`, `edges` and `knots` serialise as OBJECTS, not pairs.

    `LgdSpec` is frozen, so it stores them as tuples of pairs in order to hash.
    That is an implementation detail and it must not leak. It did: the interface
    received `[["cltv", "spline"]]`, treated it as the mapping it is named like,
    and wrote `{...treatments, [col]: t}`. Spreading an ARRAY into an object
    literal yields `{"0": ["cltv", "spline"], "cltv": "bins"}`, the request
    failed validation, and NO treatment other than the default could ever be
    applied to a severity driver.
    """
    from creditiq.models.spec import LgdSpec

    spec = LgdSpec(portfolio="mortgage", drivers=("hpi_yoy", "cltv"),
                   treatments=(("cltv", "spline"),), knots=(("cltv", (0.6, 0.9)),))
    body = spec.to_dict()
    assert body["treatments"] == {"cltv": "spline"}
    assert body["knots"] == {"cltv": [0.6, 0.9]}

    # The shape the interface produces by spreading must round-trip unharmed.
    spread = {**body["treatments"], "hpi_yoy": "continuous"}
    assert spread == {"cltv": "spline", "hpi_yoy": "continuous"}, (
        "spreading the wire form must not produce index keys")

    r = client.post("/api/lgd/fit", json=body)
    assert r.status_code == 200, r.json()
    # The treatment survived: a spline emits a basis column, not the raw driver.
    assert any(c.startswith("cltv_basis") for c in r.json()["columns"])


def test_a_specification_saved_in_the_older_list_form_still_loads():
    """Version files written before the wire format changed carry pairs, and a
    saved specification must stay readable — that is the point of saving it."""
    from creditiq.models.spec import LgdSpec

    spec = LgdSpec(portfolio="mortgage", drivers=("hpi_yoy", "cltv"),
                   treatments=(("cltv", "spline"),), knots=(("cltv", (0.6, 0.9)),))
    legacy = {**spec.to_dict(),
              "treatments": [["cltv", "spline"]], "edges": [],
              "knots": [["cltv", [0.6, 0.9]]]}
    assert LgdSpec.from_dict(legacy) == spec

    r = client.post("/api/lgd/fit", json=legacy)
    assert r.status_code == 200, r.json()
    assert any(c.startswith("cltv_basis") for c in r.json()["columns"])


def test_a_declared_severity_scores_exactly_that_value_everywhere():
    """An assumed model is not a fit: an intercept-only model whose intercept
    is the logit of the declared value, flowing through the same scoring
    machinery as a fitted model. Every account, every month, exactly the
    declared number."""
    import numpy as np
    import pandas as pd
    from creditiq.models import lgd as LGD
    from creditiq.models.spec import LgdSpec

    spec = LgdSpec(portfolio="consumer", assumed_lgd=0.55)
    m = LGD.assumed_model(spec)
    df = pd.DataFrame({"performance_date": pd.to_datetime(["2024-01-01"] * 7)})
    pred = m.predict(LGD.design_for(df, m))
    assert np.allclose(pred, 0.55)
    assert m.n_defaults == 0, "nothing was estimated and the record says so"

    # The assumption is identity: a different value is a different model, and
    # a spec without one keeps the hash it always had (adding the key
    # unconditionally would have renamed every saved model).
    assert spec.hash() != LgdSpec(portfolio="consumer").hash()
    assert spec.hash() != LgdSpec(portfolio="consumer", assumed_lgd=0.45).hash()
    assert LgdSpec.from_dict(spec.to_dict()).hash() == spec.hash()

    from creditiq.models.naming import lgd_display
    assert lgd_display(spec) == "assumed 55%"

    with __import__("pytest").raises(ValueError, match="between 0 and 1"):
        LGD.assumed_model(LgdSpec(portfolio="consumer", assumed_lgd=1.2))
