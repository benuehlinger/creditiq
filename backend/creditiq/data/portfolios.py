"""The three shipped portfolios, defined declaratively.

Signs are stated from the point of view of the log-odds of entering delinquency.
A positive coefficient raises credit risk.

Interaction signs are easy to get backwards, so the convention is written out
once here and every `Interaction.note` restates the economics in words:

    effect on log-odds  =  coef * z(driver) * z(mev)

    sensitivity to the MEV  =  mev_beta + coef * z(driver)

So to make a HIGH value of a driver MORE sensitive to a MEV whose own beta is
negative, the interaction coefficient must also be negative.
"""

from __future__ import annotations

import numpy as np

from . import copula as cp
from .copula import Marginal
from .spec import Interaction, PortfolioSpec, TargetDef


def _msa_weights() -> list[float]:
    """A realistic metro concentration: a few large ones, a long thin tail."""
    import numpy as _np
    n = len(MSA_LEVELS)
    # Zipf-ish but flattened. A raw 1/rank puts a quarter of the book in one
    # metro, which no real mortgage portfolio looks like — the largest MSA in a
    # national book is usually under 10%.
    w = 1.0 / _np.power(_np.arange(1, n + 1), 0.75)
    return list(w / w.sum())

# Metropolitan statistical areas, each mapped to its state.
#
# This exists to make the mortgage book genuinely HIGH CARDINALITY. A real
# mortgage tape carries a few hundred MSAs, most of them holding a fraction of a
# percent of the book, and that is the case where naive weight of evidence falls
# apart: a metro with eleven loans gets its own weight, and it is noise.
#
# Only a handful carry a real risk effect. The rest are deliberately empty, which
# is what makes the shrinkage and the small-sample null floor worth having — most
# of the apparent signal in a wide categorical is not signal.
MSA_STATE: dict[str, str] = {}
_MSA_SEED = [
    ("Los Angeles", "CA"), ("San Francisco", "CA"), ("San Diego", "CA"),
    ("Sacramento", "CA"), ("Riverside", "CA"), ("San Jose", "CA"), ("Fresno", "CA"),
    ("Houston", "TX"), ("Dallas", "TX"), ("Austin", "TX"), ("San Antonio", "TX"),
    ("El Paso", "TX"), ("Fort Worth", "TX"),
    ("Miami", "FL"), ("Orlando", "FL"), ("Tampa", "FL"), ("Jacksonville", "FL"),
    ("Cape Coral", "FL"), ("Sarasota", "FL"),
    ("New York", "NY"), ("Buffalo", "NY"), ("Rochester", "NY"), ("Albany", "NY"),
    ("Chicago", "IL"), ("Rockford", "IL"), ("Peoria", "IL"),
    ("Philadelphia", "PA"), ("Pittsburgh", "PA"), ("Allentown", "PA"),
    ("Cleveland", "OH"), ("Columbus", "OH"), ("Cincinnati", "OH"), ("Toledo", "OH"),
    ("Atlanta", "GA"), ("Savannah", "GA"), ("Augusta", "GA"),
    ("Charlotte", "NC"), ("Raleigh", "NC"), ("Greensboro", "NC"),
    ("Phoenix", "AZ"), ("Tucson", "AZ"), ("Mesa", "AZ"),
    ("Seattle", "WA"), ("Spokane", "WA"), ("Tacoma", "WA"),
    ("Detroit", "MI"), ("Grand Rapids", "MI"), ("Ann Arbor", "MI"),
]
for _name, _st in _MSA_SEED:
    MSA_STATE[f"{_name}, {_st}"] = _st
# pad out to a realistic tail of small metros, each holding well under 1%
for _i, (_name, _st) in enumerate(_MSA_SEED * 2):
    MSA_STATE[f"{_name} outlying {_i // len(_MSA_SEED) + 1}, {_st}"] = _st

MSA_LEVELS = list(MSA_STATE)

