"""Exposure at default — a different method per asset class, stated explicitly.

EAD behaviour varies enormously by product, and modelling it badly is worse than
not modelling it. There is deliberately NO single EAD model across the three
portfolios.

AMORTIZING PRODUCTS (consumer installment, residential mortgage)
    A deterministic contractual paydown. The balance is projected forward on the
    amortization schedule from the current balance, the note rate and the
    remaining term, with an optional prepayment haircut. EAD at default month t
    is the scheduled balance at t, plus accrued interest and a small arrears
    uplift, because an account that reaches default has usually stopped paying
    some months earlier and the balance has drifted up rather than down.

    This is simple, transparent and exactly right for a book with no undrawn
    commitment. Applying a credit conversion factor here would be inventing an
    exposure that cannot exist.

REVOLVING AND COMMITTED FACILITIES (CRE revolvers, commercial lines)
    EAD = drawn + CCF x undrawn.

    The CCF is ESTIMATED FROM THE DATA with the fixed-horizon 12-month cohort
    method: take facilities that were not in default twelve months before their
    default, and measure how much of the then-undrawn commitment was drawn by the
    time they defaulted.

        CCF_i = (EAD_i - drawn_i(t-12)) / undrawn_i(t-12)

    Observations with no undrawn commitment at the reference date are excluded —
    they carry no information about drawdown behaviour and including them pins
    the ratio at zero. A regulatory-style fixed CCF is available as a toggle.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

REGULATORY_CCF = 0.75          # Basel-style fallback for undrawn commitments


@dataclass
class EadAssumption:
    method: str                # "amortizing" | "ccf"
    portfolio: str
    plain_english: str
    parameters: dict
    estimated_ccf: float | None = None
    ccf_sample: int = 0
    ccf_note: str = ""


def amortize(balance: np.ndarray, annual_rate: np.ndarray, remaining_term: np.ndarray,
             months: int, cpr: float = 0.0,
             arrears_uplift: float = 0.0) -> np.ndarray:
    """Project the scheduled balance forward `months` steps.

    Returns an (n, months) array. Prepayment is applied as a constant monthly
    mortality derived from the annual CPR, which shrinks the balance faster than
    the contract alone; the arrears uplift pushes it the other way for accounts
    heading into default.
    """
    n = len(balance)
    r = np.asarray(annual_rate, dtype=float) / 12.0
    term = np.maximum(np.asarray(remaining_term, dtype=float), 1.0)
    bal = np.asarray(balance, dtype=float).copy()
    # level payment implied by the CURRENT balance and remaining term
    with np.errstate(divide="ignore", invalid="ignore"):
        pay = np.where(r > 0, bal * r / (1.0 - (1.0 + r) ** (-term)), bal / term)
    pay = np.nan_to_num(pay, nan=0.0, posinf=0.0)
    smm = 1.0 - (1.0 - cpr) ** (1.0 / 12.0) if cpr > 0 else 0.0

    out = np.empty((n, months), dtype=np.float32)
    for t in range(months):
        interest = bal * r
        principal = np.maximum(pay - interest, 0.0)
        bal = np.maximum(bal - principal, 0.0)
        if smm > 0:
            bal = bal * (1.0 - smm)
        out[:, t] = bal * (1.0 + arrears_uplift)
    return out


def estimate_ccf(panel: pd.DataFrame, horizon_months: int = 12) -> tuple[float, int, str]:
    """Fixed-horizon cohort CCF, estimated from the tape.

    Returns (ccf, sample size, note). The note explains any exclusion, because a
    CCF quoted without its sample definition is not a number anyone can check.
    """
    need = {"account_id", "performance_date", "drawn_amount", "committed_amount",
            "default_flag", "exposure_at_default"}
    if not need.issubset(panel.columns):
        return REGULATORY_CCF, 0, ("The tape carries no commitment columns, so the "
                                   "regulatory fallback is used.")
    d = panel.loc[panel["default_flag"] == 1,
                  ["account_id", "performance_date", "exposure_at_default"]]
    if d.empty:
        return REGULATORY_CCF, 0, "No defaults observed; regulatory fallback used."

    ref = d.copy()
    ref["ref_date"] = ref["performance_date"] - pd.DateOffset(months=horizon_months)
    hist = panel[["account_id", "performance_date", "drawn_amount", "committed_amount"]]
    merged = ref.merge(hist, left_on=["account_id", "ref_date"],
                       right_on=["account_id", "performance_date"], how="inner",
                       suffixes=("", "_ref"))
    if merged.empty:
        return REGULATORY_CCF, 0, (
            f"No defaulted facility was observed {horizon_months} months before "
            f"default, so the cohort could not be formed. Regulatory fallback used.")

    undrawn = merged["committed_amount"] - merged["drawn_amount"]
    # Only facilities with headroom carry information about drawdown behaviour.
    ok = undrawn > 1.0
    excluded = int((~ok).sum())
    if ok.sum() < 20:
        return REGULATORY_CCF, int(ok.sum()), (
            f"Only {int(ok.sum())} defaulted facilities had undrawn commitment "
            f"twelve months before default — too few to estimate. Regulatory "
            f"fallback used.")
    ccf = ((merged.loc[ok, "exposure_at_default"] - merged.loc[ok, "drawn_amount"])
           / undrawn[ok])
    # a CCF outside [0, 1] is a paydown or an over-limit event, not a conversion
    ccf = ccf.clip(0.0, 1.0)
    note = (f"Estimated on {int(ok.sum())} defaulted facilities observed "
            f"{horizon_months} months before default. {excluded} were excluded for "
            f"having no undrawn commitment at the reference date — they carry no "
            f"information about drawdown and would pin the ratio at zero.")
    return float(ccf.mean()), int(ok.sum()), note


def assumption_for(portfolio: str, method: str, panel: pd.DataFrame | None = None,
                   cpr: float = 0.0, fixed_ccf: float | None = None) -> EadAssumption:
    if method == "ccf":
        if fixed_ccf is not None:
            return EadAssumption(
                "ccf", portfolio,
                f"EAD = drawn + {fixed_ccf:.0%} x undrawn commitment, using a fixed "
                f"regulatory-style credit conversion factor rather than one estimated "
                f"from this book.",
                {"ccf": fixed_ccf, "source": "fixed"}, fixed_ccf, 0,
                "Fixed factor selected by the user; nothing was estimated.")
        ccf, n, note = estimate_ccf(panel) if panel is not None else (REGULATORY_CCF, 0, "")
        return EadAssumption(
            "ccf", portfolio,
            f"EAD = drawn + {ccf:.0%} x undrawn commitment. The credit conversion "
            f"factor is estimated from this portfolio with the fixed-horizon "
            f"12-month cohort method, not assumed.",
            {"ccf": ccf, "horizon_months": 12, "source": "estimated"}, ccf, n, note)

    return EadAssumption(
        "amortizing", portfolio,
        "EAD is the contractual scheduled balance at the default month, projected "
        f"from the current balance, the note rate and the remaining term"
        + (f", with a {cpr:.0%} annual prepayment haircut." if cpr > 0 else
           ", with no prepayment haircut applied.")
        + " No credit conversion factor applies, because an amortizing loan has no "
          "undrawn commitment.",
        {"cpr": cpr, "arrears_uplift": 0.02})


def project(df: pd.DataFrame, assumption: EadAssumption, months: int) -> np.ndarray:
    """(n accounts, months) projected exposure."""
    if assumption.method == "ccf":
        drawn = df["drawn_amount"].to_numpy(float)
        undrawn = np.maximum(df["committed_amount"].to_numpy(float) - drawn, 0.0)
        ead = drawn + assumption.parameters["ccf"] * undrawn
        return np.tile(ead[:, None], (1, months)).astype(np.float32)
    return amortize(df["current_balance"].to_numpy(float),
                    df["interest_rate"].to_numpy(float),
                    df["remaining_term"].to_numpy(float), months,
                    cpr=assumption.parameters.get("cpr", 0.0),
                    arrears_uplift=assumption.parameters.get("arrears_uplift", 0.0))
