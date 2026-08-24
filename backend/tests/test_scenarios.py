"""Scenario provenance."""

from creditiq.mev import scenarios as scen


def test_every_shipped_scenario_is_one_the_fed_published():
    """No invented middle path.

    An interpolated "adverse" line is indistinguishable from a supervisory one on
    a chart, sits exactly where a reader expects a real path, and borrows the
    credibility of the two beside it. The label was the only thing separating
    them, and a label is not enough.
    """
    scenarios, _ = scen.load_all()
    assert set(scenarios) == {"baseline", "severely_adverse"}
    assert all(s.published for s in scenarios.values())
    assert not hasattr(scen, "derive_adverse")
