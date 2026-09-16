"""Automated variable selection: stepwise cores, then an exhaustive macro search.

The search produces ordinary ModelSpec objects — the same object the workbench
fits, the versions store names, and the caches key on — so a leaderboard row IS
a model the analyst can open, refit and save. Nothing here invents a second
modeling path.

Two stages, mirroring how these models are defended in review:

**Stage 1 — internal cores, no macro terms.** Forward stepwise then backward
elimination over the candidate borrower and loan variables. The unit of entry
and exit is the TERM, not the column: a spline basis or a dummy block enters
and leaves whole, tested by a likelihood-ratio test with the term's own degrees
of freedom. The default decision rule is BIC on the EVENT count, following the
documented convention in `analysis/curve.py`: at three hundred thousand rows a
p-value calls almost anything significant, and the effective sample size of a
rare-event model is set by the rarer outcome. A p-value rule remains available
because some reviewers ask for one.

**Stage 2 — macro terms, exhaustively.** Each transform-and-lag variant of each
macro variable is screened one at a time against each core; survivors (right
sign, loose p) are enumerated in every combination of one to three, under the
family rules (one variant per underlying series, never the same series at two
lags, no highly correlated pair), and each core-plus-combination is refitted
jointly. Every emitted model carries at least one macro term — a model the
scenario engine cannot reach is not a candidate here by definition — and at
most three, because a fourth is indefensible in front of a validator.

Search fits run on the screening frame (`store.screening_frame`, the same
event-preserving subsample the variable screen uses) through the lean path:
`design.build` + `fit.fit`, no scoring of the full panel, no backtest
artifacts. The design module's column caches make an incremental fit cost
roughly one new column. Finalists get the full `service.run` treatment
elsewhere; this module never produces a ModelRun.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd
from scipy.stats import chi2

from .. import store
from ..data.portfolios import PORTFOLIOS
from . import design as D
from . import fit as F
from .spec import MevSpec, ModelSpec, SampleSpec, VariableSpec

# Variables that move with the cycle the macro terms are supposed to carry.
# A core that includes one still fits — often better in sample — but it drains
# the macro signal: current LTV already contains the house-price path, so the
# HPI term left beside it fights for a residual and can flip sign. The search
# warns rather than filters, because sometimes the cyclical driver is the point.
CYCLICAL_MARKERS = ("current_ltv", "cltv", "utilization", "utilisation",
                    "delinq", "dpd")

# The severity ladder of the published supervisory scenarios, mildest first.
# Only the names that exist in data/scenarios are used; the 2026 cycle publishes
# baseline and severely adverse.
SEVERITY_ORDER = ("baseline", "adverse", "severely_adverse")


# ── configuration ────────────────────────────────────────────────────────────
@dataclass
class CandidateVar:
    """One borrower or loan variable offered to the search, with its treatment.

    The treatment travels into the VariableSpec unchanged, so what the search
    tests is exactly what the workbench would fit. A spline candidate with a
    given knot set is one candidate; a different knot set is a different
    candidate variable list, not a variant explored here.
    """
    column: str
    role: str = "candidate"                # "candidate" | "excluded"
    treatment: str = "woe"                 # woe | bins | continuous | spline
    knots: list[float] | None = None
    n_knots: int = 4
    max_bins: int = 8

    def key(self) -> dict:
        return {"column": self.column, "role": self.role,
                "treatment": self.treatment, "knots": self.knots,
                "n_knots": self.n_knots, "max_bins": self.max_bins}


@dataclass
class SelectionRules:
    entry_metric: str = "bic"              # "p_value" | "aic" | "bic"
    entry_threshold: float = 0.01          # p-value mode only
    exit_threshold: float = 0.05           # p-value mode only
    mev_screen_p: float = 0.10             # loose screen for macro variants
    min_mevs: int = 1
    max_mevs: int = 3
    max_predictors: int | None = None      # core terms, macro terms excluded
    max_vif: float | None = 5.0
    vif_rule: str = "flag"                 # "filter" | "flag"
    p_rule: str = "flag"                   # applies p_cutoff to the joint fit
    p_cutoff: float = 0.05                 # what "all significant" means
    mev_corr_cap: float = 0.7
    core_shift_pct: float = 30.0           # relative shift that flags a core term
    strong_core_size: int = 4
    top_n_full: int = 10

    def __post_init__(self) -> None:
        # The floor and ceiling are the product's rules, not preferences: a
        # model with no macro term cannot be stressed, and one with four is
        # indefensible. Clamp rather than error so a hand-edited config cannot
        # smuggle either past the search.
        self.min_mevs = max(1, int(self.min_mevs))
        self.max_mevs = max(self.min_mevs, min(3, int(self.max_mevs)))
        self.top_n_full = max(1, min(12, int(self.top_n_full)))


@dataclass
class SelectionConfig:
    portfolio: str
    candidates: list[CandidateVar] = field(default_factory=list)
    cores: list[str] = field(default_factory=lambda: ["stepwise", "strong"])
    expert_core: list[str] | None = None
    mev_families: list[str] | None = None  # None = every projectable base
    rules: SelectionRules = field(default_factory=SelectionRules)
    oot_from: str = "2023-01-01"
    test_fraction: float = 0.30
    label: str | None = None

    def canonical(self) -> dict:
        """Identity-bearing content in a stable order, like ModelSpec's."""
        return {
            "portfolio": self.portfolio,
            "candidates": sorted((c.key() for c in self.candidates
                                  if c.role == "candidate"),
                                 key=lambda d: d["column"]),
            "cores": sorted(self.cores),
            "expert_core": sorted(self.expert_core) if self.expert_core else None,
            "mev_families": sorted(self.mev_families) if self.mev_families else None,
            "rules": asdict(self.rules),
            "oot_from": self.oot_from,
            "test_fraction": self.test_fraction,
        }

    def hash(self) -> str:
        blob = json.dumps(self.canonical(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["hash"] = self.hash()
        return d

    @staticmethod
    def from_dict(d: dict) -> "SelectionConfig":
        d = dict(d)
        d.pop("hash", None)
        d["candidates"] = [CandidateVar(**{k: v for k, v in c.items()
                                           if k in CandidateVar.__dataclass_fields__})
                           for c in d.get("candidates", [])]
        d["rules"] = SelectionRules(**{k: v for k, v in (d.get("rules") or {}).items()
                                       if k in SelectionRules.__dataclass_fields__})
        return SelectionConfig(**{k: v for k, v in d.items()
                                  if k in SelectionConfig.__dataclass_fields__})


class Cancelled(Exception):
    """Raised between fits when the caller's cancel event is set."""


# ── lean fitting ─────────────────────────────────────────────────────────────
def _variable_spec(c: CandidateVar) -> VariableSpec:
    return VariableSpec(column=c.column, treatment=c.treatment, knots=c.knots,
                        n_knots=c.n_knots, max_bins=c.max_bins)


def _model_spec(cfg: SelectionConfig, variables: list[VariableSpec],
                mevs: tuple[MevSpec, ...] = ()) -> ModelSpec:
    return ModelSpec(
        portfolio=cfg.portfolio, variables=list(variables), mevs=list(mevs),
        sample=SampleSpec(test_fraction=cfg.test_fraction, oot_from=cfg.oot_from),
        target_column=PORTFOLIOS[cfg.portfolio].target.column)


@dataclass
class Lean:
    """A search fit: the estimator's result plus what the tests need."""
    fit: F.FitResult
    ll: float                  # log-likelihood on the fit frame
    k: int                     # columns including the intercept
    n_events: int
    design: D.Design


def _frames(cfg: SelectionConfig) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The fit frame (in-time screening rows) and the full screening frame.

    Search fits see only rows before the out-of-time boundary, so the
    out-of-time AUC on a leaderboard row is measured on months the candidate
    was never fitted on — the same discipline the full model path applies.
    """
    df, _ = store.screening_frame(cfg.portfolio)
    fit_df = df[df["performance_date"] < pd.Timestamp(cfg.oot_from)]
    return fit_df, df


def _lean_fit(fit_df: pd.DataFrame, spec: ModelSpec) -> Lean:
    des = D.build(fit_df, spec)
    res = F.fit(des, spec)
    return Lean(fit=res, ll=res.log_likelihood, k=len(res.columns),
                n_events=res.n_events_train, design=des)


def _entry_score(with_: Lean, without: Lean, rules: SelectionRules) -> tuple[bool, float]:
    """Does the larger model earn its columns, and how strongly?

    Returns (passes, score) where a LOWER score is better, so the caller can
    pick the strongest candidate uniformly across decision rules. In p-value
    mode the score is the likelihood-ratio p; in AIC/BIC mode it is the delta
    of the criterion (negative = improvement). The BIC penalty uses the event
    count, per the rare-event convention documented in analysis/curve.py.
    """
    df_ = max(with_.k - without.k, 1)
    stat = max(2.0 * (with_.ll - without.ll), 0.0)
    if rules.entry_metric == "p_value":
        p = float(chi2.sf(stat, df_))
        return p < rules.entry_threshold, p
    log_n = float(np.log(max(with_.n_events, 2)))
    penalty = 2.0 if rules.entry_metric == "aic" else log_n
    delta = (-2.0 * with_.ll + with_.k * penalty) \
        - (-2.0 * without.ll + without.k * penalty)
    return delta < 0.0, delta


def _exit_p(full: Lean, without: Lean) -> float:
    """The p-value on the whole TERM's removal, by likelihood ratio."""
    df_ = max(full.k - without.k, 1)
    stat = max(2.0 * (full.ll - without.ll), 0.0)
    return float(chi2.sf(stat, df_))


def _cyclical_warnings(columns: list[str]) -> list[str]:
    out = []
    for col in columns:
        if any(m in col.lower() for m in CYCLICAL_MARKERS):
            out.append(
                f"{col} moves with the cycle. It can absorb the macro signal, "
                f"leaving the scenario terms weakened or sign-flipped. Keep it "
                f"if the portfolio warrants it, and read the macro "
                f"coefficients with that in mind.")
    return out


# ── stage 1: cores ───────────────────────────────────────────────────────────
@dataclass
class Core:
    name: str                       # "stepwise" | "strong" | "expert"
    columns: list[str]              # candidate columns, in entry order
    variables: list[VariableSpec]
    warnings: list[str]
    lean: Lean
    coefficients: dict[str, float]  # design column -> estimate, for shift checks
    steps: list[dict]               # the audit of how the core was built


def _coef_map(lean: Lean) -> dict[str, float]:
    return {c.name: c.estimate for c in lean.fit.coefficients
            if c.name != "intercept"}


def build_cores(cfg: SelectionConfig, progress=None, cancel=None) -> list[Core]:
    """Stage 1: the internal risk-driver cores, no macro terms."""
    fit_df, _ = _frames(cfg)
    rules = cfg.rules
    by_col = {c.column: c for c in cfg.candidates if c.role == "candidate"}

    def tick(step: int, total: int, label: str) -> None:
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if progress:
            progress(step, total, label)

    def fit_columns(cols: list[str]) -> Lean:
        return _lean_fit(fit_df, _model_spec(
            cfg, [_variable_spec(by_col[c]) for c in cols]))

    cores: list[Core] = []
    steps: list[dict] = []

    # Forward stepwise. The null model is the account-age baseline alone, so a
    # candidate has to explain something age does not.
    selected: list[str] = []
    current = fit_columns(selected)
    remaining = list(by_col)
    n_fits = 0
    passnum = 0
    while remaining:
        if rules.max_predictors and len(selected) >= rules.max_predictors:
            break
        passnum += 1
        best: tuple[float, str, Lean] | None = None
        for i, col in enumerate(remaining, 1):
            n_fits += 1
            tick(i, len(remaining),
                 f"building the stepwise core (pass {passnum}): testing {col}")
            cand = fit_columns(selected + [col])
            passes, score = _entry_score(cand, current, rules)
            if passes and (best is None or score < best[0]):
                best = (score, col, cand)
        if best is None:
            break
        score, col, cand = best
        selected.append(col)
        remaining.remove(col)
        steps.append({"action": "enter", "column": col, "score": score,
                      "metric": rules.entry_metric})
        current = cand

    # Backward elimination, and the LR drop per term that the strong core uses.
    drops: dict[str, float] = {}
    while len(selected) > 1:
        worst: tuple[float, str, Lean] | None = None
        for i, col in enumerate(selected, 1):
            tick(i, len(selected),
                 f"backward elimination: re-testing {col}")
            without = fit_columns([c for c in selected if c != col])
            p_drop = _exit_p(current, without)
            drops[col] = float(2.0 * (current.ll - without.ll))
            if rules.entry_metric == "p_value":
                fails = p_drop > rules.exit_threshold
                score = -p_drop
            else:
                passes, delta = _entry_score(current, without, rules)
                fails, score = not passes, delta
            if fails and (worst is None or score < worst[0]):
                worst = (score, col, without)
        if worst is None:
            break
        _, col, without = worst
        selected.remove(col)
        drops.pop(col, None)
        steps.append({"action": "drop", "column": col,
                      "metric": rules.entry_metric})
        current = without

    if selected and "stepwise" in cfg.cores:
        cores.append(Core(name="stepwise", columns=list(selected),
                          variables=[_variable_spec(by_col[c]) for c in selected],
                          warnings=_cyclical_warnings(selected), lean=current,
                          coefficients=_coef_map(current), steps=list(steps)))

    # The strong core: only the terms whose removal costs the most likelihood.
    if selected and "strong" in cfg.cores and len(selected) > rules.strong_core_size:
        ranked = sorted(selected, key=lambda c: -drops.get(c, 0.0))
        keep = sorted(ranked[: rules.strong_core_size], key=selected.index)
        tick(1, 1, "fitting the strongest-drivers core")
        lean = fit_columns(keep)
        cores.append(Core(name="strong", columns=keep,
                          variables=[_variable_spec(by_col[c]) for c in keep],
                          warnings=_cyclical_warnings(keep), lean=lean,
                          coefficients=_coef_map(lean),
                          steps=[{"action": "keep", "column": c,
                                  "lr_drop": drops.get(c)} for c in keep]))

    # The expert core: the analyst's list, verbatim. It is not searched — its
    # value is exactly that a human chose it — but it is fitted and warned the
    # same way, and unknown columns were rejected at the API edge.
    if cfg.expert_core and "expert" in cfg.cores:
        cols = [c for c in cfg.expert_core if c in by_col]
        if cols:
            tick(1, 1, "fitting the expert core")
            lean = fit_columns(cols)
            cores.append(Core(name="expert", columns=cols,
                              variables=[_variable_spec(by_col[c]) for c in cols],
                              warnings=_cyclical_warnings(cols), lean=lean,
                              coefficients=_coef_map(lean),
                              steps=[{"action": "expert", "column": c}
                                     for c in cols]))

    # Two cores with the same variable set are one core: keep the first, which
    # preserves the stepwise lineage over the strong one.
    seen: set[frozenset] = set()
    unique: list[Core] = []
    for core in cores:
        key = frozenset(core.columns)
        if key in seen:
            continue
        seen.add(key)
        unique.append(core)
    return unique
