"""The roll-up must handle every model type, not just the default one.

The roll-up does not read stored numbers. It REPLAYS each selected version's
specification against the current panel, so a treatment or an estimator the
replay path cannot rebuild fails here and nowhere else. The end-to-end path that
gets exercised by hand uses one estimator and weight of evidence, which leaves
splines, continuous terms, bin indicators and the two regularised estimators
untested against this surface.

The second test is the one that matters most: the roll-up total and the
Scenarios stage must produce the SAME number for the same specification. They
run through different code, so a divergence would put an executive total at odds
with the page the model was signed off on, with neither obviously wrong.
"""
import pytest

from creditiq.models import scenario_service as scensvc
from creditiq.models.spec import LgdSpec, MevSpec, ModelSpec, SampleSpec, VariableSpec

COLS = {"consumer": ["fico_orig", "dti"],
        "mortgage": ["fico_orig", "current_ltv"],
        "cre": ["dscr_reported", "current_ltv"]}
LGD_DRIVERS = {"consumer": ["months_on_book"], "mortgage": ["current_ltv"],
               "cre": ["current_ltv"]}


def make_spec(portfolio: str, treatment: str, estimator: str,
              lgd_treatment: str) -> ModelSpec:
    drivers = LGD_DRIVERS[portfolio]
    return ModelSpec(
        portfolio=portfolio,
        variables=[VariableSpec(c, treatment=treatment, max_bins=6, n_knots=4)  # type: ignore[arg-type]
                   for c in COLS[portfolio]],
        mevs=[MevSpec("unemployment_rate")],
        estimator=estimator,
        sample=SampleSpec(oot_from="2023-01-01", downsample_rows=200_000),
        lgd=LgdSpec(portfolio=portfolio, drivers=tuple(drivers),
                    treatments=tuple((c, lgd_treatment) for c in drivers)),
    )


@pytest.mark.parametrize("treatment", ["woe", "bins", "indicator", "continuous", "spline"])
def test_every_pd_treatment_projects(treatment: str) -> None:
    spec = make_spec("consumer", treatment, "logistic", "continuous")
    r = scensvc.run(spec, scenarios=["severely_adverse"])
    assert r.results["severely_adverse"].ecl > 0


@pytest.mark.parametrize("estimator", ["logistic", "logistic_l2", "logistic_l1"])
def test_every_estimator_projects(estimator: str) -> None:
    spec = make_spec("mortgage", "woe", estimator, "bins")
    r = scensvc.run(spec, scenarios=["severely_adverse"])
    assert r.results["severely_adverse"].ecl > 0


@pytest.mark.parametrize("lgd_treatment", ["continuous", "bins", "spline"])
def test_every_lgd_treatment_projects(lgd_treatment: str) -> None:
    spec = make_spec("cre", "woe", "logistic", lgd_treatment)
    r = scensvc.run(spec, scenarios=["severely_adverse"])
    assert r.results["severely_adverse"].ecl > 0


@pytest.mark.parametrize("treatment,estimator,lgd_treatment", [
    ("spline", "logistic_l2", "spline"),
    ("continuous", "logistic_l1", "bins"),
    ("bins", "logistic", "continuous"),
])
def test_a_stored_specification_projects_to_the_same_number(
        treatment, estimator, lgd_treatment) -> None:
    """A version is stored as a dictionary and rebuilt from it on the roll-up.

    The projection is only reproducible if the round trip through `to_dict` and
    `from_dict` preserves everything the design matrix reads, including the bin
    and knot counts. Those were absent from the PD variable for a long time.
    """
    spec = make_spec("consumer", treatment, estimator, lgd_treatment)
    rebuilt = ModelSpec.from_dict(spec.to_dict())
    assert rebuilt.hash() == spec.hash()

    direct = scensvc.run(spec, scenarios=["severely_adverse"])
    replayed = scensvc.run(rebuilt, scenarios=["severely_adverse"])
    assert replayed.results["severely_adverse"].ecl == pytest.approx(
        direct.results["severely_adverse"].ecl, rel=1e-12)
