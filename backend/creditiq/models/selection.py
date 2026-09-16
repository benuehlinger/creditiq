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
import itertools
import json
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd
from scipy.stats import chi2

from .. import store
from ..data.portfolios import PORTFOLIOS
from . import design as D
from . import fit as F
from . import metrics as M
from .naming import friendly_name
from .spec import MevSpec, ModelSpec, SampleSpec, VariableSpec
from .versions import data_fingerprint

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
    # After the screen, keep this many variants per family (best p first)
    # before enumerating. The screen is loose by design, so without a cap a
    # family can put six near-identical transforms of itself into the
    # enumeration and the combination count explodes combinatorially. Two per
    # family keeps a transform rivalry alive without that.
    mev_top_per_family: int = 2
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


# ── stage 2: macro terms ─────────────────────────────────────────────────────
class MevBank:
    """Standardised macro columns for one frame, shared across many fits.

    Stage 2 fits a core plus one macro variant hundreds of times. Rebuilding
    the whole design for each fit costs a couple of seconds; the core columns
    never change, so the design is built ONCE per core and each candidate fit
    appends only its macro column. The bank computes, standardises and caches
    those columns per frame. `stats` reuses another bank's means and standard
    deviations, which is how the full-frame scoring design applies the fit
    frame's standardisation, exactly as `design.build` does with train maps.
    """

    def __init__(self, df: pd.DataFrame, stats: dict | None = None):
        self.dates = pd.DatetimeIndex(df["performance_date"])
        self.stats: dict[tuple, tuple[float, float]] = stats if stats is not None else {}
        self._own_stats = stats is None
        self._cols: dict[tuple, np.ndarray] = {}

    def col(self, m: MevSpec) -> np.ndarray:
        key = (m.key, m.transform, m.lag_months)
        if key not in self._cols:
            vals = D.mev_series(m).reindex(self.dates).to_numpy(float)
            vals = np.nan_to_num(vals, nan=float(np.nanmedian(vals)))
            if self._own_stats:
                self.stats[key] = (float(vals.mean()),
                                   float(vals.std()) or 1.0)
            mu, sd = self.stats.get(key, (float(vals.mean()),
                                          float(vals.std()) or 1.0))
            self._cols[key] = ((vals - mu) / sd).astype(np.float32)
        return self._cols[key]


def _augment(base: D.Design, mevs: tuple[MevSpec, ...], bank: MevBank) -> D.Design:
    """The base design with the macro columns appended, as one new Design.

    Identical to what `design.build` would produce for the same specification,
    modulo column order: macro columns standardised on the fit frame, one term
    each. The base is reused untouched, which is the entire point.
    """
    names = [f"mev:{m.label()}" for m in mevs]
    cols = [bank.col(m)[:, None] for m in mevs]
    X = np.column_stack([base.X, *cols]).astype(np.float32, copy=False)
    stats = [bank.stats[(m.key, m.transform, m.lag_months)] for m in mevs]
    means = np.concatenate([base.means, [s[0] for s in stats]])
    stds = np.concatenate([base.stds, [s[1] for s in stats]])
    return D.Design(X=X, columns=[*base.columns, *names], y=base.y,
                    dates=base.dates, accounts=base.accounts,
                    woe_maps=base.woe_maps, means=means, stds=stds,
                    basis_maps=base.basis_maps, terms=[*base.terms, *names])



def _sign_prior(portfolio: str):
    """The economic prior per macro base, under any spelling the book uses.

    Same resolution rule as analysis/mev_search.py: a portfolio declares its
    prior under the name it fits (`cre_price_index_yoy`), and every transform
    or lag of the base carries the same claim about direction.
    """
    raw = PORTFOLIOS[portfolio].expected_signs

    def prior_for(key: str) -> int | None:
        if key in raw:
            return raw[key]
        for suffix in ("_yoy", "_growth"):
            if f"{key}{suffix}" in raw:
                return raw[f"{key}{suffix}"]
        if key.endswith("_yoy") and key[:-4] in raw:
            return raw[key[:-4]]
        return None
    return prior_for


