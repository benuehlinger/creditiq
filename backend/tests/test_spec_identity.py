"""The version hash must cover the whole specification.

A model identifier that omits part of the specification is worse than no
identifier: two genuinely different models get the same hash, the same
auto-generated name, and overwrite each other in the version store. It also
makes the "this fit is out of date" signal unreachable, because the thing that
changed is invisible to the comparison.

`max_bins` was missing from the PD side for exactly this reason — it was
introduced as a screen-local control rather than as part of the specification,
so nothing downstream knew about it. The first test below is written against
the DATACLASS rather than a fixed list, so a field added later fails here
instead of failing silently in the version store.
"""
from dataclasses import fields

from creditiq.models.spec import LgdVariable, ModelSpec, VariableSpec


def test_pd_variable_key_covers_every_field() -> None:
    declared = {f.name for f in fields(VariableSpec)}
    keyed = set(VariableSpec("fico_orig").key())
    assert declared - keyed == set(), (
        f"these fields change the model but are not in the hash: {declared - keyed}")


def test_lgd_variable_key_covers_every_field() -> None:
    declared = {f.name for f in fields(LgdVariable)}
    keyed = set(LgdVariable("cltv").key())
    assert declared - keyed == set()


def test_bin_count_changes_the_pd_hash() -> None:
    seven = ModelSpec(portfolio="consumer",
                      variables=[VariableSpec("fico_orig", treatment="bins", max_bins=7)])
    eight = ModelSpec(portfolio="consumer",
                      variables=[VariableSpec("fico_orig", treatment="bins", max_bins=8)])
    assert seven.hash() != eight.hash()
    assert seven.pd_hash() != eight.pd_hash()


def test_knot_count_changes_the_pd_hash() -> None:
    a = ModelSpec(portfolio="consumer",
                  variables=[VariableSpec("dti", treatment="spline", n_knots=3)])
    b = ModelSpec(portfolio="consumer",
                  variables=[VariableSpec("dti", treatment="spline", n_knots=5)])
    assert a.hash() != b.hash()


def test_an_unchanged_specification_keeps_its_hash() -> None:
    """The other half of the property. A hash that moved when nothing changed
    would report every model as drifted."""
    spec = ModelSpec(portfolio="consumer",
                     variables=[VariableSpec("fico_orig", treatment="bins", max_bins=7),
                                VariableSpec("dti", treatment="spline", n_knots=4)])
    again = ModelSpec.from_dict(spec.to_dict())
    assert again.hash() == spec.hash()
