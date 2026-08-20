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
    leverage, which is what the room will look for.
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
    n_accounts=50_000,
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
        Marginal("annual_income", cp.lognormal(np.log(72_000), 0.55), 0, 12_000, 900_000),
        Marginal("employment_tenure_months", cp.gamma(1.8, 40.0), 0, 0, 480),
        Marginal("revolving_utilization", cp.beta_scaled(1.6, 2.4, 0.0, 1.0), 3),
        Marginal("num_trades", cp.gamma(4.0, 2.5), 0, 0, 60),
        Marginal("inquiries_6m", cp.gamma(1.2, 1.3), 0, 0, 20),
        Marginal("prior_delinq_count", cp.gamma(0.7, 1.1), 0, 0, 15),
        Marginal("original_balance", cp.lognormal(np.log(16_000), 0.6), 0, 1_500, 100_000),
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
    n_accounts=40_000,
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
        Marginal("state", cp.categorical(
            ["CA", "TX", "FL", "NY", "IL", "PA", "OH", "GA", "NC", "AZ", "WA", "MI"],
            [0.16, 0.12, 0.10, 0.08, 0.06, 0.06, 0.05, 0.06, 0.06, 0.05, 0.06, 0.04])),
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
    intercept=-6.014,   # calibrated: 1.25%/yr realised
    frailty_sd=0.50,
    seasoning=(42.0, 0.50, 0.020),
    numeric_betas={
        "current_ltv": 0.62, "fico_orig": -0.42, "dti": 0.16, "annual_income": -0.06,
    },
    categorical_betas={
        "doc_type": {"full": -0.06, "alt": 0.18, "low": 0.42},
        "occupancy": {"primary": -0.08, "second": 0.12, "investor": 0.34},
        "product": {"30yr fixed": 0.0, "15yr fixed": -0.22, "ARM 5/1": 0.20},
        "first_time_buyer": {"Y": 0.10, "N": 0.0},
        "property_type": {"sfr": 0.0, "condo": 0.08, "townhouse": 0.03, "2-4 unit": 0.16},
    },
    mev_keys=["hpi_yoy", "unemployment_rate", "mortgage_rate"],
    mev_betas={"hpi_yoy": -0.30, "unemployment_rate": 0.34, "mortgage_rate": 0.05},
    interactions=[
        Interaction("current_ltv", "hpi_yoy", -0.38,
                    "A high-LTV borrower is far more sensitive to house prices than "
                    "a low-LTV one: little equity means a price fall pushes them "
                    "underwater. The negative sign makes a HIGH current LTV amplify "
                    "the response to a FALLING HPI."),
        Interaction("current_ltv", "unemployment_rate", 0.15,
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
    expected_signs={
        "current_ltv": 1, "original_ltv": 1, "fico_orig": -1, "dti": 1,
        "annual_income": -1, "hpi_yoy": -1, "unemployment_rate": 1, "mortgage_rate": 1,
    },
    dynamics=mortgage_dynamics,
)

# ── commercial real estate ───────────────────────────────────────────────────
CRE = PortfolioSpec(
    key="cre",
    label="Commercial real estate",
    n_accounts=7_000,
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
        Marginal("noi", cp.lognormal(np.log(1_900_000), 0.70), 0, 120_000, 90_000_000),
        Marginal("risk_rating", cp.beta_scaled(2.6, 3.2, 1, 10), 0),
        Marginal("lease_rollover_pct", cp.beta_scaled(2.0, 4.0, 0, 60), 1),
        Marginal("committed_amount", cp.lognormal(np.log(14_000_000), 0.75), 0,
                 750_000, 400_000_000),
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
    intercept=-6.207,   # calibrated: 2.0%/yr realised
    frailty_sd=0.60,
    seasoning=(48.0, 0.40, 0.015),
    numeric_betas={
        "dscr": -0.55, "current_ltv": 0.38, "risk_rating": 0.42,
        "lease_rollover_pct": 0.16,
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
    mev_betas={"cre_price_index_yoy": -0.22, "bbb_yield": 0.18,
               "real_gdp_growth": -0.12},
    interactions=[
        Interaction("property_type", "cre_price_index_yoy", -0.30,
                    "Office is far more exposed to the commercial property cycle "
                    "than the other segments. This term is what produces the "
                    "post-2022 divergence the room will look for.", level="office"),
        Interaction("dscr", "cre_price_index_yoy", 0.12,
                    "A thin-DSCR facility has no cushion, so it responds more to a "
                    "fall in property values. The positive sign strengthens the "
                    "response for a LOW DSCR."),
        Interaction("current_ltv", "cre_price_index_yoy", -0.10,
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