def mev_variants(cfg: SelectionConfig) -> list[MevSpec]:
    """The transform-and-lag universe, from the macro library's own rows.

    The library is already restricted to variables a scenario can carry
    forward, and its stationarity filter applies here for the same reason it
    exists at all: a non-stationary form correlates with anything that drifts.
    """
    from ..analysis import mev_search
    rows = mev_search.library(cfg.portfolio)["rows"]
    families = set(cfg.mev_families) if cfg.mev_families else None
    out = []
    for r in rows:
        if families is not None and r["key"] not in families:
            continue
        if not r.get("stationary", False):
            continue
        out.append(MevSpec(key=r["key"], transform=r["transform"],
                           lag_months=r["lag_months"]))
    return out


def screen_mevs(cfg: SelectionConfig, cores: list[Core],
                progress=None, cancel=None) -> dict[str, list[MevSpec]]:
    """One variant at a time against each core: right sign, loosely significant.

    The screen is deliberately loose (default p < 0.10) — its job is to cut a
    few hundred variants to a few dozen, not to pick the model. The sign check
    is against the fitted coefficient, not the univariate correlation, because
    the core is present: a variant that flips once the borrower variables are
    in has already shown what it would do inside a model.
    """
    fit_df, _ = _frames(cfg)
    prior_for = _sign_prior(cfg.portfolio)
    variants = mev_variants(cfg)
    bank = MevBank(fit_df)
    survivors: dict[str, list[MevSpec]] = {}
    total = len(cores) * len(variants)
    step = 0
    for core in cores:
        keep: list[MevSpec] = []
        for m in variants:
            step += 1
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            if progress:
                progress(step, total,
                         f"screening macro variants against the {core.name} "
                         f"core: {m.label()}")
            spec = _model_spec(cfg, core.variables, (m,))
            des = _augment(core.lean.design, (m,), bank)
            res = F.fit(des, spec)
            lean = Lean(fit=res, ll=res.log_likelihood, k=len(res.columns),
                        n_events=res.n_events_train, design=des)
            col = f"mev:{m.label()}"
            coef = next((c for c in lean.fit.coefficients if c.name == col), None)
            if coef is None:
                continue
            expected = prior_for(m.key)
            observed = 1 if coef.estimate > 0 else -1
            if expected is not None and observed != expected:
                continue
            if coef.p_value >= cfg.rules.mev_screen_p:
                continue
            keep.append((coef.p_value, m))
        # The strongest few variants per family carry into the enumeration;
        # the rest of a family's near-identical transforms do not multiply
        # the combination count.
        per_family: dict[str, int] = {}
        trimmed: list[MevSpec] = []
        for p_, m in sorted(keep, key=lambda t: t[0]):
            if per_family.get(m.key, 0) >= max(1, cfg.rules.mev_top_per_family):
                continue
            per_family[m.key] = per_family.get(m.key, 0) + 1
            trimmed.append(m)
        survivors[core.name] = trimmed
    return survivors


def _variant_correlations(variants: list[MevSpec],
                          lo: pd.Timestamp, hi: pd.Timestamp) -> dict:
    """Pairwise correlation of the transformed, lagged series over the
    estimation window, computed once per distinct variant."""
    series = {}
    for m in variants:
        s = D.mev_series(m)
        series[(m.key, m.transform, m.lag_months)] = \
            s.loc[(s.index >= lo) & (s.index <= hi)]
    corr: dict[tuple, float] = {}
    keys = list(series)
    for a, b in itertools.combinations(keys, 2):
        pair = pd.concat([series[a], series[b]], axis=1).dropna()
        if len(pair) < 12:
            corr[(a, b)] = 1.0        # too little overlap to defend the pair
            continue
        r = float(pair.iloc[:, 0].corr(pair.iloc[:, 1]))
        corr[(a, b)] = 0.0 if np.isnan(r) else r
    return corr


