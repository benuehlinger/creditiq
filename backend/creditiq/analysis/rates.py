"""Rate conversions, defined once so no two surfaces disagree.

A monthly default rate is a HAZARD, and the conversion to an annual figure is
compounding, not multiplication:

    annual = 1 - (1 - monthly) ** 12

Simple annualization (monthly x 12) is the common market shorthand and it agrees
with the compounded form to within a rounding error at the rates a performing
book actually runs at — 4.36% against 4.27% on the consumer portfolio. It breaks
down badly in the tail. A single quarter in a small, low-FICO bin can carry a 33%
monthly hazard, which multiplies out to a 400% annual default rate. A book cannot
lose 400% of itself in a year; the number is an artefact of the conversion, and
on a chart it flattens every other line into the axis.

So the compounded form is used everywhere, including the headline figures, and
the methodology drawer says so.
"""

from __future__ import annotations

import numpy as np


def annualize(monthly_rate):
    """Monthly hazard -> annual probability, as a percentage."""
    m = np.clip(np.asarray(monthly_rate, dtype=float), 0.0, 1.0)
    return (1.0 - np.power(1.0 - m, 12.0)) * 100.0


def deannualize(annual_pct):
    """Annual probability (percent) -> monthly hazard."""
    a = np.clip(np.asarray(annual_pct, dtype=float) / 100.0, 0.0, 1.0)
    return 1.0 - np.power(1.0 - a, 1.0 / 12.0)
