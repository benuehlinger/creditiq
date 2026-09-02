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
    "indicator":  ("manual", "dummies"),   # one threshold — 1 column
    "continuous": ("none", "scaled"),      # linear in the log-odds — 1 column
    "spline":     ("none", "spline"),      # smooth non-linearity — k columns
}

# The two decisions a treatment is made of. A variable is either DISCRETISED —
# in which case it has bins, a weight of evidence and an information value — or
# kept on its CONTINUOUS SCALE, in which case it has knots and neither of those
# three means anything. Information value in particular is a property of a
# binning, not of a variable, and reporting it beside a spline invites a
# comparison that does not exist.
DISCRETISED = {"woe", "bins", "indicator"}
CONTINUOUS_SCALE = {"continuous", "spline"}
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
    # How many bins to cut when no explicit edges are given. Without this the
    # editor's bin-count control did not reach the fit at all: the analyst set
    # seven bins, saw seven bins, and the model was estimated on the default
    # eight. It is also what lets a saved specification restore the count it was
    # built with, so a replay reproduces the model rather than a near neighbour.
    max_bins: int = 8
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
        """Every field that changes the model, and nothing else.

        This is what the version hash is built from, so an omission here means
        two genuinely different models share one identifier. `max_bins` was
        missing: the same variable cut into seven bins and into eight produced
        the same hash, the same auto-generated name, and silently overwrote each
        other in the version store. See `test_spec.py`, which asserts that every
        field of this dataclass appears.
        """
        return {"column": self.column, "treatment": self.treatment,
                "edges": self.edges, "groups": self.groups, "knots": self.knots,
                "n_knots": self.n_knots, "max_bins": self.max_bins,
                "shrinkage": self.shrinkage}


@dataclass
class MevSpec:
    key: str
    transform: Literal["level", "diff", "yoy", "log_diff", "qoq_annualized",
                       "z_score", "four_quarter_change",
                       "ma3", "ma6", "ma12", "yoy_ma3", "diff_ma3"] = "level"
    lag_months: int = 0

    def label(self) -> str:
        t = {"level": "", "diff": " 1m chg", "yoy": " YoY", "log_diff": " log-diff",
             "qoq_annualized": " QoQ ann.", "z_score": " z",
             "four_quarter_change": " 12m chg",
             "ma3": " 3m avg", "ma6": " 6m avg", "ma12": " 12m avg",
             "yoy_ma3": " YoY 3m avg", "diff_ma3": " 1m chg 3m avg"}
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


# The macro variables an LGD model may take. Severity is where a housing or
# property stress actually bites, so these have to be reachable — and they have
# to be joined AT THE DEFAULT MONTH, which is what `fit_lgd` does below.
LGD_MACRO = ("unemployment_rate", "hpi_yoy", "cre_price_index_yoy", "real_gdp_growth",
             "bbb_yield")

# The DEFAULT selection per portfolio: collateral position at default, macro at
# default, workout duration, and support. It is a starting point the analyst
# changes, not a fixed list — see `LgdSpec`.
LGD_DRIVERS: dict[str, list[str]] = {
    "consumer": ["fico_orig", "months_on_book", "unemployment_rate"],
    "mortgage": ["cltv", "current_ltv", "workout_months", "hpi_yoy", "months_on_book"],
    "cre": ["current_ltv", "dscr_reported", "workout_months", "cre_price_index_yoy"],
}
CATEGORICAL_DRIVERS: dict[str, list[str]] = {
    "consumer": [], "mortgage": ["occupancy"], "cre": ["guarantor_flag", "property_type"],
}


# NO weight-of-evidence option. Weight of evidence is
# ln[(events_b / all events) / (non-events_b / all non-events)], which needs a
# binary outcome. Realised severity has neither events nor non-events, so the
# quantity does not exist here.
#
# A mean encoding on the logit scale — logit(bin mean) - logit(book mean) — IS
# well defined and was offered for a while. It was removed: it is the same
# binning as `bins` constrained to one coefficient, it measured worse than both
# alternatives on this data (deviance R-squared 0.281 against 0.317 linear and
# 0.287 binned), and calling it a weight invited exactly the confusion with
# weight of evidence that it is not.
LgdTreatment = Literal["bins", "continuous", "spline"]


@dataclass(frozen=True)
class LgdVariable:
    """One driver, and how it enters the severity model.

    The same four treatments the PD side offers, on a fractional target. The
    weight is the severity analogue of weight of evidence — the logit shift of
    the bin mean against the book mean — not weight of evidence itself, which is
    defined on a binary outcome and has no meaning here.
    """
    column: str
    treatment: LgdTreatment = "continuous"
    edges: list[float] | None = None
    knots: list[float] | None = None
    n_knots: int = 3
    max_bins: int = 5

    def key(self) -> dict:
        return {"column": self.column, "treatment": self.treatment,
                "edges": self.edges, "knots": self.knots,
                "n_knots": self.n_knots, "max_bins": self.max_bins}