def _combo_allowed(combo: tuple[MevSpec, ...], corr: dict, cap: float) -> bool:
    """The family rules. One variant per underlying series (which also forbids
    the same series at two lags — kept as its own check so the rule survives a
    refactor of the family definition), and no highly correlated pair."""
    keys = [m.key for m in combo]
    if len(set(keys)) != len(keys):
        return False
    for a, b in itertools.combinations(combo, 2):
        if a.key == b.key and a.lag_months != b.lag_months:
            return False
        ka = (a.key, a.transform, a.lag_months)
        kb = (b.key, b.transform, b.lag_months)
        r = corr.get((ka, kb), corr.get((kb, ka)))
        if r is not None and abs(r) > cap:
            return False
    return True


def enumerate_combos(cfg: SelectionConfig,
                     survivors: dict[str, list[MevSpec]]) -> dict[str, list[tuple[MevSpec, ...]]]:
    """Every 1-to-3 combination of a core's surviving variants, constrained."""
    fit_df, _ = _frames(cfg)
    lo = pd.Timestamp(fit_df["performance_date"].min())
    hi = pd.Timestamp(fit_df["performance_date"].max())
    distinct: dict[tuple, MevSpec] = {}
    for ms in survivors.values():
        for m in ms:
            distinct[(m.key, m.transform, m.lag_months)] = m
    corr = _variant_correlations(list(distinct.values()), lo, hi)

    out: dict[str, list[tuple[MevSpec, ...]]] = {}
    r = cfg.rules
    for name, ms in survivors.items():
        combos: list[tuple[MevSpec, ...]] = []
        for size in range(r.min_mevs, r.max_mevs + 1):
            for combo in itertools.combinations(ms, size):
                if _combo_allowed(combo, corr, r.mev_corr_cap):
                    combos.append(combo)
        out[name] = combos
    return out


def _core_shift(core: Core, lean: Lean, pct: float) -> list[dict]:
    """Core coefficients after the macro terms joined, against the core alone.

    A macro term is supposed to add the cycle, not rewrite the borrower story.
    A sign flip or a large shift on a core term means the macro variant is
    fighting a driver for the same effect, and the row says so.
    """
    after = {c.name: c.estimate for c in lean.fit.coefficients}
    flags = []
    for name, before in core.coefficients.items():
        now = after.get(name)
        if now is None:
            continue
        flipped = before * now < 0 and abs(before) > 1e-8
        shift = abs(now - before) / abs(before) * 100.0 if abs(before) > 1e-8 else 0.0
        if flipped or shift > pct:
            flags.append({"column": name, "before": float(before),
                          "after": float(now), "flipped": bool(flipped),
                          "shift_pct": float(shift)})
    return flags