# The few metros that genuinely carry risk. Everything else is exactly zero, so
# any weight of evidence it appears to have is small-sample noise.
MSA_RISK: dict[str, float] = {
    "Las Vegas outlying 1, AZ": 0.0,      # placeholder, overwritten below
}
MSA_RISK = {
    "Riverside, CA": 0.34, "Cape Coral, FL": 0.31, "Miami, FL": 0.22,
    "Phoenix, AZ": 0.19, "Detroit, MI": 0.26, "Toledo, OH": 0.18,
    "San Jose, CA": -0.24, "Seattle, WA": -0.19, "Raleigh, NC": -0.16,
    "Austin, TX": -0.14,
}


# ── shared dynamics ──────────────────────────────────────────────────────────
def mortgage_dynamics(state: dict, mev: dict, mev0: dict) -> dict:
    """Current LTV, updated every month by the ACTUAL HPI path.

    This is the single most important dynamic in the mortgage book. The property
    value follows realised national HPI from origination to the performance date,
    and the balance amortises. Current LTV therefore carries the macro shock into
    the borrower's position, which is why a house-price stress moves mortgage PD
    through a channel a validator can trace, not through a bolted-on overlay.
    """
    hpi_ratio = mev["hpi"] / state["hpi_at_orig"]
    value_now = state["property_value"] * hpi_ratio
    cur_ltv = 100.0 * state["current_balance"] / np.maximum(value_now, 1.0)
    return {"current_ltv": np.clip(cur_ltv, 1.0, 250.0),
            "property_value_current": value_now,
            "cltv": np.clip(cur_ltv + state["second_lien_pct"], 1.0, 300.0)}


def cre_dynamics(state: dict, mev: dict, mev0: dict) -> dict:
    """NOI and DSCR, updated by the CRE price path and by property type.

    Office diverges after 2022 because its NOI follows the CRE index with extra
    leverage, which is the relationship the office segment illustrates.
    """
    idx_ratio = mev["cre_price_index"] / state["cre_index_at_orig"]
    lever = state["noi_beta"]                       # property-type NOI sensitivity
    noi_now = state["noi"] * np.power(np.maximum(idx_ratio, 0.05), lever)
    dscr_now = noi_now / np.maximum(state["annual_debt_service"], 1.0)
    ltv_now = 100.0 * state["current_balance"] / np.maximum(
        state["property_value"] * idx_ratio, 1.0)
    dscr_true = np.clip(dscr_now, 0.05, 6.0)
    # What the tape actually shows: a blend of the origination underwriting and
    # the current position, because financials arrive annually and late, plus
    # reporting noise. This is the column the model is allowed to use.
    dscr_rep = np.clip((0.45 * state["dscr_at_orig"] + 0.55 * dscr_true)
                       * state["dscr_report_noise"], 0.05, 6.0)
    return {"noi_current": noi_now,
            "dscr": dscr_true,
            "dscr_reported": dscr_rep,
            "current_ltv": np.clip(ltv_now, 1.0, 300.0)}


