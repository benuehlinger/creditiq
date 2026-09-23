"""The column on its own: shape, spread, concentration.

These statistics exist to explain what the binning panels cannot. A column
whose mass sits on one value produces few quantile buckets however many are
requested, and the shape panel reports the buckets without ever saying why
there are only that many.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from creditiq.analysis import univariate as U


def test_a_point_mass_is_named_as_the_reason_binning_collapses():
    rng = np.random.default_rng(0)
    x = pd.Series(np.r_[np.zeros(4000), rng.lognormal(6, 1, 1000)], name="paid")
    d = U.describe(x)
    assert d["kind"] == "numeric"
    assert d["mode"] == 0.0
    assert d["mode_share_pct"] > 75
    labels = {f["label"] for f in d["findings"]}
    assert "Concentrated at one value" in labels
    assert "Zero-inflated" in labels
    # The finding must carry the number AND the treatment, not just a warning.
    detail = next(f["detail"] for f in d["findings"]
                  if f["label"] == "Concentrated at one value")
    assert "own bin" in detail


def test_skew_and_tails_are_measured_and_read_in_words():
    rng = np.random.default_rng(1)
    d = U.describe(pd.Series(rng.lognormal(0, 1.4, 20_000), name="amount"))
    assert d["skew"] > 1.0
    assert d["kurtosis_excess"] > 3.0
    assert "right-skewed" in d["skew_note"]
    assert {"Strongly skewed", "Heavy tails"} <= {f["label"] for f in d["findings"]}
    # A log transform is offered only because it measurably helps.
    assert abs(d["log1p_skew"]) < abs(d["skew"])

    sym = U.describe(pd.Series(rng.normal(100, 10, 20_000), name="score"))
    assert abs(sym["skew"]) < 0.5
    assert sym["skew_note"] == "Near symmetric."
    assert "Strongly skewed" not in {f["label"] for f in sym["findings"]}


def test_a_log_transform_is_not_offered_where_it_cannot_apply():
    """Negative values make log undefined, so it is never suggested there."""
    rng = np.random.default_rng(2)
    x = pd.Series(np.r_[rng.lognormal(0, 1.4, 5000), -rng.lognormal(0, 1, 50)],
                  name="pnl")
    d = U.describe(x)
    assert d["negative_pct"] > 0
    assert "log1p_skew" not in d
    assert "A log transform would help" not in {f["label"] for f in d["findings"]}


def test_percentiles_describe_what_a_mean_cannot():
    """The whole reason the percentile row exists: on a heavy tail the mean
    sits far from the middle of the data."""
    rng = np.random.default_rng(3)
    d = U.describe(pd.Series(rng.lognormal(0, 2, 50_000), name="x"))
    assert d["mean"] > d["median"] * 2
    assert d["percentiles"]["p50"] < d["percentiles"]["p99"] / 10


def test_a_wide_categorical_reports_its_thin_tail():
    levels = [f"metro_{i}" for i in range(140)]
    rng = np.random.default_rng(4)
    # Zipf-ish: a few big metros, a long thin tail.
    w = 1 / np.arange(1, 141) ** 1.2
    x = pd.Series(rng.choice(levels, 40_000, p=w / w.sum()), name="msa")
    d = U.describe(x)
    assert d["kind"] == "categorical"
    assert d["n_unique"] > 100
    assert d["n_levels_under_1pct"] > 50
    assert 0 < d["concentration_hhi"] < 1
    assert "Wide categorical" in {f["label"] for f in d["findings"]}


def test_missing_is_reported_never_imputed():
    x = pd.Series([1.0, 2.0, None, None, 5.0] * 100, name="v")
    d = U.describe(x)
    assert d["n_missing"] == 200
    assert 39 < d["missing_pct"] < 41
    assert d["n"] == 300, "described on the values that exist"
    assert "Substantially missing" in {f["label"] for f in d["findings"]}


def test_an_empty_column_says_so_rather_than_dividing_by_zero():
    d = U.describe(pd.Series([None, None, None], dtype=float, name="v"))
    assert d["n"] == 0
    assert "Entirely missing" in {f["label"] for f in d["findings"]}


def test_a_sentinel_code_is_found_even_though_it_defines_the_percentiles():
    """A credit score of zero means "no score", not the worst score. It holds
    enough rows to drag p05 down to contain itself, so testing it against a
    body it helped define finds nothing — the body has to be measured with
    the candidate removed. This is the real obligorCreditScore column: ~8%
    of rows at zero, the rest between 400 and 900."""
    rng = np.random.default_rng(5)
    real = rng.normal(600, 80, 92_000).clip(400, 900)
    x = pd.Series(np.r_[np.zeros(8_000), real], name="obligorCreditScore")
    d = U.describe(x)

    assert d["top_values"][0]["value"] == 0.0
    assert 7 < d["top_values"][0]["pct"] < 9
    assert np.percentile(x.dropna(), 5) == 0.0, (
        "the sentinel defines p05, which is why the naive test failed")

    f = next(f for f in d["findings"] if f["label"] == "Possible sentinel value")
    assert "0" in f["detail"] and "unknown" in f["detail"]
    assert "map it to missing" in f["detail"], "the finding must name the fix"


def test_a_clean_column_is_not_accused_of_holding_a_sentinel():
    rng = np.random.default_rng(6)
    d = U.describe(pd.Series(rng.normal(600, 80, 50_000), name="score"))
    assert "Possible sentinel value" not in {f["label"] for f in d["findings"]}


def test_the_histogram_opens_on_the_full_range_and_carries_the_event_rate():
    """Trimming by default would hide the tail, which is what a reader opens
    a histogram to see. The rate rides on the same bars so the relationship
    is read on the same axis as the shape."""
    rng = np.random.default_rng(7)
    v = rng.lognormal(0, 1.5, 30_000)
    y = pd.Series((rng.random(30_000) < 0.02).astype(int))
    d = U.describe_numeric(pd.Series(v, name="amount"), y=y)

    full = d["histogram"]
    assert full["window"][0] == v.min() and full["window"][1] == v.max()
    assert full["below"] == 0 and full["above"] == 0, "the full range holds everything"
    assert len(full["counts"]) == len(full["rates"])
    # A bar too thin to carry a rate reports none rather than a spike.
    thin = [i for i, c in enumerate(full["counts"]) if c < 50]
    assert all(full["rates"][i] is None for i in thin)

    trimmed = d["histogram_trimmed"]
    assert trimmed["above"] > 0, "the trimmed window must say what it excluded"
    assert trimmed["window"][1] < full["window"][1]
