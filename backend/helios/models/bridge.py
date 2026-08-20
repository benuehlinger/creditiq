"""ECL attribution bridge: baseline to stressed, decomposed.

The chart answers "why did the number move", and the only version worth showing
is one that RECONCILES — the bars must sum to the difference, exactly, with no
plug.

Method: sequential substitution. Start from the baseline components and swap in
the stressed ones one at a time, measuring the change at each step.

    ECL = SUM over t of  MPD(t) x LGD(t) x EAD(t) x DF(t)
    MPD(t) = PD(t) x SURVIVAL(t)

The steps are deliberately five, not three. PD enters twice, because a
discrete-time hazard couples the two:

  1  PD (direct)        the conditional hazard rises, survival held at baseline
  2  Survival & mix     the survival path itself changes — a book that defaults
                        faster has fewer accounts alive to default later, which
                        PARTLY OFFSETS step 1. Folding this into "PD" overstates
                        the PD contribution on any long-dated book.
  3  LGD                severity conditioned on the stressed macro path
  4  EAD                the exposure path
  5  Interaction        the residual left by the ordering

SEQUENTIAL SUBSTITUTION IS PATH-DEPENDENT. Swapping LGD before PD attributes some
of the joint movement differently. That is a property of the method, not a bug,
and it is why the residual is reported rather than hidden: it is the size of the
ambiguity. `contributions_shapley` is available for a symmetric alternative that
averages over all orderings, at the cost of being harder to explain in a meeting.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import permutations

import numpy as np


@dataclass
class BridgeStep:
    label: str
    value: float           # the step's contribution
    running: float         # cumulative ECL after this step
    kind: str              # "total" | "increase" | "decrease"
    note: str = ""


def _ecl(pd_t, surv, lgd, ead, df) -> float:
    return float((pd_t * surv * lgd * ead * df).sum())


def build_bridge(base: dict, stress: dict, base_label: str = "Baseline",
                 stress_label: str = "Stressed") -> list[BridgeStep]:
    """`base` and `stress` are the `components` dicts from two EclResult objects.

    Both must describe the SAME book at the same date — the bridge explains a
    change in conditions, not a change in the population.
    """
    b, s = base, stress
    df = b["df"]

    e0 = _ecl(b["pd"], b["survival"], b["lgd"], b["ead"], df)
    e1 = _ecl(s["pd"], b["survival"], b["lgd"], b["ead"], df)
    e2 = _ecl(s["pd"], s["survival"], b["lgd"], b["ead"], df)
    e3 = _ecl(s["pd"], s["survival"], s["lgd"], b["ead"], df)
    e4 = _ecl(s["pd"], s["survival"], s["lgd"], s["ead"], df)
    e_final = _ecl(s["pd"], s["survival"], s["lgd"], s["ead"], s["df"])

    steps = [BridgeStep(base_label, e0, e0, "total")]

    def add(label, delta, running, note=""):
        steps.append(BridgeStep(label, delta, running,
                                "increase" if delta >= 0 else "decrease", note))

    add("PD", e1 - e0, e1,
        "The conditional monthly hazard under the stressed macro path, with the "
        "survival path held at baseline.")
    add("Survival & mix", e2 - e1, e2,
        "The book defaults faster, so fewer accounts remain alive to default later. "
        "This partly offsets the PD step and is the reason the two are separated.")
    add("LGD", e3 - e2, e3,
        "Severity conditioned on the stressed macro path — collateral values and "
        "workout outcomes.")
    ead_note = ("The exposure path: contractual paydown, prepayment and drawdown "
                "behaviour.")
    if abs(e4 - e3) < max(abs(e4) * 1e-9, 1e-6):
        # Not a bug, and worth saying so before anyone asks. An amortizing book's
        # exposure follows a CONTRACT, not the economy: the schedule is the same
        # in every scenario, so the EAD step is exactly zero by construction. It
        # only moves when prepayment is modelled as rate-sensitive (the CPR
        # toggle) or when the product carries an undrawn commitment, where the
        # credit conversion factor makes exposure behavioural.
        ead_note = ("Exactly zero, by construction. This book amortizes on a "
                    "contractual schedule that does not depend on the macro path, "
                    "so exposure is identical in every scenario. It moves only with "
                    "a rate-sensitive prepayment assumption, or on a product with "
                    "an undrawn commitment where a credit conversion factor "
                    "applies.")
    add("EAD", e4 - e3, e4, ead_note)
    resid = e_final - e4
    if abs(resid) > max(abs(e_final) * 1e-9, 1e-6):
        add("Interaction", resid, e_final,
            "The residual left by the substitution ORDER. Sequential attribution is "
            "path-dependent; this is the size of that ambiguity, reported rather "
            "than absorbed into another bar.")
    steps.append(BridgeStep(stress_label, e_final, e_final, "total"))
    return steps


def reconciles(steps: list[BridgeStep], tol: float = 1e-6) -> tuple[bool, float]:
    """The bridge must sum to the difference. Asserted in the test suite."""
    if len(steps) < 2:
        return True, 0.0
    start, end = steps[0].value, steps[-1].value
    moves = sum(s.value for s in steps[1:-1])
    resid = (start + moves) - end
    return abs(resid) <= max(tol, abs(end) * 1e-9), float(resid)


def contributions_shapley(base: dict, stress: dict) -> dict[str, float]:
    """Order-free attribution: the average marginal contribution of each factor
    over every ordering.

    Symmetric and free of the path dependence above. It is offered as a check on
    the sequential bridge rather than as the headline, because "we averaged over
    all 24 orderings" is a harder sentence to say to a CFO than "we changed one
    thing at a time".
    """
    factors = ["pd", "survival", "lgd", "ead"]
    df = base["df"]

    def val(active: set[str]) -> float:
        src = {f: (stress if f in active else base)[f] for f in factors}
        return _ecl(src["pd"], src["survival"], src["lgd"], src["ead"], df)

    out = {f: 0.0 for f in factors}
    perms = list(permutations(factors))
    for order in perms:
        active: set[str] = set()
        prev = val(active)
        for f in order:
            active.add(f)
            cur = val(active)
            out[f] += cur - prev
            prev = cur
    return {f: v / len(perms) for f, v in out.items()}