@dataclass(frozen=True)
class LgdSpec:
    """Which drivers enter the severity model, and in how many stages.

    Thinner than `ModelSpec`. LGD is estimated on defaulted account-months only,
    which is a few hundred rows on the commercial book. A binning and
    weight-of-evidence apparatus over that many observations would add parameters
    without adding information, so terms enter linearly and the specification is
    the choice of drivers.
    """
    portfolio: str
    drivers: tuple[str, ...] = ()
    categoricals: tuple[str, ...] = ()
    # How each driver enters. A driver absent from this map enters linearly,
    # which is what every specification saved before treatments existed did.
    treatments: tuple[tuple[str, str], ...] = ()
    # Per-driver binning edges and spline knots, when they were set by hand.
    edges: tuple[tuple[str, tuple[float, ...]], ...] = ()
    knots: tuple[tuple[str, tuple[float, ...]], ...] = ()
    n_knots: int = 3
    max_bins: int = 5
    @staticmethod
    def default_for(portfolio: str) -> "LgdSpec":
        return LgdSpec(portfolio=portfolio,
                       drivers=tuple(LGD_DRIVERS.get(portfolio, [])),
                       categoricals=tuple(CATEGORICAL_DRIVERS.get(portfolio, [])))

    def treatment_of(self, column: str) -> str:
        t = dict(self.treatments).get(column)
        if t in ("bins", "continuous", "spline"):
            return t
        # `weight` was an earlier option; a saved specification carrying it is
        # read as the binning it always was.
        if t == "weight":
            return "bins"
        return "bins" if column in self.categoricals else "continuous"

    def edges_of(self, column: str) -> list[float] | None:
        e = dict(self.edges).get(column)
        return list(e) if e else None

    def knots_of(self, column: str) -> list[float] | None:
        k = dict(self.knots).get(column)
        return list(k) if k else None

    def to_dict(self) -> dict:
        """The wire format. Per-column settings are OBJECTS, not pairs.

        This class stores them as tuples of pairs because it is frozen and has
        to hash, but that is an implementation detail and it must not leak. It
        did: the interface received `[["cltv", "spline"]]`, treated it as the
        mapping it is named like, and wrote `{...treatments, [col]: t}` — which
        spreads an ARRAY into an object and yields
        `{"0": ["cltv", "spline"], "cltv": "bins"}`. The request then failed
        validation, so no treatment other than the default could ever be
        applied. A mapping on the wire is a mapping.
        """
        return {"portfolio": self.portfolio, "drivers": list(self.drivers),
                "categoricals": list(self.categoricals),
                "treatments": dict(self.treatments),
                "edges": {c: list(v) for c, v in self.edges},
                "knots": {c: list(v) for c, v in self.knots},
                "n_knots": self.n_knots, "max_bins": self.max_bins}

    @staticmethod
    def _pairs(v) -> tuple:
        """Accept either the mapping or the older list-of-pairs.

        Saved version files written before `to_dict` emitted objects carry the
        list form, and a saved specification must stay readable — that is the
        whole point of saving it.
        """
        if v is None:
            return ()
        items = v.items() if isinstance(v, dict) else v
        return tuple((c, t) for c, t in items)

    @staticmethod
    def from_dict(d: dict) -> "LgdSpec":
        return LgdSpec(
            portfolio=d["portfolio"], drivers=tuple(d.get("drivers", ())),
            categoricals=tuple(d.get("categoricals", ())),
            treatments=LgdSpec._pairs(d.get("treatments")),
            edges=tuple((c, tuple(v)) for c, v in LgdSpec._pairs(d.get("edges"))),
            knots=tuple((c, tuple(v)) for c, v in LgdSpec._pairs(d.get("knots"))),
            n_knots=int(d.get("n_knots", 3)), max_bins=int(d.get("max_bins", 5)))

    def hash(self) -> str:
        """Order-insensitive: reordering the driver list is not a different model.
        The treatments ARE part of the identity — the same drivers as splines and
        as linear terms are different models."""
        payload = {"portfolio": self.portfolio, "drivers": sorted(self.drivers),
                   "categoricals": sorted(self.categoricals),
                   "treatments": sorted(self.treatments),
                   "edges": sorted((c, list(v)) for c, v in self.edges),
                   "knots": sorted((c, list(v)) for c, v in self.knots),
                   "n_knots": self.n_knots, "max_bins": self.max_bins}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:12]

    @property
    def macro_drivers(self) -> list[str]:
        """Drivers that move with a scenario: the fixed macro block, plus any
        transformed candidate promoted from the macro search."""
        return [c for c in self.drivers if c in LGD_MACRO or "@" in c]


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
    # The severity half. A Model is a PD specification AND an LGD specification:
    # an ECL number is the product of the two, so naming, hashing and versioning
    # have to cover both or the name refers to half of what produced the figure.
    # None means "PD fitted, LGD not chosen yet" — which is a legal working state
    # and an illegal thing to name.
    lgd: LgdSpec | None = None
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
            "lgd": self.lgd.to_dict() if self.lgd else None,
        }

    def hash(self) -> str:
        blob = json.dumps(self.canonical(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def pd_hash(self) -> str:
        """The identity of the PROBABILITY OF DEFAULT half, on its own.

        A version identifies a PD specification and an LGD specification
        together, because expected credit loss comes from both. But the halves
        are independent: severity is fitted on resolved defaults and never sees
        the PD specification, so changing PD leaves the LGD model unchanged down
        to its coefficients.

        That makes reuse the normal way of working — settle on a severity model,
        then iterate PD against it — and it leaves two versions carrying the SAME
        severity model with no way to tell. Their bias and RMSE columns agree,
        and nothing says whether that is one model seen twice or two models that
        happen to agree. It matters: if that severity model is miscalibrated,
        every version bound to it inherits the flaw.

        So each half gets a visible identity. `hash()` remains the identity of
        the pair, which is what is named, promoted and quoted.
        """
        c = self.canonical()
        blob = json.dumps({k: v for k, v in c.items() if k != "lgd"},
                          sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:12]

    @property
    def is_complete(self) -> bool:
        """Both halves fitted. The gate on naming and saving a version."""
        return bool(self.variables) and self.lgd is not None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["lgd"] = self.lgd.to_dict() if self.lgd else None
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
        lgd = d.get("lgd")
        d["lgd"] = LgdSpec.from_dict(lgd) if lgd else None
        return ModelSpec(**{k: v for k, v in d.items()
                            if k in ModelSpec.__dataclass_fields__})
