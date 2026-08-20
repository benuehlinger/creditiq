"""Turn raw generator output into the shipped loan tape.

Three jobs:

1. Build the columns a real performance file carries — status, terminal event,
   delinquency bucket labels, EAD, realised recovery and loss.

2. Realise LGD for defaulted accounts through a TWO-STAGE process, so the
   severity distribution has the boundary mass at zero that real workout data
   has. A single beta draw gives a smooth unimodal severity that no recovery
   analyst recognises.

3. PLANT the imperfections the Explore surface exists to catch. These are
   deliberate and documented. A clean tape gives the data-quality step and the
   leakage guardrail nothing to do, and the demo script opens on the guardrail.

Every truth column is stripped here. What leaves this module is what a client
would actually receive.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .generate import GenerationResult
from .spec import PortfolioSpec

DELINQ_LABELS = ["Current", "30 DPD", "60 DPD", "90 DPD", "120 DPD", "150 DPD",
                 "180+ DPD"]


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def realise_lgd(panel: pd.DataFrame, accounts: pd.DataFrame, spec: PortfolioSpec,
                rng: np.random.Generator) -> pd.DataFrame:
    """Loss given default on the defaulted account-months, in two stages.

    Stage 1  P(loss > 0)   — a share of defaults cure or liquidate whole, with no
                             economic loss. This is the mass at zero that makes a
                             real severity distribution bimodal.
    Stage 2  E[loss | >0]  — a beta draw whose mean is driven by the collateral
                             position at default and the macro at default.

    A mortgage that defaults with 60% CLTV in a rising market usually recovers in
    full. The same loan at 110% CLTV in a falling market does not. Modelling that
    as one smooth distribution is the most common LGD shortcut and a validator
    will ask about the zero mass first.
    """
    d = panel.index[panel["default_flag"] == 1]
    n = len(d)
    out = pd.DataFrame(index=panel.index,
                       columns=["lgd_realised", "recovery_amount", "loss_amount",
                                "workout_months"], dtype=float)
    if n == 0:
        return out.fillna(0.0)

    sub = panel.loc[d]
    ead = sub["exposure_at_default"].to_numpy(float)

    # workout duration — longer workouts cost more
    workout = np.clip(rng.gamma(3.0, 4.0, n) + (6.0 if spec.key == "mortgage" else 2.0),
                      1, 60)

    z = np.zeros(n)

    # MACRO AT DEFAULT. Without this the realised severity carries no
    # relationship to the cycle, and a model fitted on it produces a downturn LGD
    # that does not move — which the brief singles out as the most common thing a
    # validator catches. It was missing from the first draft of this function:
    # the coefficients were declared on the portfolio spec and never applied, so
    # the attribution bridge showed an LGD contribution of almost exactly zero.
    from ..mev.panel import monthly_panel
    mev = monthly_panel()
    when = pd.DatetimeIndex(sub["performance_date"]).to_period("M").to_timestamp()
    if spec.key == "consumer":
        u = mev["unemployment_rate"].reindex(when).to_numpy(float)
        # unsecured recoveries depend on the borrower's ability to pay after
        # default, which collapses with the labour market
        z += 0.13 * np.nan_to_num(u - 5.5, nan=0.0)
    elif spec.key == "mortgage":
        g = mev["hpi_yoy"].reindex(when).to_numpy(float)
        # falling house prices cut the liquidation value directly
        z += -0.075 * np.nan_to_num(g - 5.0, nan=0.0)
    elif spec.key == "cre":
        g = mev["cre_price_index_yoy"].reindex(when).to_numpy(float)
        z += -0.060 * np.nan_to_num(g - 3.0, nan=0.0)

    if spec.key == "mortgage":
        cltv = sub["cltv"].to_numpy(float) if "cltv" in sub else sub["current_ltv"].to_numpy(float)
        z += 0.030 * (cltv - 80.0)
    elif spec.key == "cre":
        z += 0.028 * (sub["current_ltv"].to_numpy(float) - 65.0)
        g = accounts.set_index("account_id")["guarantor_flag"].reindex(
            sub["account_id"]).to_numpy()
        z += np.where(g == "Y", -0.30, 0.0)
    else:
        f = accounts.set_index("account_id")["fico_orig"].reindex(
            sub["account_id"]).to_numpy(float)
        z += -0.006 * (f - 700.0)
    z += 0.02 * (workout - 12.0)

    # stage 1 — is there any loss at all?
    p_loss = _sigmoid(spec.lgd_zero_intercept + z + rng.normal(0, 0.5, n))
    has_loss = rng.random(n) < p_loss

    # stage 2 — severity conditional on loss, as a beta with a driven mean
    mean_sev = np.clip(_sigmoid(spec.lgd_intercept + z), 0.03, 0.97)
    conc = 6.0
    sev = rng.beta(mean_sev * conc, (1 - mean_sev) * conc, n)
    lgd = np.where(has_loss, np.clip(sev, 0.0, 1.0), 0.0)

    out.loc[d, "lgd_realised"] = lgd
    out.loc[d, "loss_amount"] = lgd * ead
    out.loc[d, "recovery_amount"] = (1.0 - lgd) * ead
    out.loc[d, "workout_months"] = workout
    return out.fillna(0.0)


def assemble(res: GenerationResult, seed: int = 7) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The shipped panel and account tables."""
    rng = np.random.default_rng(seed)
    spec = res.spec
    p = res.panel.copy()
    a = res.accounts.copy()

    p = p.merge(a[["account_id", "origination_date", "original_balance",
                   "interest_rate", "original_term", "scheduled_payment", "vintage",
                   "committed_amount"]], on="account_id", how="left")

    p["remaining_term"] = (p["original_term"] - p["months_on_book"]).clip(lower=0)
    p["delinquency_bucket"] = pd.Categorical(
        [DELINQ_LABELS[min(s, len(DELINQ_LABELS) - 1)] for s in p["delinquency_state"]],
        categories=DELINQ_LABELS, ordered=True)

    term_ev = np.where(p["default_flag"] == 1, "default",
              np.where(p["prepaid_flag"] == 1, "payoff",
              np.where(p["matured_flag"] == 1, "matured", "none")))
    p["terminal_event"] = term_ev
    p["status"] = np.where(p["default_flag"] == 1, "Defaulted",
                  np.where(p["prepaid_flag"] == 1, "Paid off",
                  np.where(p["matured_flag"] == 1, "Matured",
                  np.where(p["delinquency_state"] > 0, "Delinquent", "Current"))))

    # exposure at default: the actual exposure carried into the default month
    p["exposure_at_default"] = np.where(p["default_flag"] == 1, p["current_balance"], 0.0)
    if spec.ead_method == "ccf":
        p["undrawn_amount"] = (p["committed_amount"] - p["drawn_amount"]).clip(lower=0)
        p["utilisation"] = (p["drawn_amount"] / p["committed_amount"].clip(lower=1)).clip(0, 1)
    else:
        # An amortizing product has no undrawn commitment. Shipping an
        # all-zero undrawn column would invite a CCF question that does not apply.
        p = p.drop(columns=[c for c in ("committed_amount", "committed_amount_t",
                                        "drawn_amount") if c in p.columns])

    lgd = realise_lgd(p, a, spec, rng)
    p = pd.concat([p, lgd], axis=1)

    # the last observation of a still-open account is right-censored
    last = p.groupby("account_id")["performance_date"].transform("max")
    open_at_end = (p["terminal_event"] == "none") & (p["performance_date"] == last)
    p.loc[open_at_end, "terminal_event"] = "censored"

    p = p.drop(columns=[c for c in p.columns
                        if c.startswith("_truth") or c in ("prepaid_flag", "matured_flag")])
    a = a.drop(columns=[c for c in a.columns if c.startswith("_truth")])

    # the true DSCR never leaves the building; only the reported one does
    for true_col in spec.observed_aliases:
        if true_col in p.columns:
            p = p.drop(columns=[true_col])

    p, a = plant_imperfections(p, a, spec, rng)
    order = ["account_id", "performance_date", "origination_date", "months_on_book",
             "vintage", "original_balance", "current_balance", "scheduled_payment",
             "interest_rate", "original_term", "remaining_term", "delinquency_bucket",
             "status", "terminal_event", "default_flag", "recovery_amount",
             "loss_amount", "exposure_at_default"]
    rest = [c for c in p.columns if c not in order]
    return p[[c for c in order if c in p.columns] + rest], a