# ── consumer installment ─────────────────────────────────────────────────────
CONSUMER = PortfolioSpec(
    key="consumer",
    label="Consumer installment",
    # Three times the accounts at roughly two and a half times the loan size.
    # An installment book is structurally small at a point in time because the
    # loans are short and most have amortised away by the as-of date; at 50,000
    # accounts of $16k this book was a tenth of one percent of firm exposure and
    # could not be seen on the roll-up at all.
    n_accounts=150_000,
    accent_slot=1,
    target=TargetDef("default_flag", "90+ days past due or charge-off", 3, "90+ DPD"),
    ead_method="amortizing",
    ead_note=(
        "Amortizing product. EAD is the contractual scheduled balance at the "
        "default month, projected from the current balance, the note rate and the "
        "remaining term, with an optional prepayment (CPR) haircut. No CCF applies "
        "because there is no undrawn commitment."),
    marginals=[
        Marginal("fico_orig", cp.beta_scaled(5.0, 2.0, 520, 830), 0),
        Marginal("dti", cp.beta_scaled(2.2, 4.0, 3, 55), 1),
        Marginal("annual_income", cp.lognormal(np.log(85_000), 0.55), 0, 15_000, 900_000),
        Marginal("employment_tenure_months", cp.gamma(1.8, 40.0), 0, 0, 480),
        Marginal("revolving_utilization", cp.beta_scaled(1.6, 2.4, 0.0, 1.0), 3),
        Marginal("num_trades", cp.gamma(4.0, 2.5), 0, 0, 60),
        Marginal("inquiries_6m", cp.gamma(1.2, 1.3), 0, 0, 20),
        Marginal("prior_delinq_count", cp.gamma(0.7, 1.1), 0, 0, 15),
        Marginal("original_balance", cp.lognormal(np.log(55_000), 0.6), 0, 5_000, 400_000),
        Marginal("loan_purpose", cp.categorical(
            ["debt_consolidation", "home_improvement", "major_purchase", "medical", "other"],
            [0.42, 0.18, 0.20, 0.08, 0.12])),
        Marginal("channel", cp.categorical(["direct", "partner", "broker"],
                                           [0.50, 0.30, 0.20])),
    ],
    correlations={
        ("fico_orig", "dti"): -0.35,
        ("fico_orig", "revolving_utilization"): -0.45,
        ("fico_orig", "annual_income"): 0.28,
        ("fico_orig", "prior_delinq_count"): -0.42,
        ("fico_orig", "inquiries_6m"): -0.25,
        ("fico_orig", "employment_tenure_months"): 0.20,
        ("dti", "annual_income"): -0.30,
        ("dti", "revolving_utilization"): 0.32,
        ("annual_income", "original_balance"): 0.35,
        ("revolving_utilization", "prior_delinq_count"): 0.30,
        ("inquiries_6m", "num_trades"): 0.22,
    },
    intercept=-5.597,   # calibrated: 4.4%/yr realised
    frailty_sd=0.55,
    seasoning=(14.0, 0.55, 0.045),
    numeric_betas={
        "fico_orig": -0.55, "dti": 0.18, "annual_income": -0.08,
        "employment_tenure_months": -0.10, "revolving_utilization": 0.28,
        "num_trades": -0.04, "inquiries_6m": 0.12, "prior_delinq_count": 0.30,
    },
    categorical_betas={
        "loan_purpose": {"debt_consolidation": 0.12, "home_improvement": -0.08,
                         "major_purchase": 0.0, "medical": 0.15, "other": 0.05},
        "channel": {"direct": -0.05, "partner": 0.0, "broker": 0.14},
    },
    mev_keys=["unemployment_rate", "real_disp_income_growth"],
    mev_betas={"unemployment_rate": 0.32, "real_disp_income_growth": -0.10},
    interactions=[
        Interaction("revolving_utilization", "unemployment_rate", 0.14,
                    "A borrower already running high revolving utilization has no "
                    "buffer left when unemployment rises, so their PD moves more."),
        Interaction("fico_orig", "unemployment_rate", -0.12,
                    "Thin-file and low-FICO borrowers are hit harder by a labour "
                    "market shock. The negative sign makes a LOW FICO raise "
                    "sensitivity to a HIGH unemployment rate."),
    ],
    roll_forward=0.52,
    cure_base=0.30,
    prepay_intercept=-4.40,
    prepay_betas={"fico_orig": 0.26, "annual_income": 0.12, "interest_rate": 0.18},
    term_choices=(36, 48, 60, 72),
    term_probs=(0.18, 0.24, 0.38, 0.20),
    rate_base=0.129,
    rate_fico_slope=-0.055,
    # Unsecured. There is no collateral, so almost every default produces a loss
    # and severity is high: sigmoid(2.6) = 93% of defaults take a loss, and the
    # mean severity among those is sigmoid(1.45) = 81%.
    lgd_intercept=1.45,
    lgd_betas={"fico_orig": -0.10, "unemployment_rate": 0.14, "months_on_book": -0.06},
    lgd_zero_intercept=2.60,
        # Unsecured lending loosened into 2006-07 and the credit box shut hard in
    # 2009-11. The score shift is what a tape would show; the log-odds drift is
    # the exception rate and the stated-income share, which it would not.
    vintage_attr_shift={
        "fico_orig": {2005: -4.0, 2006: -7.0, 2007: -9.0, 2008: -4.0,
                      2010: 9.0, 2011: 12.0, 2012: 8.0},
        "dti": {2006: 1.6, 2007: 2.2, 2010: -1.8, 2011: -2.2},
    },
    vintage_logodds={2005: 0.08, 2006: 0.16, 2007: 0.22, 2008: 0.10,
                     2010: -0.10, 2011: -0.14, 2012: -0.10},
    expected_signs={
        "fico_orig": -1, "dti": 1, "annual_income": -1, "employment_tenure_months": -1,
        "revolving_utilization": 1, "num_trades": -1, "inquiries_6m": 1,
        "prior_delinq_count": 1, "unemployment_rate": 1, "real_disp_income_growth": -1,
    },
)

