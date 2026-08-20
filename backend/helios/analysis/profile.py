"""Data profiling and panel integrity.

Two jobs, kept apart on purpose:

  * PROFILE describes each column — shape, missingness, cardinality, outliers.
  * INTEGRITY asks whether the panel is a valid panel at all: duplicate keys,
    gaps in the monthly sequence, rows after a terminal event, impossible values.

The second one is what a modeller actually cares about and what almost no tool
checks. A loan tape with rows after a charge-off will fit a model perfectly well
and give a wrong answer.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..data.spec import PortfolioSpec

IDENTIFIERS = {"account_id"}
DATES = {"performance_date", "origination_date"}
OUTCOMES = {"default_flag", "recovery_amount", "loss_amount", "exposure_at_default",
            "lgd_realised", "workout_months", "terminal_event", "status",
            "delinquency_bucket", "delinquency_state"}


# Column UNITS, so the UI never prints an account id as a dollar amount.
# Matched on the column name because that is what actually identifies the unit —
# the dtype cannot tell a balance from an identifier.
CURRENCY = ("balance", "amount", "payment", "income", "noi", "exposure", "loss",
            "recovery", "committed", "drawn", "value")
RATE_PCT = ("ltv", "cltv", "utilisation", "utilization", "dti", "rollover_pct",
            "_pct", "rate_pct")
COUNTS = ("count", "trades", "inquiries", "_id", "term", "months", "seq", "n_")


def _unit(col: str, dtype: str) -> str:
    c = col.lower()
    if c in ("account_id",) or c.endswith("_id") or c.endswith("_id_numeric"):
        return "identifier"
    if c == "interest_rate":
        return "decimal_rate"
    if any(k in c for k in CURRENCY):
        return "currency"
    if any(c.endswith(k) or k in c for k in RATE_PCT):
        return "percent"
    if any(k in c for k in COUNTS):
        return "count"
    if "score" in c or "fico" in c or "rating" in c or "dscr" in c:
        return "score"
    return "number"


def _role(col: str, spec: PortfolioSpec) -> str:
    if col in IDENTIFIERS:
        return "identifier"
    if col in DATES:
        return "date"
    if col == spec.target.column:
        return "target"
    if col in OUTCOMES:
        return "outcome"
    if (col in spec.numeric_betas or col in spec.categorical_betas
            or col in spec.expected_signs or col in spec.observed_aliases.values()):
        return "driver"
    # Everything else that is not an identifier or a date is a CANDIDATE
    # predictor. The distinction matters: "driver" means the platform expects a
    # relationship and can check its sign, while "candidate" means an analyst may
    # legitimately screen it and the app has no prior. Calling both "other" hides
    # perfectly good predictors like months_on_book and interest_rate.
    if col.endswith("_id") or col.endswith("_numeric"):
        return "other"
    return "candidate"


def profile_columns(df: pd.DataFrame, spec: PortfolioSpec,
                    notes: dict[str, str] | None = None) -> list[dict]:
    notes = notes or {}
    out: list[dict] = []
    n = len(df)
    for c in df.columns:
        s = df[c]
        rec = {
            "name": c,
            "dtype": str(s.dtype),
            "role": _role(c, spec),
            "unit": _unit(c, str(s.dtype)),
            "missing_pct": float(s.isna().mean() * 100),
            "n_unique": int(s.nunique(dropna=True)),
            "is_constant": bool(s.nunique(dropna=True) <= 1),
            "note": notes.get(c),
        }
        if pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s):
            v = s.dropna().to_numpy(dtype=float)
            if v.size:
                q = np.percentile(v, [1, 25, 50, 75, 99])
                iqr = q[3] - q[1]
                lo, hi = q[1] - 3 * iqr, q[3] + 3 * iqr
                rec |= {
                    "mean": float(v.mean()), "std": float(v.std()),
                    "p01": float(q[0]), "p25": float(q[1]), "p50": float(q[2]),
                    "p75": float(q[3]), "p99": float(q[4]),
                    "min": float(v.min()), "max": float(v.max()),
                    # Tukey's far-outlier fence at 3 IQR, not 1.5. Credit data is
                    # right-skewed by nature, so the 1.5 fence flags a quarter of
                    # an income column and the signal is lost in the noise.
                    "n_outliers": int(((v < lo) | (v > hi)).sum()),
                }
        elif n:
            vc = s.astype(str).value_counts().head(12)
            rec["top_levels"] = [{"level": k, "count": int(v), "pct": float(v / n * 100)}
                                 for k, v in vc.items()]
        out.append(rec)
    return out


def check_integrity(panel: pd.DataFrame, spec: PortfolioSpec) -> list[dict]:
    """Panel-shape checks. Each returns a row for the health scorecard."""
    issues: list[dict] = []

    def add(check, passed, severity, detail, n=0):
        issues.append({"check": check, "passed": bool(passed),
                       "severity": "good" if passed else severity,
                       "detail": detail, "n_affected": int(n)})

    dup = int(panel.duplicated(["account_id", "performance_date"]).sum())
    add("Unique account-date key", dup == 0, "critical",
        "One row per account per month." if dup == 0
        else f"{dup:,} duplicated account-date rows. Every panel method assumes "
             f"this key is unique.", dup)

    s = panel.sort_values(["account_id", "performance_date"])
    per = s["performance_date"].dt.to_period("M").astype("int64")
    step = per.groupby(s["account_id"]).diff().dropna()
    gaps = int((step != 1).sum())
    add("No gaps in the monthly sequence", gaps == 0, "serious",
        "Every account's rows are consecutive months." if gaps == 0
        else f"{gaps:,} breaks in the monthly sequence. A missing month is not the "
             f"same as a censored account and will bias a hazard model.", gaps)

    last = s.groupby("account_id")["performance_date"].transform("max")
    term = s["terminal_event"].isin(["default", "payoff", "matured"])
    after = int((term & (s["performance_date"] != last)).sum())
    add("No rows after a terminal event", after == 0, "critical",
        "Accounts stop at their terminal event." if after == 0
        else f"{after:,} rows recorded after a terminal event. These inflate the "
             f"denominator and depress every rate.", after)

    neg = int((panel["current_balance"] < 0).sum())
    add("Balances are non-negative", neg == 0, "serious",
        "No negative balances." if neg == 0
        else f"{neg:,} negative balance(s). A balance cannot be below zero; this "
             f"is a data error, not a credit.", neg)

    tgt = panel[spec.target.column]
    multi = int((panel.groupby("account_id")[spec.target.column].sum() > 1).sum())
    add("Target fires at most once per account", multi == 0, "critical",
        f"`{spec.target.column}` fires once at most." if multi == 0
        else f"{multi:,} accounts default more than once. The target is meant to be "
             f"absorbing.", multi)

    rate = float(tgt.mean() * 1200)
    ok = 0.1 <= rate <= 25.0
    add("Default rate is plausible", ok, "warning",
        f"{rate:.2f}% annualized." + ("" if ok else " Outside any credible band for "
                                                    "a performing book."))

    span = (panel["performance_date"].max() - panel["performance_date"].min()).days / 365.25
    add("Observation window is long enough to backtest", span >= 3, "warning",
        f"{span:.1f} years of performance history."
        + ("" if span >= 3 else " Under three years leaves no room for an "
                               "out-of-time split."))

    fut = int((panel["performance_date"] < panel["origination_date"]).sum())
    add("No performance before origination", fut == 0, "critical",
        "No account is observed before it was booked." if fut == 0
        else f"{fut:,} rows dated before origination.", fut)
    return issues


def health_score(issues: list[dict]) -> float:
    """0-100. Weighted so a critical structural failure cannot be offset by
    passing a handful of cosmetic checks."""
    w = {"critical": 5.0, "serious": 3.0, "warning": 1.0, "good": 0.0}
    total = sum(w.get(i["severity"], 1.0) if not i["passed"] else 0.0 for i in issues)
    worst = sum(5.0 for _ in issues)
    return round(max(0.0, 100.0 * (1.0 - total / max(worst, 1))), 1)