# ── the planted imperfections ────────────────────────────────────────────────
PLANTED = {
    "consumer": {
        "missing_30pct": "employment_tenure_months",
        "missing_mar": "revolving_utilization",
        "noise": ["marketing_segment_code", "branch_id_numeric", "app_channel_score"],
        "leakage": "collections_referral_flag",
        "collinear_of": "fico_orig",
        "collinear_name": "fico_refreshed",
        "messy_categorical": "channel",
    },
    "mortgage": {
        "missing_30pct": "second_lien_pct",
        "missing_mar": "dti",
        "noise": ["appraisal_vendor_code", "loan_officer_id_numeric", "doc_batch_seq"],
        "leakage": "foreclosure_referral_flag",
        "collinear_of": "original_ltv",
        "collinear_name": "cltv_at_origination",
        "messy_categorical": "state",
    },
    "cre": {
        "missing_30pct": "lease_rollover_pct",
        "missing_mar": "noi",
        "noise": ["appraiser_panel_code", "relationship_manager_id", "doc_package_seq"],
        "leakage": "watchlist_transfer_flag",
        "collinear_of": "original_ltv",
        "collinear_name": "ltv_at_appraisal",
        "messy_categorical": "region",
    },
}


def plant_imperfections(p: pd.DataFrame, a: pd.DataFrame, spec: PortfolioSpec,
                        rng: np.random.Generator) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Deliberate defects, documented in the data dictionary.

    Each one exists so a specific guardrail has something to catch:
      * a near-leakage flag with an absurd IV, for the leakage warning
      * pure-noise columns, for the IV screen
      * a >0.95 correlated pair, for the multicollinearity screen
      * missing patterns, one MCAR and one MAR, for the imputation step
      * inconsistent categorical coding, for the cleaning recipe
      * outliers and one impossible value, for the integrity validator
    """
    cfg = PLANTED[spec.key]
    n_a, n_p = len(a), len(p)

    # 1. LEAKAGE. A collections referral is raised days before the account is
    #    charged off, so it is a near-perfect predictor and is not knowable at
    #    the decision point. IV lands far above 0.8 and the guardrail must fire.
    lk = np.zeros(n_p, dtype=np.int8)
    is_def = (p["default_flag"] == 1).to_numpy()
    lk[is_def] = (rng.random(is_def.sum()) < 0.93).astype(np.int8)
    healthy = ~is_def
    lk[healthy] = (rng.random(healthy.sum()) < 0.004).astype(np.int8)
    p[cfg["leakage"]] = lk

    # 2. PURE NOISE. Operational codes with no credit content. IV < 0.02.
    p[cfg["noise"][0]] = rng.integers(100, 999, n_p)
    a[cfg["noise"][1]] = rng.integers(1000, 9999, n_a)
    a[cfg["noise"][2]] = np.round(rng.normal(50, 12, n_a), 2)

    # 3. COLLINEAR PAIR above 0.95 — a refreshed score sitting beside the
    #    original one.
    base = a[cfg["collinear_of"]].to_numpy(float)
    a[cfg["collinear_name"]] = np.round(base + rng.normal(0, base.std() * 0.14, n_a), 1)

    # 4. MISSINGNESS. One column near 30% MCAR; one MAR, where the probability of
    #    being missing depends on another observed column.
    col = cfg["missing_30pct"]
    if col in a.columns:
        a.loc[rng.random(n_a) < 0.30, col] = np.nan
    mar = cfg["missing_mar"]
    tgt = a if mar in a.columns else p
    if mar in tgt.columns:
        driver = tgt["original_balance"] if "original_balance" in tgt else None
        prob = 0.06 + 0.18 * (driver.rank(pct=True) if driver is not None else 0.5)
        tgt.loc[rng.random(len(tgt)) < prob, mar] = np.nan

    # 5. INCONSISTENT CATEGORICAL CODING — the same level spelled three ways.
    mc = cfg["messy_categorical"]
    if mc in a.columns:
        vals = a[mc].astype(str).to_numpy(dtype=object)
        lvl = pd.Series(vals).mode().iloc[0]
        hit = np.flatnonzero(vals == lvl)
        pick = rng.permutation(hit)
        k = len(pick) // 6
        vals[pick[:k]] = lvl.lower()
        vals[pick[k:2 * k]] = f" {lvl} "
        if mc == "state":
            names = {"CA": "California", "TX": "Texas", "FL": "Florida", "NY": "New York"}
            if lvl in names:
                vals[pick[2 * k:3 * k]] = names[lvl]
        a[mc] = vals

    # 6. OUTLIERS AND ONE IMPOSSIBLE VALUE. The integrity validator must catch a
    #    negative balance and a DTI that cannot exist.
    if "dti" in a.columns:
        a.loc[a.index[rng.integers(0, n_a)], "dti"] = 900.0
    bad = p.index[rng.integers(0, n_p)]
    p.loc[bad, "current_balance"] = -1250.75
    if "annual_income" in a.columns:
        hi = rng.choice(n_a, 5, replace=False)
        a.loc[a.index[hi], "annual_income"] = a["annual_income"].max() * 25

    return p, a