# ── mortgage ─────────────────────────────────────────────────────────────────
MORTGAGE = PortfolioSpec(
    key="mortgage",
    label="Residential mortgage",
    # Sized so a MONTH carries enough resolved workouts to average a severity.
    # The default RATE is unchanged — this is a bigger book, not a worse one.
    # At 40,000 accounts only 139 of 211 months cleared the floor, so the
    # severity chart was two thirds of a line.
    n_accounts=55_000,
    accent_slot=2,
    target=TargetDef("default_flag", "180+ days past due or foreclosure referral", 6,
                     "180+ DPD"),
    ead_method="amortizing",
    ead_note=(
        "Amortizing product. EAD is the contractual scheduled balance at the "
        "default month from the amortization schedule, with an optional CPR "
        "haircut and a small arrears uplift for accrued interest and advances."),
    marginals=[
        Marginal("fico_orig", cp.beta_scaled(6.0, 2.0, 580, 830), 0),
        Marginal("original_ltv", cp.beta_scaled(4.0, 2.2, 30, 97), 1),
        Marginal("dti", cp.beta_scaled(2.5, 4.0, 8, 50), 1),
        Marginal("annual_income", cp.lognormal(np.log(95_000), 0.60), 0, 20_000, 2_000_000),
        Marginal("original_balance", cp.lognormal(np.log(285_000), 0.55), 0,
                 40_000, 2_500_000),
        Marginal("second_lien_pct", cp.gamma(0.45, 8.0), 1, 0, 35),
        Marginal("doc_type", cp.categorical(["full", "alt", "low"], [0.82, 0.13, 0.05])),
        Marginal("occupancy", cp.categorical(["primary", "second", "investor"],
                                             [0.85, 0.06, 0.09])),
        Marginal("property_type", cp.categorical(["sfr", "condo", "townhouse", "2-4 unit"],
                                                 [0.72, 0.13, 0.11, 0.04])),
        Marginal("product", cp.categorical(["30yr fixed", "15yr fixed", "ARM 5/1"],
                                           [0.68, 0.19, 0.13])),
        Marginal("first_time_buyer", cp.categorical(["Y", "N"], [0.28, 0.72])),
        # Drawn on the copula like everything else, so it correlates with the
        # rest of the book rather than being an independent sprinkle. State is
        # DERIVED from it, because a loan's state is a property of its metro —
        # generating them independently would produce loans in Miami, Ohio.
        Marginal("msa", cp.categorical(MSA_LEVELS, _msa_weights())),
    ],
    correlations={
        ("fico_orig", "original_ltv"): -0.25,
        ("fico_orig", "dti"): -0.30,
        ("fico_orig", "annual_income"): 0.22,
        ("original_ltv", "dti"): 0.22,
        ("original_ltv", "first_time_buyer"): 0.30,
        ("original_ltv", "second_lien_pct"): 0.18,
        ("annual_income", "original_balance"): 0.55,
        ("fico_orig", "doc_type"): -0.20,
    },
    # ── Calibrated 2026-08 for the 2008-2025 window ──────────────────────────
    # Adding the financial crisis to the estimation window multiplied the crisis
    # amplitude of every macro channel. At the old parameters mortgage peaked at
    # 11.6%/yr in 2009 and commercial real estate at 23.3%/yr, which are not
    # numbers either asset class produced. The driver, macro, interaction and
    # vintage blocks were scaled down together so the SHAPE is unchanged and the
    # amplitude is credible; the intercept then restores the benign-period rate.
    intercept=-6.114,   # 1.0%/yr benign, 5.1%/yr peak (2009)
    frailty_sd=0.80,
    seasoning=(42.0, 0.50, 0.020),
    numeric_betas={
        "current_ltv": 0.384, "fico_orig": -0.260, "dti": 0.099, "annual_income": -0.037,
    },
    categorical_betas={
        "msa": MSA_RISK,
        "doc_type": {"full": -0.06, "alt": 0.18, "low": 0.42},
        "occupancy": {"primary": -0.08, "second": 0.12, "investor": 0.34},
        "product": {"30yr fixed": 0.0, "15yr fixed": -0.22, "ARM 5/1": 0.20},
        "first_time_buyer": {"Y": 0.10, "N": 0.0},
        "property_type": {"sfr": 0.0, "condo": 0.08, "townhouse": 0.03, "2-4 unit": 0.16},
    },
    mev_keys=["hpi_yoy", "unemployment_rate", "mortgage_rate"],
    mev_betas={"hpi_yoy": -0.165, "unemployment_rate": 0.187, "mortgage_rate": 0.028},
    interactions=[
        Interaction("current_ltv", "hpi_yoy", -0.209,
                    "A high-LTV borrower is far more sensitive to house prices than "
                    "a low-LTV one: little equity means a price fall pushes them "
                    "underwater. The negative sign makes a HIGH current LTV amplify "
                    "the response to a FALLING HPI."),
        Interaction("current_ltv", "unemployment_rate", 0.083,
                    "Negative equity plus a job loss is the classic double trigger. "
                    "Neither alone drives many defaults; together they drive most."),
    ],
    roll_forward=0.66,
    cure_base=0.26,
    prepay_intercept=-4.05,
    prepay_betas={"fico_orig": 0.30, "refi_incentive": 0.85, "current_ltv": -0.20},
    term_choices=(360, 180),
    term_probs=(0.81, 0.19),
    rate_base=0.052,
    rate_fico_slope=-0.030,
    # Secured by property, so severity is genuinely bimodal. A loan that defaults
    # with equity liquidates whole: sigmoid(0.25) = 56% of defaults take any loss
    # at all, leaving a large mass at exactly zero. Among those that do,
    # sigmoid(-0.85) = 30% mean severity. Both move with CLTV at default and with
    # how prices moved since origination.
    lgd_intercept=-0.85,
    lgd_betas={"cltv_at_default": 0.95, "hpi_change_since_orig": -0.70,
               "workout_months": 0.30},
    lgd_zero_intercept=0.25,
        # The vintage curve that defines the asset class. 2006 and 2007 are the two
    # weakest US mortgage vintages on record, and they performed worse than their
    # reported FICO and LTV alone account for. Documentation standards, silent
    # second liens and appraisal practice are not columns on a loan tape, so that
    # component appears only as a vintage effect.
    vintage_attr_shift={
        "original_ltv": {2004: 1.5, 2005: 3.5, 2006: 5.5, 2007: 4.5, 2008: 1.5,
                         2009: -3.0, 2010: -5.5, 2011: -6.0, 2012: -5.0},
        "fico_orig": {2005: -7.0, 2006: -13.0, 2007: -11.0, 2008: -4.0,
                      2010: 11.0, 2011: 14.0, 2012: 10.0},
        "second_lien_pct": {2005: 2.5, 2006: 5.0, 2007: 4.0, 2010: -2.0},
    },
    vintage_logodds={2004: 0.060, 2005: 0.132, 2006: 0.228, 2007: 0.204, 2008: 0.072,
                     2010: -0.096, 2011: -0.120, 2012: -0.090},
    expected_signs={
        "current_ltv": 1, "original_ltv": 1, "fico_orig": -1, "dti": 1,
        "annual_income": -1, "hpi_yoy": -1, "unemployment_rate": 1,
        "mortgage_rate": 1, "hpi": -1,
    },
    dynamics=mortgage_dynamics,
)

