"""The model specification — the object a version IS.

Everything needed to reproduce a fit lives here and nowhere else: the data, the
target, the sample design, every variable with its transform and binning map, the
estimator, the macro terms with their lags. Serialise this and the fit is
reproducible; diff two of them and you have the version comparison.

The hash is the immutable identity. The friendly name is a display label derived
FROM the hash, so an identical specification always produces an identical name
and an accidental duplicate is visible immediately.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Literal

Estimator = Literal["logistic", "logistic_l1", "logistic_l2", "gbm"]

# Discretizing and encoding are DIFFERENT decisions, and fusing them was the
# original mistake. "Binned" and "WoE" are not two choices — weight of evidence
# is one *encoding* of a binning, and dummies are another.
#
#   continuous ─┬─► scaler ──────────────────────────► 1 column
#               ├─► spline basis ─────────────────────► k columns
#               └─► discretizer ─► bins ─► encoder ───► 1 or k columns
#   categorical ──► grouper ─────► bins ─► encoder ───► 1 or k columns
#
# Splitting them is what makes the binning editor upstream of the encoding
# choice: drag the edges once, then decide whether that binning enters as one
# WoE column or as k−1 indicators.
Discretizer = Literal["none", "optimal", "quantile", "manual", "group"]
Encoder = Literal["woe", "dummies", "ordinal", "scaled", "spline"]

# What the UI offers. Four named treatments rather than two dropdowns, because a
# 5x5 grid of legal pairs is a control panel and this is meant to be usable in an
# afternoon. The pairs below are the ones that mean something.
TREATMENTS: dict[str, tuple[str, str]] = {
    # name          (discretizer, encoder)
    "woe":        ("optimal", "woe"),      # scorecard convention — 1 column
    "bins":       ("optimal", "dummies"),  # free step function — k−1 columns
    "continuous": ("none", "scaled"),      # linear in the log-odds — 1 column
    "spline":     ("none", "spline"),      # smooth non-linearity — k columns
}
# Superseded, kept so saved versions still load.
LEGACY_TRANSFORMS = {"woe": "woe", "raw": "continuous", "spline": "spline"}
Treatment = Literal["woe", "bins", "continuous", "spline"]


@dataclass
class VariableSpec:
    column: str
    treatment: Treatment = "woe"
    edges: list[float] | None = None           # binning map, set by the editor
    groups: list[list[str]] | None = None      # categorical grouping
    knots: list[float] | None = None           # explicit spline knots, if any
    # How many interior knots to place at quantiles when none are given. Four is
    # the usual default for a natural spline: enough to bend, few enough to stay
    # stable at the tails.
    n_knots: int = 4
    # Empirical-Bayes shrinkage strength for WoE on thin cells. A level with
    # eleven accounts should not get its own weight; this pulls it toward the
    # book average. 0 disables it.
    shrinkage: float = 0.0

    def __post_init__(self) -> None:
        # migrate a spec saved before discretizer and encoder were separated
        legacy = getattr(self, "transform", None)
        if legacy and legacy in LEGACY_TRANSFORMS:
            object.__setattr__(self, "treatment", LEGACY_TRANSFORMS[legacy])

    @property
    def discretizer(self) -> str:
        return TREATMENTS[self.treatment][0] if not (self.edges or self.groups) \
            else ("manual" if self.edges else "group")

    @property
    def encoder(self) -> str:
        return TREATMENTS[self.treatment][1]

    def key(self) -> dict:
        return {"column": self.column, "treatment": self.treatment,
                "edges": self.edges, "groups": self.groups, "knots": self.knots,
                "n_knots": self.n_knots, "shrinkage": self.shrinkage}


@dataclass
class MevSpec:
    key: str
    transform: Literal["level", "yoy", "log_diff", "qoq_annualized", "z_score",
                       "four_quarter_change"] = "level"
    lag_months: int = 0

    def label(self) -> str:
        t = {"level": "", "yoy": " YoY", "log_diff": " log-diff",
             "qoq_annualized": " QoQ ann.", "z_score": " z", "four_quarter_change": " 4Q chg"}
        return f"{self.key}{t.get(self.transform, '')}" + (
            f" (lag {self.lag_months}m)" if self.lag_months else "")


@dataclass
class SampleSpec:
    """Train/test by ACCOUNT, out-of-time by PERFORMANCE DATE.

    Splitting a panel randomly by row leaks: the same account appears on both
    sides and the model learns the account, not the risk. The account split
    prevents that; the out-of-time split is the one that actually tells you
    whether the model survives a period it has never seen.
    """
    test_fraction: float = 0.30
    oot_from: str = "2023-01-01"
    seed: int = 42
    downsample_rows: int | None = None


@dataclass
class ModelSpec:
    portfolio: str
    variables: list[VariableSpec] = field(default_factory=list)
    mevs: list[MevSpec] = field(default_factory=list)
    estimator: Estimator = "logistic"
    regularization: float = 1.0
    seasoning_spline: bool = True
    vintage_effect: bool = False
    sample: SampleSpec = field(default_factory=SampleSpec)
    target_column: str = "default_flag"
    label: str | None = None
    parent_hash: str | None = None
    notes: str = ""

    def canonical(self) -> dict:
        """The identity-bearing content, in a stable order. Anything that changes
        the fit belongs here; anything cosmetic (label, notes) does not."""
        return {
            "portfolio": self.portfolio,
            "target_column": self.target_column,
            "variables": sorted((v.key() for v in self.variables),
                                key=lambda d: d["column"]),
            "mevs": sorted(({"key": m.key, "transform": m.transform,
                             "lag_months": m.lag_months} for m in self.mevs),
                           key=lambda d: (d["key"], d["transform"], d["lag_months"])),
            "estimator": self.estimator,
            "regularization": self.regularization,
            "seasoning_spline": self.seasoning_spline,
            "vintage_effect": self.vintage_effect,
            "sample": asdict(self.sample),
        }

    def hash(self) -> str:
        blob = json.dumps(self.canonical(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["hash"] = self.hash()
        return d

    @staticmethod
    def from_dict(d: dict) -> "ModelSpec":
        d = dict(d)
        d.pop("hash", None)

        def _var(v: dict) -> VariableSpec:
            v = dict(v)
            # A version saved before the split carries `transform`. Map it rather
            # than orphaning the file — a saved specification that no longer loads
            # would break the reproducibility claim outright.
            legacy = v.pop("transform", None)
            if legacy and "treatment" not in v:
                v["treatment"] = LEGACY_TRANSFORMS.get(legacy, "woe")
            return VariableSpec(**{k: val for k, val in v.items()
                                   if k in VariableSpec.__dataclass_fields__})

        d["variables"] = [_var(v) for v in d.get("variables", [])]
        d["mevs"] = [MevSpec(**m) for m in d.get("mevs", [])]
        d["sample"] = SampleSpec(**d.get("sample", {}))
        return ModelSpec(**d)