def joint_fit_rows(cfg: SelectionConfig, cores: list[Core],
                   combos: dict[str, list[tuple[MevSpec, ...]]],
                   progress=None, cancel=None) -> list[dict]:
    """Stage 3: fit every core-plus-combination jointly and emit leaderboard rows.

    All coefficients are re-estimated — the core is a starting point, not a
    frozen block — and the row records what the re-estimation did to it.
    Identical variable sets from different cores share a spec hash and merge
    into one row with both lineages.
    """
    fit_df, full_df = _frames(cfg)
    oot = full_df["performance_date"] >= pd.Timestamp(cfg.oot_from)
    prior_for = _sign_prior(cfg.portfolio)
    rules = cfg.rules
    by_hash: dict[str, dict] = {}
    total = sum(len(v) for v in combos.values())
    step = 0
    bank = MevBank(fit_df)
    for core in cores:
        # The core's design is fitted; each combination appends only its
        # macro columns. The full-frame copy is built once per core with the
        # fit frame's maps, for out-of-time scoring.
        core_all = D.build(full_df, _model_spec(cfg, core.variables),
                           woe_maps=core.lean.fit.woe_maps,
                           means=core.lean.fit.means,
                           stds=core.lean.fit.stds,
                           basis_maps=core.lean.fit.basis_maps)
        bank_all = MevBank(full_df, stats=bank.stats)
        for combo in combos.get(core.name, []):
            step += 1
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            spec = _model_spec(cfg, core.variables, combo)
            h = spec.hash()
            label = " + ".join(m.label() for m in combo)
            if progress:
                progress(step, total,
                         f"fitting {core.name} core + {label}")
            if h in by_hash:
                by_hash[h]["lineage"].append(
                    {"core": core.name, "method": "stepwise+mev_enum"})
                continue
            des = _augment(core.lean.design, combo, bank)
            res = F.fit(des, spec)
            lean = Lean(fit=res, ll=res.log_likelihood, k=len(res.columns),
                        n_events=res.n_events_train, design=des)

            # out-of-time discrimination: score the full screening frame with
            # the fit frame's standardisation, then read the two partitions
            des_all = _augment(core_all, combo, bank_all)
            p_all = F.predict(des_all.X, lean.fit.beta)
            y_all = des_all.y
            in_mask = ~oot.to_numpy()
            auc_in, ks_in, _ = M.auc_and_ks(y_all[in_mask], p_all[in_mask])
            oot_mask = oot.to_numpy()
            if y_all[oot_mask].sum() >= 5:
                auc_oot, ks_oot, _ = M.auc_and_ks(y_all[oot_mask], p_all[oot_mask])
            else:
                auc_oot = ks_oot = None

            # What the stress check needs later, without refitting: each macro
            # column's standardisation, and the log-odds level of the recent
            # book to anchor the stressed PD path on.
            mev_scale: dict[str, dict] = {}
            for m in combo:
                col = f"mev:{m.label()}"
                if col in lean.fit.columns:
                    i = lean.fit.columns.index(col) - 1     # means/stds skip the intercept
                    mev_scale[col] = {"mean": float(lean.fit.means[i]),
                                      "std": float(lean.fit.stds[i])}
            dates_all = pd.DatetimeIndex(des_all.dates)
            recent = dates_all >= dates_all.max() - pd.DateOffset(months=12)
            p_recent = float(np.clip(p_all[recent].mean(), 1e-8, 1 - 1e-8))
            anchor_logit = float(np.log(p_recent / (1.0 - p_recent)))

            named = [c for c in lean.fit.coefficients if c.name != "intercept"
                     and c.term != "seasoning"]
            max_p = max((c.p_value for c in named), default=None)
            vif_by_term = {c.term: c.term_vif for c in named if c.term_vif}
            max_vif = max(vif_by_term.values(), default=None)

            sign_checks = []
            for m in combo:
                col = f"mev:{m.label()}"
                coef = next((c for c in lean.fit.coefficients
                             if c.name == col), None)
                expected = prior_for(m.key)
                observed = (1 if coef.estimate > 0 else -1) if coef else None
                sign_checks.append({
                    "mev": m.key, "term": col, "transform": m.transform,
                    "lag_months": m.lag_months, "expected_sign": expected,
                    "observed_sign": observed,
                    "ok": None if expected is None or observed is None
                    else bool(expected == observed)})

            shifts = _core_shift(core, lean, rules.core_shift_pct)

            row = {
                "hash": h, "name": friendly_name(h),
                "spec": spec.to_dict(),
                "lineage": [{"core": core.name, "method": "stepwise+mev_enum"}],
                "n_predictors": len(core.variables) + len(combo),
                "n_core": len(core.variables),
                "core_columns": list(core.columns),
                "core_warnings": list(core.warnings),
                "mevs": [{"key": m.key, "transform": m.transform,
                          "lag_months": m.lag_months, "label": m.label()}
                         for m in combo],
                "n_mevs": len(combo),
                "sign_checks": sign_checks,
                "signs_ok": all(s["ok"] is not False for s in sign_checks),
                "max_p": None if max_p is None else float(max_p),
                "all_significant": (max_p is not None
                                    and max_p < rules.p_cutoff),
                "max_vif": None if max_vif is None else float(max_vif),
                "core_shifts": shifts,
                "core_shifted": bool(shifts),
                "auc_in": float(auc_in), "ks_in": float(ks_in),
                "auc_oot": None if auc_oot is None else float(auc_oot),
                "ks_oot": None if ks_oot is None else float(ks_oot),
                "converged": bool(lean.fit.converged),
                "separation_warning": lean.fit.separation_warning,
                "coefficients": [
                    {"name": c.name, "estimate": c.estimate,
                     "std_error": c.std_error, "p_value": c.p_value,
                     "term": c.term, "term_vif": c.term_vif}
                    for c in lean.fit.coefficients],
                "mev_scale": mev_scale,
                "anchor_logit": anchor_logit,
                "filtered": False, "filter_reason": None,
            }
            if rules.p_rule == "filter" and not row["all_significant"]:
                row["filtered"], row["filter_reason"] = True, "p_cutoff"
            if (rules.vif_rule == "filter" and rules.max_vif
                    and max_vif is not None and max_vif > rules.max_vif):
                row["filtered"], row["filter_reason"] = True, "max_vif"
            by_hash[h] = row
    return [r for r in by_hash.values() if not r["filtered"]] + \
           [r for r in by_hash.values() if r["filtered"]]