# ── commercial real estate ───────────────────────────────────────────────────
CRE = PortfolioSpec(
    key="cre",
    label="Commercial real estate",
    # Commercial books resolve few workouts, and at 7,000 loans this one filled
    # SEVEN of 158 months. Tens of thousands of loans is the top of the plausible
    # range rather than outside it, at the same default rate.
    #
    # Sized as SMALL-BALANCE commercial: a median commitment near $675k rather
    # than the $14M of a large-institutional book. At $14M this one book was 96%
    # of the firm's exposure, so the roll-up was a CRE chart with two invisible
    # slivers on it. Commitment and net operating income were scaled together,
    # which leaves loan-to-value, debt service coverage and utilisation exactly
    # as they were: property value is balance over LTV, and debt service is NOI
    # over DSCR.
    n_accounts=45_000,
    accent_slot=3,
    target=TargetDef("default_flag", "Nonaccrual or downgrade to a default grade", 3,
                     "Nonaccrual"),
    ead_method="ccf",
    ead_note=(
        "Revolving and committed facilities. EAD = drawn + CCF x undrawn. The CCF "
        "is estimated from this portfolio with the fixed-horizon 12-month cohort "
        "method: take a cohort of non-defaulted facilities and observe the "
        "drawdown over the twelve months before default. A regulatory-style fixed "
        "CCF is available as a toggle. Term loans in the book carry no undrawn "
        "commitment and fall back to the amortizing treatment."),
    marginals=[
        Marginal("dscr_orig", cp.beta_scaled(3.0, 3.0, 0.85, 2.60), 2),
        Marginal("original_ltv", cp.beta_scaled(3.5, 2.5, 30, 80), 1),
        Marginal("noi", cp.lognormal(np.log(68_000), 0.70), 0, 4_500, 3_200_000),
        Marginal("risk_rating", cp.beta_scaled(2.6, 3.2, 1, 10), 0),
        Marginal("lease_rollover_pct", cp.beta_scaled(2.0, 4.0, 0, 60), 1),
        Marginal("committed_amount", cp.lognormal(np.log(500_000), 0.75), 0,
                 27_000, 14_000_000),
        Marginal("property_type", cp.categorical(
            ["office", "retail", "industrial", "multifamily", "hospitality"],
            [0.24, 0.19, 0.18, 0.30, 0.09])),
        Marginal("facility_type", cp.categorical(["term loan", "revolver"], [0.72, 0.28])),
        Marginal("guarantor_flag", cp.categorical(["Y", "N"], [0.45, 0.55])),
        Marginal("region", cp.categorical(
            ["Northeast", "Southeast", "Midwest", "Southwest", "West"],
            [0.22, 0.24, 0.16, 0.15, 0.23])),
        Marginal("industry", cp.categorical(
            ["Real estate", "Retail trade", "Hospitality", "Healthcare", "Logistics"],
            [0.46, 0.15, 0.11, 0.13, 0.15])),
    ],
    correlations={
        ("dscr_orig", "original_ltv"): -0.42,
        ("dscr_orig", "risk_rating"): -0.55,
        ("original_ltv", "risk_rating"): 0.40,
        ("noi", "committed_amount"): 0.62,
        ("dscr_orig", "lease_rollover_pct"): -0.18,
        ("risk_rating", "lease_rollover_pct"): 0.22,
        ("risk_rating", "guarantor_flag"): 0.15,
    },
    # ── Calibrated 2026-08 for the 2008-2025 window ──────────────────────────
    # Adding the financial crisis to the estimation window multiplied the crisis
    # amplitude of every macro channel. At the old parameters mortgage peaked at
    # 11.6%/yr in 2009 and commercial real estate at 23.3%/yr, which are not
    # numbers either asset class produced. The driver, macro, interaction and
    # vintage blocks were scaled down together so the SHAPE is unchanged and the
    # amplitude is credible; the intercept then restores the benign-period rate.
    intercept=-6.507,   # 0.9%/yr benign, 5.9%/yr peak (2009)
    frailty_sd=0.90,
    seasoning=(48.0, 0.40, 0.015),
    numeric_betas={
        "dscr": -0.248, "current_ltv": 0.171, "risk_rating": 0.189,
        "lease_rollover_pct": 0.072,
    },
    categorical_betas={
        "property_type": {"office": 0.15, "retail": 0.08, "industrial": -0.12,
                          "multifamily": -0.10, "hospitality": 0.20},
        "facility_type": {"term loan": 0.0, "revolver": 0.05},
        "guarantor_flag": {"Y": -0.22, "N": 0.0},
    },
    mev_keys=["cre_price_index_yoy", "bbb_yield", "real_gdp_growth"],
    # Damped from an earlier draft. The CRE price index YoY swings from +15.6%
    # to -10.7% over the window, which is a 4-standard-deviation range. At the
    # original betas the macro block alone moved the hazard by more than two
    # log-odds, which produced near-zero defaults through 2022 and then a 15%
    # office default rate in 2024. Real books do not have a seven-year gap with
    # no losses. The divergence is preserved; only its amplitude is reduced.
    mev_betas={"cre_price_index_yoy": -0.106, "bbb_yield": 0.086,
               "real_gdp_growth": -0.058},
    interactions=[
        Interaction("property_type", "cre_price_index_yoy", -0.240,
                    "Office is more exposed to the commercial property cycle than "
                    "the other segments. This term produces the divergence in "
                    "office performance after 2022.", level="office"),
        Interaction("dscr", "cre_price_index_yoy", 0.058,
                    "A thin-DSCR facility has no cushion, so it responds more to a "
                    "fall in property values. The positive sign strengthens the "
                    "response for a LOW DSCR."),
        Interaction("current_ltv", "cre_price_index_yoy", -0.048,
                    "High leverage amplifies the effect of a property price fall."),
    ],
    roll_forward=0.55,
    cure_base=0.28,
    prepay_intercept=-4.90,
    prepay_betas={"dscr": 0.30, "risk_rating": -0.25},
    term_choices=(60, 84, 120),
    term_probs=(0.44, 0.34, 0.22),
    rate_base=0.058,
    rate_fico_slope=0.0,
    # Secured but illiquid, with long workouts and higher severity than
    # residential: sigmoid(1.15) = 76% of defaults take a loss, mean severity
    # among those sigmoid(-0.40) = 40%. A guarantor materially reduces both.
    lgd_intercept=-0.40,
    lgd_betas={"current_ltv": 0.85, "cre_index_change_since_orig": -0.80,
               "workout_months": 0.35, "guarantor_flag": -0.30},
    lgd_zero_intercept=1.15,
    observed_aliases={"dscr": "dscr_reported"},
        # 2006-07 commercial originations underwrote to pro-forma income and exit cap
    # rates that never arrived. The reported coverage looked adequate at the time
    # because the income in it had not been earned yet.
    vintage_attr_shift={
        "original_ltv": {2005: 2.0, 2006: 4.0, 2007: 5.0, 2008: 2.0,
                         2010: -4.0, 2011: -5.0, 2012: -4.0},
        "dscr_orig": {2006: -0.10, 2007: -0.15, 2010: 0.12, 2011: 0.15},
    },
    vintage_logodds={2005: 0.055, 2006: 0.110, 2007: 0.154, 2008: 0.066,
                     2010: -0.066, 2011: -0.088, 2012: -0.066},
    expected_signs={
        "dscr_reported": -1, "current_ltv": 1, "original_ltv": 1, "risk_rating": 1,
        "lease_rollover_pct": 1, "cre_price_index_yoy": -1, "bbb_yield": 1,
        "real_gdp_growth": -1,
    },
    dynamics=cre_dynamics,
)

PORTFOLIOS: dict[str, PortfolioSpec] = {p.key: p for p in (CONSUMER, MORTGAGE, CRE)}

# NOI sensitivity to the CRE price index, by property type. Office carries the
# highest leverage, which is the mechanism behind its post-2022 divergence.
CRE_NOI_BETA = {"office": 1.35, "retail": 0.85, "industrial": 0.55,
                "multifamily": 0.60, "hospitality": 1.05}
