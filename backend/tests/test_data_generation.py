"""Data-generation invariants.

These are the Definition-of-Done checks for the data layer. If any of them fails,
nothing downstream is worth looking at.

The suite builds each portfolio once, at module scope, because generation is the
expensive step and every test reads the same tape.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from creditiq.data.assemble import assemble
from creditiq.data.build import SEEDS
from creditiq.data.calibrate import TARGET_AUC, TARGET_RATE, measure
from creditiq.data.generate import generate
from creditiq.data.portfolios import PORTFOLIOS

KEYS = list(PORTFOLIOS)


@pytest.fixture(scope="module")
def built() -> dict[str, tuple[pd.DataFrame, pd.DataFrame]]:
    out = {}
    for k, spec in PORTFOLIOS.items():
        res = generate(spec, seed=SEEDS[k])
        out[k] = assemble(res, seed=SEEDS[k])
    return out


# ── panel integrity ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("key", KEYS)
def test_no_duplicate_account_date_keys(built, key):
    p, _ = built[key]
    assert not p.duplicated(["account_id", "performance_date"]).any()


@pytest.mark.parametrize("key", KEYS)
def test_monthly_sequence_has_no_gaps(built, key):
    """Every account's rows must be consecutive months. A gap means an account
    came back to life after a terminal event."""
    p, _ = built[key]
    s = p.sort_values(["account_id", "performance_date"])
    per = s["performance_date"].dt.to_period("M").astype("int64")
    step = per.groupby(s["account_id"]).diff().dropna()
    assert (step == 1).all(), f"{(step != 1).sum()} non-consecutive month steps"


@pytest.mark.parametrize("key", KEYS)
def test_no_rows_after_a_terminal_event(built, key):
    p, _ = built[key]
    s = p.sort_values(["account_id", "performance_date"])
    term = s["terminal_event"].isin(["default", "payoff", "matured"])
    # a terminal event must be the last row for that account
    last = s.groupby("account_id")["performance_date"].transform("max")
    assert (s.loc[term, "performance_date"] == s.loc[term, :].pipe(
        lambda d: last.loc[d.index])).all()


@pytest.mark.parametrize("key", KEYS)
def test_default_flag_fires_once_per_account_at_most(built, key):
    p, _ = built[key]
    assert p.groupby("account_id")["default_flag"].sum().max() <= 1


@pytest.mark.parametrize("key", KEYS)
def test_months_on_book_is_monotone_within_an_account(built, key):
    p, _ = built[key]
    s = p.sort_values(["account_id", "performance_date"])
    d = s.groupby("account_id")["months_on_book"].diff().dropna()
    assert (d == 1).all()


@pytest.mark.parametrize("key", KEYS)
def test_exposure_and_loss_only_exist_on_defaults(built, key):
    p, _ = built[key]
    nd = p["default_flag"] == 0
    assert (p.loc[nd, "exposure_at_default"] == 0).all()
    assert (p.loc[nd, "loss_amount"] == 0).all()
    d = p["default_flag"] == 1
    assert (p.loc[d, "exposure_at_default"] > 0).all()


@pytest.mark.parametrize("key", KEYS)
def test_loss_plus_recovery_equals_exposure_at_default(built, key):
    p, _ = built[key]
    d = p[p["default_flag"] == 1]
    np.testing.assert_allclose(d["loss_amount"] + d["recovery_amount"],
                               d["exposure_at_default"], rtol=1e-5)


@pytest.mark.parametrize("key", KEYS)
def test_lgd_is_a_fraction(built, key):
    p, _ = built[key]
    d = p[p["default_flag"] == 1]["lgd_realised"]
    assert d.between(0.0, 1.0).all()


@pytest.mark.parametrize("key", KEYS)
def test_balances_are_non_negative_except_the_planted_value(built, key):
    """Exactly one negative balance is planted for the integrity validator."""
    p, _ = built[key]
    neg = p["current_balance"] < 0
    assert neg.sum() == 1, f"expected exactly 1 planted negative balance, got {neg.sum()}"


# ── economic credibility ─────────────────────────────────────────────────────
@pytest.mark.parametrize("key", KEYS)
def test_default_rate_lands_in_the_expected_band(built, key):
    p, _ = built[key]
    rate = float(p["default_flag"].mean() * 1200)
    lo, hi = TARGET_RATE[key]
    assert lo <= rate <= hi, f"{key}: {rate:.2f}%/yr outside {lo}-{hi}"


@pytest.mark.parametrize("key", KEYS)
def test_auc_lands_in_the_credible_band(key):
    """The number that gives a demo away. A synthetic tape scoring 0.97 tells the
    room the features were reverse-engineered from the target."""
    d = measure(PORTFOLIOS[key], seed=1)
    lo, hi = TARGET_AUC
    assert lo <= d.auc_in_time <= hi, f"{key}: AUC {d.auc_in_time:.3f} outside {lo}-{hi}"


def test_consumer_defaults_spike_in_2020(built):
    p, _ = built["consumer"]
    by = p.groupby(p["performance_date"].dt.year)["default_flag"].mean() * 1200
    assert by[2020] > 1.8 * by.loc[[2018, 2019]].mean()


def test_cre_office_diverges_after_2022(built):
    """The room will look for this. Office must separate from multifamily."""
    p, a = built["cre"]
    m = p.merge(a[["account_id", "property_type"]], on="account_id")
    late = m[m["performance_date"] >= "2023-06-01"]
    r = late.groupby("property_type")["default_flag"].mean() * 1200
    assert r["office"] > 1.6 * r["multifamily"], f"office {r['office']:.2f} vs mf {r['multifamily']:.2f}"


@pytest.mark.parametrize("key", KEYS)
def test_competing_risks_all_occur(built, key):
    p, _ = built[key]
    seen = set(p["terminal_event"].unique())
    assert {"default", "payoff", "censored"} <= seen


# ── determinism ──────────────────────────────────────────────────────────────
def test_generation_is_deterministic_under_a_fixed_seed():
    a = generate(PORTFOLIOS["cre"], seed=99).panel
    b = generate(PORTFOLIOS["cre"], seed=99).panel
    pd.testing.assert_frame_equal(a, b)


def test_a_different_seed_gives_different_data():
    a = generate(PORTFOLIOS["cre"], seed=99).panel
    b = generate(PORTFOLIOS["cre"], seed=100).panel
    assert not a.equals(b)


# ── the planted imperfections must actually be catchable ─────────────────────
def _iv(x: pd.Series, y: pd.Series, bins: int = 10) -> float:
    """Information value. Used here only to prove the plants are findable."""
    if x.dtype.kind in "fiu" and x.nunique() > bins:
        b = pd.qcut(x, bins, duplicates="drop")
    else:
        b = x.astype(str)
    t = pd.DataFrame({"b": b, "y": y}).groupby("b", observed=True)["y"].agg(["sum", "count"])
    good, bad = t["count"] - t["sum"], t["sum"]
    pg, pb = good / good.sum(), bad / bad.sum()
    ok = (pg > 0) & (pb > 0)
    return float(((pb - pg) * np.log(pb / pg))[ok].sum())


@pytest.mark.parametrize("key,col", [("consumer", "collections_referral_flag"),
                                     ("mortgage", "foreclosure_referral_flag"),
                                     ("cre", "watchlist_transfer_flag")])
def test_planted_leakage_has_an_absurd_iv(built, key, col):
    p, _ = built[key]
    assert _iv(p[col], p["default_flag"]) > 0.8


@pytest.mark.parametrize("key,col", [("consumer", "marketing_segment_code"),
                                     ("mortgage", "appraisal_vendor_code"),
                                     ("cre", "appraiser_panel_code")])
def test_planted_noise_is_indistinguishable_from_a_permutation_null(built, key, col):
    """A planted noise column must be no more predictive than chance.

    Tested against a PERMUTATION NULL rather than the textbook IV < 0.02 band,
    because that band is not sample-size free. Information value is biased upward
    in small samples: with ten bins and only ~350 defaults, the CRE book produces
    a null IV around 0.03 for a column with no signal whatsoever, and the plain
    0.02 threshold fails a column that is genuinely pure noise.

    This is not a testing convenience — it is a real property of the statistic,
    and the Explore surface has to show the same thing. The IV ranking table
    quotes the null floor for the current sample so an analyst does not read
    small-sample noise as weak predictive power.
    """
    p, _ = built[key]
    y = p["default_flag"]
    observed = _iv(p[col], y)
    rng = np.random.default_rng(11)
    null = np.array([_iv(p[col], y.sample(frac=1.0, random_state=int(r)).reset_index(drop=True))
                     for r in rng.integers(0, 10_000, 12)])
    ceiling = float(null.mean() + 3 * null.std())
    assert observed <= max(ceiling, 0.02), (
        f"{key}.{col}: IV {observed:.4f} exceeds the permutation null "
        f"{null.mean():.4f} +/- {null.std():.4f} (ceiling {ceiling:.4f})")


@pytest.mark.parametrize("key,a_col,b_col", [
    ("consumer", "fico_orig", "fico_refreshed"),
    ("mortgage", "original_ltv", "cltv_at_origination"),
    ("cre", "original_ltv", "ltv_at_appraisal")])
def test_planted_collinear_pair_exceeds_095(built, key, a_col, b_col):
    _, a = built[key]
    assert a[[a_col, b_col]].corr().iloc[0, 1] > 0.95


@pytest.mark.parametrize("key,col", [("consumer", "employment_tenure_months"),
                                     ("mortgage", "second_lien_pct"),
                                     ("cre", "lease_rollover_pct")])
def test_one_column_is_about_30_percent_missing(built, key, col):
    _, a = built[key]
    assert 0.25 <= a[col].isna().mean() <= 0.35


def test_an_impossible_dti_is_present_for_the_validator(built):
    for key in ("consumer", "mortgage"):
        _, a = built[key]
        assert (a["dti"] > 100).any()


@pytest.mark.parametrize("key,col", [("consumer", "channel"), ("mortgage", "state"),
                                     ("cre", "region")])
def test_categorical_coding_is_inconsistent(built, key, col):
    _, a = built[key]
    vals = a[col].astype(str)
    norm = vals.str.strip().str.lower()
    assert norm.nunique() < vals.nunique(), "no coding inconsistency planted"


# ── truth columns must never ship ────────────────────────────────────────────
@pytest.mark.parametrize("key", KEYS)
def test_no_truth_columns_leak_into_the_tape(built, key):
    p, a = built[key]
    leaked = [c for c in list(p.columns) + list(a.columns) if c.startswith("_truth")]
    assert not leaked, f"generative truth leaked into the shipped tape: {leaked}"


def test_true_dscr_never_ships_only_the_reported_one(built):
    p, a = built["cre"]
    assert "dscr" not in p.columns and "dscr" not in a.columns
    assert "dscr_reported" in p.columns


# ── the crisis, which is the reason the panel opens in 2008 ──────────────────
CRISIS_MULTIPLE = {"consumer": (2.0, 4.0), "mortgage": (3.5, 7.0), "cre": (4.0, 9.0)}


@pytest.mark.parametrize("key", ["consumer", "mortgage", "cre"])
def test_the_downturn_is_real_and_is_the_right_size(built, key):
    """Large enough to be evidence, small enough to be a number the asset class
    actually produced. At the pre-calibration parameters the extended window gave
    11.6%/yr on mortgage and 23.3%/yr on commercial real estate in 2009; neither
    has ever happened."""
    p, _ = built[key]
    yr = p.groupby(p.performance_date.dt.year).default_flag.mean().mul(1200)
    benign = yr.loc[yr.index.isin(range(2013, 2020))].mean()
    peak = yr.loc[yr.index.isin(range(2008, 2012))].max()
    lo, hi = CRISIS_MULTIPLE[key]
    assert lo <= peak / benign <= hi, f"{key}: {peak:.2f}/{benign:.2f} = {peak/benign:.1f}x"


@pytest.mark.parametrize("key", ["consumer", "mortgage", "cre"])
def test_the_2006_book_is_worse_than_the_2011_book(built, key):
    """Underwriting quality is a function of the vintage.

    Measured on the first 36 months on book so the comparison is like for like:
    a 2006 vintage would look worse than a 2011 one purely from having lived
    through 2009 at a higher age.
    """
    p, _ = built[key]                       # the assembled panel already carries vintage
    young = p[p.months_on_book <= 36]
    rate = young.groupby("vintage").default_flag.mean().mul(1200)
    loose = rate.loc[rate.index.isin((2006, 2007))].mean()
    tight = rate.loc[rate.index.isin((2011, 2012))].mean()
    assert loose > tight, f"{key}: 2006-07 {loose:.2f} vs 2011-12 {tight:.2f}"


def test_the_panel_opens_in_2008():
    """Not a cosmetic date. It is what puts the supervisory scenarios inside the
    fitted range — see docs/DECISIONS.md, 'The panel starts in 2008, not 2015'."""
    from creditiq.data.generate import PANEL_START
    assert PANEL_START == "2008-01-01"
