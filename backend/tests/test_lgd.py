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
    assert all(2 <= r["levels"] <= 12 for r in c["categorical"])


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


def test_a_half_built_model_is_not_given_a_name():
    r = client.post("/api/model/identity",
                    json={"portfolio": "cre", "variables": [{"column": "dscr_reported"}]})
    body = r.json()
    assert body["complete"] is False
    assert body["name"] is None
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


def test_the_fit_endpoint_accepts_its_own_serialised_specification():
    """A saved LgdSpec must post straight back without translation.

    `LgdSpec` is frozen, so it holds treatments, edges and knots as tuples of
    pairs and `to_dict()` writes them as LISTS — the form in every saved
    version. The endpoint declared them as mappings only, so opening a saved
    model and pressing Fit LGD posted the stored specification back and got
    three validation errors, one per field. An interface that cannot read what
    it writes is the defect; both shapes are now accepted.
    """
    from creditiq.models.spec import LgdSpec

    spec = LgdSpec(portfolio="mortgage", drivers=("hpi_yoy", "cltv"),
                   treatments=(("cltv", "spline"),), knots=(("cltv", (0.6, 0.9)),))
    body = spec.to_dict()
    assert isinstance(body["treatments"], list), "the serialised form is a list"

    r = client.post("/api/lgd/fit", json=body)
    assert r.status_code == 200, r.json()

    # The mapping form must give an IDENTICAL fit, not merely also succeed.
    r2 = client.post("/api/lgd/fit", json={
        **body, "treatments": dict(spec.treatments), "edges": {},
        "knots": {c: list(v) for c, v in spec.knots}})
    assert r2.status_code == 200, r2.json()
    assert r2.json()["columns"] == r.json()["columns"]
    assert r2.json()["hash"] == r.json()["hash"]
    # The treatment survived: a spline emits a basis column, not the raw driver.
    assert any(c.startswith("cltv_basis") for c in r.json()["columns"])