# ── stress behaviour, without a projection run ───────────────────────────────
def available_scenarios() -> list[str]:
    from ..mev import scenarios as scen
    published, _ = scen.load_all()
    return [n for n in SEVERITY_ORDER if n in published]


def stress_check(cfg: SelectionConfig, rows: list[dict],
                 progress=None, cancel=None) -> None:
    """Attach stress behaviour to every row from coefficients alone.

    Contract #3: a scenario reaches a model only through its macro terms, with
    internal variables frozen at the reporting date. So the stressed shift in
    log-odds is exactly the sum of the macro coefficients times the change in
    their standardised series along the scenario path — no design build, no
    account-level projection. The stressed PD path is that shift applied to
    the recent book's anchor rate, which is the portfolio-level read a
    leaderboard needs; the account-level number stays a projection-run affair.
    """
    from . import scenario_service as scensvc
    if not rows:
        return
    _, full_df = _frames(cfg)
    as_of = pd.Timestamp(full_df["performance_date"].max())
    names = available_scenarios()
    paths = {n: scensvc.scenario_mev_path(n, as_of) for n in names}

    # each variant's transformed, lagged series along each scenario path,
    # computed once and shared across every row that carries the variant
    series: dict[tuple, dict[str, pd.Series]] = {}

    def variant_series(m: dict) -> dict[str, pd.Series]:
        key = (m["key"], m["transform"], m["lag_months"])
        if key not in series:
            per = {}
            for n in names:
                base = paths[n].get(m["key"])
                if base is None:
                    per[n] = None
                    continue
                s = D.apply_mev_transform(base, m["transform"])
                if m["lag_months"]:
                    s = s.shift(m["lag_months"])
                per[n] = s
            series[key] = per
        return series[key]

    for i, row in enumerate(rows, 1):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if progress:
            progress(i, len(rows), f"stress behaviour: {row['name']}")
        beta = {c["name"]: c["estimate"] for c in row["coefficients"]}
        peak_pd: dict[str, float] = {}
        severe_path: pd.Series | None = None
        usable = True
        for n in names:
            shift = None
            for m in row["mevs"]:
                col = f"mev:{m['label']}"
                scale = row["mev_scale"].get(col)
                s = variant_series(m)[n]
                if scale is None or s is None or col not in beta:
                    usable = False
                    break
                fwd = s.loc[s.index > as_of]
                x0 = float(s.loc[:as_of].iloc[-1])
                term = beta[col] * (fwd - x0) / (scale["std"] or 1.0)
                shift = term if shift is None else shift.add(term, fill_value=0.0)
            if not usable or shift is None or shift.empty:
                usable = False
                break
            pd_path = 1.0 / (1.0 + np.exp(-(row["anchor_logit"] + shift)))
            peak_pd[n] = float(pd_path.max())
            if n == names[-1]:
                severe_path = pd_path
        if not usable:
            row["stress"] = {"usable": False, "monotone": None,
                             "peak_pd": None, "smoothness": None,
                             "scenarios": names}
            continue
        peaks = [peak_pd[n] for n in names]
        monotone = all(b >= a - 1e-9 for a, b in zip(peaks, peaks[1:]))
        smooth = float(np.abs(np.diff(severe_path.to_numpy(), n=2)).max()) \
            if severe_path is not None and len(severe_path) > 2 else 0.0
        row["stress"] = {
            "usable": True, "monotone": bool(monotone),
            "peak_pd": {n: peak_pd[n] for n in names},
            "peak_stressed_pd": peaks[-1],
            "anchor_pd": float(1.0 / (1.0 + np.exp(-row["anchor_logit"]))),
            "smoothness": smooth, "scenarios": names,
        }


