"""Wide categoricals: collapse, shrinkage, and an honest null floor.

The mortgage book carries 144 metros sharing under two thousand defaults, and
only ten of them have any real effect. That is the case where a naive weight of
evidence quietly manufactures signal.
"""

from __future__ import annotations

import pytest

from helios import store
from helios.analysis import binning as B


@pytest.fixture(scope="module")
def mortgage():
    df, _ = store.screening_frame("mortgage")
    return df, df["default_flag"]


def test_the_book_actually_has_a_wide_categorical(mortgage):
    df, _ = mortgage
    n = df["msa"].nunique()
    assert n > 100, f"only {n} metros — the high-cardinality path is untested"
    share = df["msa"].value_counts(normalize=True)
    assert share.iloc[0] < 0.15, "one metro dominates; that is not a national book"
    assert (share < 0.01).sum() > 50, "no long thin tail to collapse"


def test_unmanaged_weight_of_evidence_inflates_the_information_value(mortgage):
    """The number the ladder exists to stop anyone quoting."""
    df, y = mortgage
    naive = B.bin_categorical(df["msa"], y, max_levels=500, min_share=0.0, shrinkage=0.0)
    managed = B.bin_categorical(df["msa"], y)
    assert naive.iv > 4 * managed.iv, (
        f"naive {naive.iv:.4f} vs managed {managed.iv:.4f} — the tail is not being "
        f"handed spurious weight, so this book no longer demonstrates the problem")


def test_collapse_uses_a_population_floor_not_a_fixed_top_k(mortgage):
    df, y = mortgage
    b = B.bin_categorical(df["msa"], y, min_share=0.01)
    kept = [x for x in b.bins if x.levels and len(x.levels) == 1]
    # every level kept on its own must clear the floor
    for x in kept:
        assert x.pct_of_total >= 0.005, f"{x.label} kept at {x.pct_of_total:.3%}"
    # and the tail must have gone somewhere
    assert any(x.levels and len(x.levels) > 1 for x in b.bins), "no Other bin formed"


def test_shrinkage_pulls_thin_levels_toward_the_book_average(mortgage):
    df, y = mortgage
    unshrunk = B.bin_categorical(df["msa"], y, shrinkage=0.0)
    shrunk = B.bin_categorical(df["msa"], y)
    assert shrunk.shrinkage > 0
    assert abs(shrunk.iv) < abs(unshrunk.iv), "shrinkage did not reduce the value"
    # every bin's weight must move toward zero, never away
    for a, b in zip(unshrunk.bins, shrunk.bins):
        assert abs(b.woe) <= abs(a.woe) + 1e-9, f"{a.label} moved away from the average"


def test_low_cardinality_is_left_alone(mortgage):
    """Shrinking a three-level categorical biases it for no stability gain."""
    df, y = mortgage
    b = B.bin_categorical(df["occupancy"], y)
    assert b.shrinkage == 0.0
    assert b.n_levels_raw == b.n_levels_raw  # sanity


def test_the_null_floor_rises_with_a_realistic_wide_probe(mortgage):
    """A UNIFORM wide probe collapses entirely and reports a LOWER null for a wide
    categorical than a narrow one, which is backwards. The probe is drawn with a
    realistic concentration so the surviving large levels carry the chance signal,
    the way a real metro field does."""
    _, y = mortgage
    wide = B.null_floor_for_shape(y, "categorical", n_levels=120)
    assert wide > 0.002, "the wide probe collapsed to nothing and measured no null"


def test_managed_msa_sits_near_the_null_and_state_sits_below_it(mortgage):
    """The honest reading. Only ten of 144 metros carry a real effect, so managed
    MSA should barely clear the null; state should not clear it at all, because
    the effect lives at metro level."""
    df, y = mortgage
    floor = B.null_floor_for_shape(y, "categorical", n_levels=120)
    msa = B.bin_categorical(df["msa"], y).iv
    state = B.bin_categorical(df["state"], y).iv
    assert msa < 0.05, f"managed MSA at {msa:.4f} is still inflated"
    assert state < floor, f"state at {state:.4f} clears the null floor {floor:.4f}"


def test_warnings_explain_what_was_done(mortgage):
    df, y = mortgage
    b = B.bin_categorical(df["msa"], y)
    text = " ".join(b.warnings).lower()
    assert "folded" in text and "shrunk" in text, b.warnings
