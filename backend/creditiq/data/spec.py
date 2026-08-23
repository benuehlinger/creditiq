"""The declarative portfolio registry.

This file is the architecture claim in the sales message: CreditIQ is ONE platform
configured three ways, not three hardcoded paths. A fourth portfolio is a
`PortfolioSpec` entry — a driver catalog, a target definition, an EAD method, a
set of MEVs and the expected signs — and nothing else changes.

Every coefficient here is GENERATIVE TRUTH. `docs/GENERATIVE_TRUTH.md` is written
straight out of these objects, so what the platform recovers can be checked
against what actually produced the data.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal

import numpy as np

from .copula import Marginal

EadMethod = Literal["amortizing", "ccf"]


@dataclass(frozen=True)
class TargetDef:
    """What counts as a default, in words and in code."""
    column: str
    description: str
    dpd_state: int            # delinquency state that trips the definition
    label: str


@dataclass(frozen=True)
class Interaction:
    """A driver x MEV term. This is where the economics lives.

    A high-LTV borrower is far more sensitive to a house-price fall than a
    low-LTV one. Without interaction terms a stress scenario just shifts every
    account by the same amount, which is exactly the criticism a validator makes
    of a naive macro overlay.
    """
    driver: str
    mev: str
    coef: float
    note: str
    # optional: restrict the interaction to one level of a categorical driver
    level: str | None = None


@dataclass(frozen=True)
class PortfolioSpec:
    key: str
    label: str
    n_accounts: int
    accent_slot: int                     # categorical palette slot, 1-based
    target: TargetDef
    ead_method: EadMethod
    ead_note: str

    marginals: list[Marginal]
    correlations: dict[tuple[str, str], float]

    # hazard: the monthly probability of rolling from current into delinquency
    intercept: float
    frailty_sd: float
    seasoning: tuple[float, float, float]   # peak months, height, decay
    numeric_betas: dict[str, float]         # per standard deviation of the driver
    categorical_betas: dict[str, dict[str, float]]
    mev_keys: list[str]
    mev_betas: dict[str, float]             # per standard deviation of the MEV
    interactions: list[Interaction]

    # delinquency chain
    roll_forward: float                     # base P(advance one bucket)
    cure_base: float                        # base P(return to current)

    # competing risks
    prepay_intercept: float
    prepay_betas: dict[str, float] = field(default_factory=dict)

    # product
    term_choices: tuple[int, ...] = (60,)
    term_probs: tuple[float, ...] = (1.0,)
    balance_marginal: str = "original_balance"
    rate_base: float = 0.08
    rate_fico_slope: float = 0.0

    # LGD
    lgd_intercept: float = 0.0
    lgd_betas: dict[str, float] = field(default_factory=dict)
    lgd_zero_intercept: float = 0.0         # P(no loss at all) — the boundary mass

    # expected sign of each driver's effect on PD, enforced in the UI
    expected_signs: dict[str, int] = field(default_factory=dict)

    # What the TAPE shows versus what actually drove the hazard.
    #
    # Some drivers are observed imperfectly in real life, and pretending
    # otherwise is a way to manufacture discrimination that no analyst could
    # achieve. A CRE debt service coverage ratio on a loan tape is borrower-
    # reported from annual financials and is routinely two to four quarters
    # stale; the hazard responds to the true, current coverage. Mapping
    # {true_driver: reported_column} keeps the generative model honest AND makes
    # the shipped data honest, because the tape carries only the reported column.
    observed_aliases: dict[str, str] = field(default_factory=dict)

    # portfolio-specific dynamics, e.g. current LTV from the HPI path
    dynamics: Callable | None = None