# ── ranking and finalists ────────────────────────────────────────────────────
# The composite is deliberately simple and stated in full in METHODOLOGY.md:
# normalised out-of-time discrimination carries the most weight, then the
# checks a validator applies first. It orders the board; it decides nothing.
COMPOSITE_WEIGHTS = {
    "auc_oot": 0.40, "all_significant": 0.15, "stress_monotone": 0.15,
    "no_core_shift": 0.10, "vif": 0.10, "oot_gap": 0.10,
}


def composite_rank(rows: list[dict]) -> None:
    """Score and rank every unfiltered row in place. Lean metrics only, so the
    score means the same thing for every row whether or not it was a finalist."""
    live = [r for r in rows if not r["filtered"]]
    if not live:
        return
    aucs = [r["auc_oot"] if r["auc_oot"] is not None else r["auc_in"]
            for r in live]
    lo, hi = min(aucs), max(aucs)
    span = (hi - lo) or 1.0
    for r, a in zip(live, aucs):
        gap = max(0.0, r["auc_in"] - a)
        vif = r["max_vif"] or 1.0
        stress_ok = bool((r.get("stress") or {}).get("monotone"))
        r["score"] = float(
            COMPOSITE_WEIGHTS["auc_oot"] * (a - lo) / span
            + COMPOSITE_WEIGHTS["all_significant"] * float(r["all_significant"])
            + COMPOSITE_WEIGHTS["stress_monotone"] * float(stress_ok)
            + COMPOSITE_WEIGHTS["no_core_shift"] * float(not r["core_shifted"])
            + COMPOSITE_WEIGHTS["vif"] * min(1.0, 1.0 / vif)
            + COMPOSITE_WEIGHTS["oot_gap"] * max(0.0, 1.0 - gap / 0.10))
    live.sort(key=lambda r: -r["score"])
    for i, r in enumerate(live, 1):
        r["auto_rank"] = i
    for r in rows:
        if r["filtered"]:
            r["score"] = None
            r["auto_rank"] = None


def run_finalists(cfg: SelectionConfig, rows: list[dict],
                  progress=None, cancel=None) -> None:
    """The full treatment for the top of the board: a real service.run, whose
    backtest errors and decile capture the lean path cannot produce. Capped at
    rules.top_n_full, safely below the run cache's own bound."""
    from . import service
    finalists = [r for r in rows if r.get("auto_rank")
                 and r["auto_rank"] <= cfg.rules.top_n_full]
    for i, row in enumerate(finalists, 1):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if progress:
            progress(i, len(finalists),
                     f"full fit and backtest: {row['name']} "
                     f"(rank {row['auto_rank']})")
        spec = ModelSpec.from_dict(row["spec"])
        r = service.run(spec)
        errors = r.backtest.get("errors") or {}
        gains = (r.diagnostics or {}).get("gains") or []
        top = gains[0] if gains else {}
        row["finalist"] = True
        row["full"] = {
            "auc_test": (r.diagnostics.get("test") or {}).get("auc"),
            "auc_oot": (r.diagnostics.get("oot") or {}).get("auc"),
            "errors_in_time": errors.get("in_time"),
            "errors_oot": errors.get("out_of_time"),
            "top_decile_capture_pct": top.get("capture_pct"),
            "top_decile_lift": top.get("lift"),
        }
    for r in rows:
        r.setdefault("finalist", False)


