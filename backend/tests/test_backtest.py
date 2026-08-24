"""Backtest cohorting: what a point on the time axis is, and why.

Every statistic is computed per performance-date cohort, and a cohort is a
QUARTER. The panel underneath is monthly, so that is a REPORTING choice — these
tests pin the choice, the reason for it, and the fact that the interface reads
the frequency from the data rather than from a word someone typed into a chart.
"""

from __future__ import annotations

import numpy as np
import pytest


def test_cohorts_are_quarters_and_say_so():
    """The axis label must come from the data, not from a constant.

    Cohorts are quarters: a monthly cohort on the mortgage book rests on about
    seven defaults, and an AUC or a calibration test on seven events reports
    noise rather than performance. The interface labelled its x-axis
    "Performance month" over these quarterly points, because the word was
    hard-coded in the chart and nothing tied it to the aggregation.
    """
    import pandas as pd

    from creditiq.models import backtest as B

    assert B.COHORT_FREQ == "QS"
    assert B.COHORT_FREQ_LABEL == "quarter"

    rng = np.random.default_rng(3)
    n = 40_000
    dates = pd.date_range("2020-01-01", periods=n, freq="h")[:n]
    y = rng.binomial(1, 0.02, n)
    p = rng.uniform(0.005, 0.05, n)

    rows = B.by_cohort(dates.to_numpy(), y, p)
    months = {r["period"][5:7] for r in rows}
    assert months <= {"01", "04", "07", "10"}, (
        f"cohorts must start a quarter, saw months {sorted(months)}")


def test_the_published_frequency_reaches_the_payload():
    """`period_freq` travels with the backtest so a chart can label from it."""
    import inspect

    from creditiq.models import service

    src = inspect.getsource(service)
    assert '"period_freq": B.COHORT_FREQ_LABEL' in src


def test_recohorting_needs_no_refit_and_labels_itself():
    """The cohort is a REPORTING choice over monthly data, so it is offered.

    The scored account-months are kept on the run, so changing the grouping
    costs the grouping and nothing else.
    """
    from creditiq.models import backtest as B, rollup as R, service as S

    spec, _, _ = R.spec_for("mortgage")
    run = S.run(spec)
    assert run.scored, "the run must retain its scored rows to be re-cohorted"

    q = B.recohort(run.scored, "QS")
    m = B.recohort(run.scored, "MS")
    assert q["period_freq"] == "quarter" and m["period_freq"] == "month"
    assert len(m["cohorts"]) > len(q["cohorts"])
    # Same predictions underneath: the panel-wide event count is unchanged by
    # how it is grouped.
    assert sum(c["events"] for c in m["cohorts"]) >= sum(c["events"] for c in q["cohorts"]) * 0.9

    with pytest.raises(ValueError):
        B.recohort(run.scored, "W")


def test_monthly_cohorts_are_too_thin_to_rank_order():
    """Why quarterly is the DEFAULT rather than the only option.

    On this book a month carries about nine defaults. An area under the curve on
    nine events is sampling noise, and it goes below 0.5 — which reads as a model
    ranking backwards. Quarterly triples the events behind each point.
    """
    import numpy as np

    from creditiq.models import backtest as B, rollup as R, service as S

    spec, _, _ = R.spec_for("mortgage")
    run = S.run(spec)
    ev = {}
    for freq in ("MS", "QS"):
        rows = B.recohort(run.scored, freq)["cohorts"]
        ev[freq] = float(np.median([r["events"] for r in rows]))
    assert ev["QS"] > 2 * ev["MS"], (
        f"a quarter should carry about three times a month's defaults: {ev}")
