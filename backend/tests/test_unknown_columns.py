"""A specification may not name a column the panel does not have.

A missing column used to pass straight through. The design matrix skipped it,
the fit succeeded, no warning was raised, and the term was simply absent from
the model. Because the hash is taken from the specification rather than from the
design, the phantom column still changed the hash and the generated name: two
Model IDs for one model, with nothing in the coefficients to show the
difference. On the severity side a single unknown driver returned a model with
no coefficients at all.
"""
import pytest
from fastapi.testclient import TestClient

from creditiq.api.main import app

client = TestClient(app)

BASE = {
    "portfolio": "consumer",
    "variables": [{"column": "fico_orig", "treatment": "woe"}],
    "mevs": [], "estimator": "logistic", "seasoning_spline": True,
    "oot_from": "2023-01-01", "downsample_rows": 200_000,
    "lgd": {"portfolio": "consumer", "drivers": ["months_on_book"],
            "categoricals": [], "treatments": {}, "n_knots": 3, "max_bins": 5},
}


def _with(**over):
    spec = {**BASE, **over}
    return spec


def test_unknown_pd_variable_is_rejected() -> None:
    spec = _with(variables=[{"column": "fico_orig", "treatment": "woe"},
                            {"column": "not_a_real_column", "treatment": "woe"}])
    r = client.post("/api/fit", json=spec)
    assert r.status_code == 400
    assert "not_a_real_column" in r.json()["detail"]


def test_unknown_lgd_driver_is_rejected() -> None:
    spec = _with(lgd={**BASE["lgd"], "drivers": ["months_on_book", "nope_not_here"]})
    r = client.post("/api/fit", json=spec)
    assert r.status_code == 400
    assert "nope_not_here" in r.json()["detail"]


def test_unknown_driver_rejected_on_the_lgd_endpoint_too() -> None:
    r = client.post("/api/lgd/fit", json={**BASE["lgd"],
                                          "drivers": ["months_on_book", "nope_not_here"]})
    assert r.status_code == 400
    assert "nope_not_here" in r.json()["detail"]


def test_a_macro_driver_is_not_a_missing_column() -> None:
    """Macro drivers are joined from the published series, not read off the
    account panel, so they are legitimately absent from it."""
    spec = _with(lgd={**BASE["lgd"], "drivers": ["months_on_book", "unemployment_rate"]})
    r = client.post("/api/fit", json=spec)
    assert r.status_code == 200, r.text


def test_a_real_specification_still_fits() -> None:
    r = client.post("/api/fit", json=BASE)
    assert r.status_code == 200, r.text
    assert r.json()["coefficients"]