# ── the whole search ─────────────────────────────────────────────────────────
N_STAGES = 4


def preview(cfg: SelectionConfig) -> dict:
    """What a run would cost, without fitting anything. The combination count
    depends on how many variants survive the screen, so it is reported as the
    screen size plus the formula, and exactly once the screen has run."""
    n_cand = sum(1 for c in cfg.candidates if c.role == "candidate")
    variants = mev_variants(cfg)
    n_cores = len([c for c in cfg.cores if c != "expert" or cfg.expert_core])
    screen_fits = n_cores * len(variants)
    # stepwise cost is quadratic in candidates at worst
    stage1_bound = n_cand * (n_cand + 1)
    warning = None
    if screen_fits > 1500:
        warning = (f"The screen alone is {screen_fits:,} fits. Narrow the "
                   f"macro families or the candidate list, or expect a run "
                   f"of ten minutes or more.")
    return {
        "n_candidates": n_cand,
        "n_mev_variants": len(variants),
        "n_cores": n_cores,
        "stage1_fit_bound": stage1_bound,
        "screen_fits": screen_fits,
        "combos_note": ("Combinations of 1 to 3 are enumerated from the "
                        "variants that survive the screen; with s survivors "
                        "that is at most s + s(s-1)/2 + s(s-1)(s-2)/6 "
                        "per core, and the exact count is reported when "
                        "screening finishes."),
        "warning": warning,
    }


def run_search(cfg: SelectionConfig, progress=None, cancel=None,
               checkpoint=None) -> dict:
    """The four stages, end to end. `progress(stage_no, n_stages, step, total,
    label)` fires before every fit; `checkpoint(payload)` is called with the
    lean board before the finalist stage, so a crash there still leaves a
    usable result."""
    def stage(no: int):
        def cb(step, total, label):
            if progress:
                progress(no, N_STAGES, step, total, label)
        return cb

    cores = build_cores(cfg, progress=stage(1), cancel=cancel)
    if not cores:
        raise ValueError(
            "no core survived the stepwise rules — loosen the entry rule or "
            "add candidate variables")
    survivors = screen_mevs(cfg, cores, progress=stage(2), cancel=cancel)
    combos = enumerate_combos(cfg, survivors)
    n_combos = sum(len(v) for v in combos.values())
    if n_combos == 0:
        raise ValueError(
            "no macro variant survived the screen on any core — every emitted "
            "model must carry a macro term, so there is nothing to enumerate. "
            "Loosen the screen p-value or widen the macro families")
    rows = joint_fit_rows(cfg, cores, combos, progress=stage(3), cancel=cancel)
    stress_check(cfg, rows, progress=stage(3), cancel=cancel)
    composite_rank(rows)

    payload = {
        "config": cfg.to_dict(),
        "config_hash": cfg.hash(),
        "portfolio": cfg.portfolio,
        "data_fingerprint": data_fingerprint(cfg.portfolio),
        "generated_at": pd.Timestamp.utcnow().isoformat(timespec="seconds"),
        "scenarios": available_scenarios(),
        "cores": [{"name": c.name, "columns": c.columns,
                   "warnings": c.warnings, "steps": c.steps} for c in cores],
        "survivors": {k: [m.label() for m in v] for k, v in survivors.items()},
        "n_combos": n_combos,
        "n_rows": len(rows),
        "n_filtered": sum(1 for r in rows if r["filtered"]),
        "rows": rows,
    }
    if checkpoint:
        checkpoint(payload)
    run_finalists(cfg, rows, progress=stage(4), cancel=cancel)
    return payload
