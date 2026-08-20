"""`make data` — regenerate every synthetic panel, deterministically.

Writes, per portfolio:
  data/synthetic/<key>_panel.parquet        the loan-level monthly tape
  data/synthetic/<key>_accounts.parquet     one row per account
  data/synthetic/<key>_sample.csv           a readable 5,000-row sample
  data/synthetic/<key>_dictionary.md        the data dictionary
and one docs/GENERATIVE_TRUTH.md covering all three.

Determinism: one fixed seed per portfolio. Same seed, same bytes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from .assemble import assemble
from .generate import generate
from .portfolios import PORTFOLIOS
from .spec import PortfolioSpec

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "data" / "synthetic"
DOCS = ROOT / "docs"
SEEDS = {"consumer": 20260819, "mortgage": 20260820, "cre": 20260821}

DESCRIPTIONS: dict[str, str] = {
    "account_id": "Account identifier. Unique per account, repeated across performance dates.",
    "performance_date": "Observation month. The panel is one row per account per month.",
    "origination_date": "Month the account was booked.",
    "months_on_book": "Months elapsed since origination at this performance date.",
    "vintage": "Origination year. The standard cohort dimension.",
    "original_balance": "Balance at origination, USD.",
    "current_balance": "Balance outstanding at this performance date, USD.",
    "scheduled_payment": "Contractual monthly payment, USD.",
    "interest_rate": "Note rate, annual decimal (0.089 = 8.9%).",
    "original_term": "Contractual term at origination, months.",
    "remaining_term": "Contractual months left at this performance date.",
    "delinquency_bucket": "Delinquency status: Current, 30, 60, 90, 120, 150, 180+ DPD. "
                          "A BEHAVIOURAL variable — exclude it from an origination "
                          "scorecard, where it is not knowable at the decision point.",
    "delinquency_state": "Numeric form of delinquency_bucket (0 = Current).",
    "status": "Current / Delinquent / Defaulted / Paid off / Matured.",
    "terminal_event": "none | default | payoff | matured | censored. The account "
                      "carries no rows after a terminal event.",
    "default_flag": "TARGET. 1 in the month the default definition is met, else 0.",
    "recovery_amount": "Cash recovered on a defaulted account, USD.",
    "loss_amount": "Economic loss on a defaulted account, USD.",
    "exposure_at_default": "Exposure carried into the default month, USD. Zero otherwise.",
    "lgd_realised": "Realised loss given default, 0-1. Zero for defaults that "
                    "liquidated whole.",
    "workout_months": "Months from default to resolution.",
    "drawn_amount": "Drawn balance on a committed facility, USD.",
    "committed_amount": "Total commitment, USD.",
    "undrawn_amount": "Commitment less drawn, USD. The CCF applies to this.",
    "utilisation": "Drawn divided by committed, 0-1.",
    "current_ltv": "Loan to value at this performance date, updated by the actual "
                   "house price path since origination.",
    "cltv": "Combined LTV including junior liens.",
    "property_value_current": "Property value marked to the HPI path, USD.",
    "dscr_reported": "Debt service coverage ratio AS REPORTED on the tape. Borrower-"
                     "sourced from annual financials, so it is stale and noisy — a "
                     "blend of origination underwriting and the current position.",
    "noi_current": "Net operating income marked to the property price path, USD.",
}

PLANTED_NOTES: dict[str, str] = {
    "collections_referral_flag": "PLANTED LEAKAGE. Raised days before charge-off, so "
        "it is not knowable at the decision point. Expect IV far above 0.8. The "
        "Explore surface must flag this rather than accept it.",
    "foreclosure_referral_flag": "PLANTED LEAKAGE. Raised at the point of foreclosure "
        "referral. Expect IV far above 0.8.",
    "watchlist_transfer_flag": "PLANTED LEAKAGE. Raised when the facility moves to "
        "special servicing. Expect IV far above 0.8.",
    "marketing_segment_code": "PLANTED NOISE. Operational code, no credit content. "
                              "Expect IV below 0.02.",
    "branch_id_numeric": "PLANTED NOISE. Expect IV below 0.02.",
    "app_channel_score": "PLANTED NOISE. Expect IV below 0.02.",
    "appraisal_vendor_code": "PLANTED NOISE. Expect IV below 0.02.",
    "loan_officer_id_numeric": "PLANTED NOISE. Expect IV below 0.02.",
    "doc_batch_seq": "PLANTED NOISE. Expect IV below 0.02.",
    "appraiser_panel_code": "PLANTED NOISE. Expect IV below 0.02.",
    "relationship_manager_id": "PLANTED NOISE. Expect IV below 0.02.",
    "doc_package_seq": "PLANTED NOISE. Expect IV below 0.02.",
    "fico_refreshed": "PLANTED COLLINEARITY. Correlates above 0.95 with fico_orig. "
                      "The multicollinearity screen must catch the pair.",
    "cltv_at_origination": "PLANTED COLLINEARITY. Correlates above 0.95 with "
                           "original_ltv.",
    "ltv_at_appraisal": "PLANTED COLLINEARITY. Correlates above 0.95 with original_ltv.",
}


def _dictionary(spec: PortfolioSpec, panel: pd.DataFrame,
                accounts: pd.DataFrame) -> str:
    lines = [f"# Data dictionary — {spec.label}", "",
             "**Synthetic demonstration data.** Generated by a monthly discrete-time",
             "hazard process driven by real FRED macroeconomic history. It is not any",
             "institution's portfolio and must never be presented as one.", "",
             f"- Accounts: {len(accounts):,}",
             f"- Account-month rows: {len(panel):,}",
             f"- Window: {panel['performance_date'].min():%Y-%m} to "
             f"{panel['performance_date'].max():%Y-%m}",
             f"- Target: `default_flag` — {spec.target.description}",
             f"- EAD method: {spec.ead_method} — {spec.ead_note}", ""]

    for title, df in (("Panel columns", panel), ("Account columns", accounts)):
        lines += [f"## {title}", "",
                  "| Column | Type | Missing | Description |",
                  "|---|---|---|---|"]
        for c in df.columns:
            miss = f"{df[c].isna().mean():.1%}"
            desc = DESCRIPTIONS.get(c) or PLANTED_NOTES.get(c) or _auto_desc(c, spec)
            lines.append(f"| `{c}` | {df[c].dtype} | {miss} | {desc} |")
        lines.append("")

    lines += ["## Deliberate imperfections", "",
              "These are planted so the data-quality and variable-screening steps have",
              "something real to catch. Every one is listed above with a PLANTED note.",
              "", "- one near-leakage flag with IV far above 0.8",
              "- three pure-noise columns with IV below 0.02",
              "- one correlated pair above 0.95",
              "- one column about 30% missing (MCAR) and one missing-at-random column",
              "- inconsistent categorical coding (the same level spelled several ways)",
              "- outliers, plus one impossible DTI and one negative balance", ""]
    return "\n".join(lines)


def _auto_desc(col: str, spec: PortfolioSpec) -> str:
    if col in spec.numeric_betas:
        s = spec.expected_signs.get(col)
        d = {1: "higher raises risk", -1: "higher reduces risk"}.get(s, "")
        return f"Credit driver. {d}".strip()
    if col in spec.categorical_betas:
        return "Categorical credit driver."
    return "Account attribute."


def truth_doc() -> str:
    """docs/GENERATIVE_TRUTH.md — the answer key."""
    L = ["# Generative truth", "",
         "Every coefficient that produced the synthetic data, so what Helios recovers",
         "can be checked against what actually generated it. This file is written",
         "directly from `helios/data/portfolios.py` — it cannot drift from the code.",
         "",
         "## How the data is made", "",
         "For each account-month, the log-odds of rolling from current into",
         "delinquency is", "",
         "```",
         "logit(h_it) = intercept + seasoning(age) + B'x_i + G'z_t + D'(x_i (x) z_t) + u_i",
         "```", "",
         "`z_t` is REAL macroeconomic history from FRED, not a simulated path. `u_i` is",
         "an account-level frailty term standing for unobserved borrower quality; it is",
         "what holds AUC in a credible band instead of near 1.0. Default is then",
         "reached through a delinquency chain (30 -> 60 -> 90 ...), so the observed",
         "default rate is an emergent property of the process, not a drawn quantity.",
         "", "Prepayment and maturity compete with default. The account stops at the",
         "first terminal event.", ""]
    for spec in PORTFOLIOS.values():
        L += [f"## {spec.label} (`{spec.key}`)", "",
              f"- Accounts: {spec.n_accounts:,}",
              f"- Target: {spec.target.description} (delinquency state {spec.target.dpd_state})",
              f"- Intercept: `{spec.intercept}` (calibrated to the realised default-rate band)",
              f"- Frailty standard deviation: `{spec.frailty_sd}`",
              f"- Seasoning (peak month, height, decay): `{spec.seasoning}`",
              f"- Delinquency chain: roll-forward `{spec.roll_forward}`, "
              f"cure base `{spec.cure_base}`", "",
              "### Static driver coefficients (per standard deviation)", "",
              "| Driver | Coefficient | Direction |", "|---|---|---|"]
        for k, v in spec.numeric_betas.items():
            L.append(f"| `{k}` | {v:+.3f} | {'raises risk' if v > 0 else 'reduces risk'} |")
        L += ["", "### Categorical level effects", "", "| Variable | Level | Coefficient |",
              "|---|---|---|"]
        for col, levels in spec.categorical_betas.items():
            for lvl, v in levels.items():
                L.append(f"| `{col}` | {lvl} | {v:+.3f} |")
        L += ["", "### Macroeconomic coefficients (per standard deviation)", "",
              "| MEV | Coefficient |", "|---|---|"]
        for k, v in spec.mev_betas.items():
            L.append(f"| `{k}` | {v:+.3f} |")
        L += ["", "### Interactions — where the economics lives", ""]
        for it in spec.interactions:
            lvl = f" (level `{it.level}`)" if it.level else ""
            L += [f"**`{it.driver}`{lvl} x `{it.mev}` = {it.coef:+.3f}**", "",
                  f"> {it.note}", ""]
        if spec.observed_aliases:
            L += ["### Observed versus true", "",
                  "The tape does not carry every driver the hazard used:", ""]
            for t, o in spec.observed_aliases.items():
                L.append(f"- hazard uses `{t}`; the tape ships `{o}`")
            L.append("")
    return "\n".join(L)


def build(verbose: bool = True) -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)
    report = {}
    for key, spec in PORTFOLIOS.items():
        res = generate(spec, seed=SEEDS[key])
        panel, accounts = assemble(res, seed=SEEDS[key])
        panel.to_parquet(OUT / f"{key}_panel.parquet", index=False)
        accounts.to_parquet(OUT / f"{key}_accounts.parquet", index=False)
        panel.head(5_000).to_csv(OUT / f"{key}_sample.csv", index=False)
        (OUT / f"{key}_dictionary.md").write_text(_dictionary(spec, panel, accounts))
        report[key] = {
            "rows": len(panel), "accounts": len(accounts),
            "defaults": int(panel.default_flag.sum()),
            "annual_default_rate_pct": round(float(panel.default_flag.mean() * 1200), 3),
            "window": [str(panel.performance_date.min().date()),
                       str(panel.performance_date.max().date())],
            "seed": SEEDS[key],
        }
        if verbose:
            r = report[key]
            print(f"  {key:9s} {r['rows']:>9,} rows  {r['accounts']:>6,} accounts  "
                  f"{r['defaults']:>5,} defaults  {r['annual_default_rate_pct']:.2f}%/yr")
    (DOCS / "GENERATIVE_TRUTH.md").write_text(truth_doc())
    (OUT / "build_report.json").write_text(json.dumps(report, indent=2))
    if verbose:
        print(f"  -> {OUT}")
        print(f"  -> {DOCS / 'GENERATIVE_TRUTH.md'}")
    return report


if __name__ == "__main__":
    build()
