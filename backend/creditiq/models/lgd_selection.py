"""Automated severity-model selection: the LGD twin of `selection.py`.

The architecture is deliberately the same four stages — cores, screen,
enumerate, rank — because the leaderboard, provenance view and review flow in
the UI are metric-agnostic and must serve both targets. What changes is the
model and the yardstick:

  * the model is the fractional-logit severity fit (`lgd.fit_lgd`) on
    resolved defaults, not the discrete-time hazard on account-months;
  * the headline statistic is OUT-OF-TIME MAE in loss points, not AUC.
    MAE, deliberately: severity is bimodal (mass at full recovery and at
    full loss), which RMSE lets a handful of tail outcomes dominate, and
    MAPE is rejected outright — dividing by near-zero actuals explodes on
    exactly the full recoveries a model predicts well;
  * stress direction flips: the severe scenario must push severity UP.

Shared pieces are imported from `selection`, not copied: the macro-term
parsing, the family rule, the correlation cap, the collinearity credit
`_vif_credit`, and the scenario ordering. Row names are
`friendly_name(LgdSpec.hash())` — the severity half's OWN name, the same one
the LGD surface and the collated Model name use, so a leaderboard row keeps
its name all the way into a saved pairing.

Severity data is thin (thousands of resolved defaults, not millions of
account-months), so fits are cheap and the search fits every combination in
full; there is no lean-versus-full split of the fit itself. "Finalists" still
exist: only the top of the board earns the full diagnostic panel and the
refit-based backtest.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import store
from ..mev import panel as mevpanel
from .naming import friendly_name
from .spec import LgdSpec
from . import design as D
from . import lgd as LGD
from . import lgd_diag
from .selection import (
    Cancelled, MevSpec, SelectionRules, VIF_FLAG_DEFAULT,
    _vif_credit, available_scenarios, mev_family,
)

N_STAGES = 4


# ── configuration ────────────────────────────────────────────────────────────
@dataclass
class LgdSelectionConfig:
    portfolio: str
    """Candidate severity drivers, by column, all treated as continuous."""
    candidates: list[str] = field(default_factory=list)
    cores: list[str] = field(default_factory=lambda: ["stepwise", "strong"])
    expert_core: list[str] | None = None
    """Macro terms as `key@transform@lag`, verbatim from the Macro surface's
    LGD shortlist — the search never sweeps the transformation library."""
    mev_terms: list[str] = field(default_factory=list)
    rules: SelectionRules = field(default_factory=SelectionRules)
    oot_from: str = "2023-01-01"

    def __post_init__(self) -> None:
        if isinstance(self.rules, dict):
            self.rules = SelectionRules(**self.rules)

    def canonical(self) -> dict:
        return {
            "target": "lgd",
            "portfolio": self.portfolio,
            "candidates": sorted(self.candidates),
            "cores": sorted(self.cores),
            "expert_core": sorted(self.expert_core) if self.expert_core else None,
            "mev_terms": sorted(self.mev_terms),
            "rules": vars(self.rules),
            "oot_from": self.oot_from,
        }

    def hash(self) -> str:
        blob = json.dumps(self.canonical(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = self.canonical()
        d["hash"] = self.hash()
        return d

    @staticmethod
    def from_dict(d: dict) -> "LgdSelectionConfig":
        d = dict(d)
        d.pop("hash", None)
        d.pop("target", None)
        return LgdSelectionConfig(**d)


def parse_term(term: str) -> MevSpec:
    key, transform, lag = term.split("@")
    return MevSpec(key=key, transform=transform, lag_months=int(lag))


# ── frames ───────────────────────────────────────────────────────────────────
def _frames(cfg: LgdSelectionConfig) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(in-time defaults, all defaults), with every shortlisted macro column
    attached once. Fits see only resolutions before the boundary; the rows
    after it are the out-of-time yardstick."""
    df = store.analysis_frame(cfg.portfolio)
    d = df.loc[df["default_flag"] == 1].copy()
    d = LGD.attach_macro(d, mevpanel.monthly_panel(), tuple(cfg.mev_terms))
    cut = pd.Timestamp(cfg.oot_from)
    return d.loc[pd.DatetimeIndex(d["performance_date"]) < cut], d


# ── one fitted specification, measured ───────────────────────────────────────
def _vifs(X: np.ndarray, names: list[str]) -> dict[str, float]:
    """Variance inflation per design column, intercept excluded."""
    keep = [i for i, n in enumerate(names) if n != "intercept"]
    if len(keep) < 2:
        return {names[i]: 1.0 for i in keep}
    Z = X[:, keep]
    sd = Z.std(axis=0)
    ok = sd > 1e-12
    out = {names[keep[i]]: 1.0 for i in range(len(keep))}
    idx = [keep[i] for i in range(len(keep)) if ok[i]]
    if len(idx) < 2:
        return out
    Zs = (X[:, idx] - X[:, idx].mean(axis=0)) / X[:, idx].std(axis=0)
    corr = np.corrcoef(Zs, rowvar=False)
    try:
        inv = np.linalg.inv(corr)
    except np.linalg.LinAlgError:
        inv = np.linalg.pinv(corr)
    for j, i in enumerate(idx):
        out[names[i]] = float(max(1.0, inv[j, j]))
    return out


def _quasi_ll(pred: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(pred, 1e-9, 1 - 1e-9)
    return float(np.sum(y * np.log(p) + (1 - y) * np.log(1 - p)))


def _bic(ll: float, k: int, n: int) -> float:
    return -2.0 * ll + k * np.log(max(n, 1))


@dataclass
class _Fit:
    model: LGD.LgdModel
    ll: float
    bic: float
    mae_in: float
    coef: dict[str, dict]       # column -> {coefficient, p_value}
    vif: dict[str, float]


def _fit(train: pd.DataFrame, spec: LgdSpec) -> _Fit:
    m = LGD.fit_lgd(train, spec, mevpanel.monthly_panel())
    X = LGD.design_for(train, m)
    y = np.clip(train["lgd_realised"].to_numpy(float), 0.0, 1.0)
    pred = m.predict(X)
    ll = _quasi_ll(pred, y)
    coef = {c["column"]: c for c in m.coefficients}
    k = sum(1 for c in m.coefficients if c["column"] != "intercept")
    return _Fit(model=m, ll=ll, bic=_bic(ll, k, len(y)),
                mae_in=float(np.mean(np.abs(y - pred))),
                coef=coef, vif=_vifs(X, m.columns))


def _score_oot(fit: _Fit, test: pd.DataFrame) -> tuple[float | None, float | None]:
    """MAE and RMSE on resolutions after the boundary, scored with the
    in-time fit. Below 20 defaults the interval is too wide to report a
    number as if it meant something — the row says so instead."""
    if len(test) < 20:
        return None, None
    X = LGD.design_for(test, fit.model)
    y = np.clip(test["lgd_realised"].to_numpy(float), 0.0, 1.0)
    pred = fit.model.predict(X)
    return (float(np.mean(np.abs(y - pred))),
            float(np.sqrt(np.mean((y - pred) ** 2))))


# ── stage 1: severity cores ──────────────────────────────────────────────────
@dataclass
class Core:
    name: str
    drivers: list[str]
    fit: _Fit
    steps: list[dict]


def build_cores(cfg: LgdSelectionConfig, train: pd.DataFrame,
                progress=None, cancel=None) -> list[Core]:
    """Forward stepwise on the driver candidates.

    The entry test is the candidate's ROBUST WALD p-value beside the drivers
    already selected, not a BIC on the quasi-likelihood. The fractional-logit
    objective is a quasi-likelihood (Papke and Wooldridge): its value is a
    valid estimation target but NOT a likelihood, so information criteria
    computed from it are on an uncalibrated scale. The sandwich standard
    errors are the part of this model that IS valid inference, so the Wald
    test is what a defensible entry rule stands on. The threshold is
    `rules.entry_threshold` (default 0.01).

    The SAME VIF cap the PD search applies gates entry — a severity core born
    collinear taints every enumerated model at once. And every candidate that
    ends the search outside the core is recorded in the trace WITH the
    conditional p-value that kept it out: on a book where one driver carries
    the severity story (collateral on a mortgage book), "only one variable
    came out" must read as a finding with evidence, never as a mystery."""
    rules = cfg.rules
    vif_cap = rules.max_vif if rules.max_vif and rules.max_vif > 0 else None
    p_entry = rules.entry_threshold if rules.entry_threshold else 0.01

    def tick(step, total, label):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if progress:
            progress(step, total, label)

    def fit_drivers(cols: list[str]) -> _Fit:
        return _fit(train, LgdSpec(portfolio=cfg.portfolio, drivers=tuple(cols)))

    steps: list[dict] = []
    vif_blocked: dict[str, float] = {}
    last_p: dict[str, float | None] = {}
    selected: list[str] = []
    current: _Fit | None = None
    remaining = [c for c in cfg.candidates]
    passnum = 0
    while remaining:
        passnum += 1
        best: tuple[float, str, _Fit] | None = None
        for i, col in enumerate(remaining, 1):
            tick(i, len(remaining),
                 f"building the severity stepwise core (pass {passnum}): testing {col}")
            try:
                cand = fit_drivers(selected + [col])
            except (ValueError, KeyError):
                last_p[col] = None
                continue
            p = (cand.coef.get(col) or {}).get("p_value")
            last_p[col] = None if p is None else float(p)
            passes = p is not None and p < p_entry
            if passes and vif_cap is not None:
                worst = max(cand.vif.values(), default=1.0)
                if worst > vif_cap:
                    vif_blocked[col] = float(worst)
                    continue
            if passes and (best is None or p < best[0]):
                best = (p, col, cand)
        if best is None:
            break
        p, col, cand = best
        selected.append(col)
        remaining.remove(col)
        vif_blocked.pop(col, None)
        last_p.pop(col, None)
        steps.append({"action": "enter", "column": col,
                      "score": float(p), "metric": "p_value"})
        current = cand
    for col, v in sorted(vif_blocked.items()):
        steps.append({"action": "vif_block", "column": col,
                      "vif": v, "cap": vif_cap})
        last_p.pop(col, None)
    # The candidates that stayed out, each with the evidence that kept it out.
    for col in cfg.candidates:
        if col in last_p and col not in selected:
            p = last_p[col]
            steps.append({
                "action": "rejected", "column": col,
                "p": p, "threshold": p_entry,
                "reason": (f"p = {p:.3f} beside the selected drivers — no "
                           f"incremental severity signal" if p is not None
                           else "the fit produced no usable coefficient")})

    cores: list[Core] = []
    if selected and "stepwise" in cfg.cores and current is not None:
        cores.append(Core("stepwise", list(selected), current, list(steps)))

    # The strong core: drop each selected driver and keep the few whose
    # removal costs the most quasi-likelihood.
    if (selected and "strong" in cfg.cores
            and len(selected) > cfg.rules.strong_core_size and current is not None):
        drops: dict[str, float] = {}
        for i, col in enumerate(selected, 1):
            tick(i, len(selected), f"strong severity core: re-testing {col}")
            without = fit_drivers([c for c in selected if c != col])
            drops[col] = float(2.0 * (current.ll - without.ll))
        keep = sorted(sorted(selected, key=lambda c: -drops[c])
                      [: cfg.rules.strong_core_size], key=selected.index)
        cores.append(Core("strong", keep, fit_drivers(keep),
                          [{"action": "keep", "column": c, "lr_drop": drops[c]}
                           for c in keep]))

    if cfg.expert_core and "expert" in cfg.cores:
        cols = list(cfg.expert_core)
        tick(1, 1, "fitting the expert severity core")
        cores.append(Core("expert", cols, fit_drivers(cols),
                          [{"action": "expert", "column": c} for c in cols]))

    seen: set[frozenset] = set()
    unique = []
    for c in cores:
        key = frozenset(c.drivers)
        if key in seen:
            continue
        seen.add(key)
        unique.append(c)
    return unique


# ── stage 2: screen the shortlist beside each core ───────────────────────────
def screen_terms(cfg: LgdSelectionConfig, cores: list[Core], train: pd.DataFrame,
                 progress=None, cancel=None):
    """Each shortlisted term is fitted once beside each core and survives on a
    loose p cutoff. Removals are reported with their reason, never silent."""
    rules = cfg.rules
    survivors: dict[str, list[str]] = {}
    screened_out: list[dict] = []
    terms = list(cfg.mev_terms)
    for core in cores:
        keep = []
        for i, t in enumerate(terms, 1):
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            if progress:
                progress(i, len(terms), f"screening {t} beside the {core.name} core")
            try:
                f = _fit(train, LgdSpec(portfolio=cfg.portfolio,
                                        drivers=tuple(core.drivers + [t])))
            except (ValueError, KeyError):
                screened_out.append({"core": core.name, "label": t,
                                     "reason": "the term produced no usable column "
                                               "on the resolved-default frame"})
                continue
            c = f.coef.get(t)
            p = c.get("p_value") if c else None
            if c is None:
                screened_out.append({"core": core.name, "label": t,
                                     "reason": "dropped by the fit"})
            elif p is None or p > rules.mev_screen_p:
                screened_out.append({
                    "core": core.name, "label": t,
                    "reason": f"p = {p:.3f} beside this core, over the "
                              f"screen at {rules.mev_screen_p}" if p is not None
                    else "no standard error beside this core"})
            else:
                keep.append(t)
        survivors[core.name] = keep
    return survivors, screened_out


def _combos(cfg: LgdSelectionConfig, survivors: dict[str, list[str]],
            train: pd.DataFrame) -> dict[str, list[tuple[str, ...]]]:
    """1-to-max combinations under the family rule and the correlation cap —
    the same constraints the PD enumeration applies, on the severity frame."""
    import itertools
    r = cfg.rules
    corr = train[[t for ts in survivors.values() for t in ts]].corr().abs() \
        if any(survivors.values()) else pd.DataFrame()
    out: dict[str, list[tuple[str, ...]]] = {}
    for name, ts in survivors.items():
        combos = []
        for size in range(r.min_mevs, r.max_mevs + 1):
            for combo in itertools.combinations(ts, size):
                fams = [mev_family(parse_term(t).key) for t in combo]
                if len(set(fams)) < len(fams):
                    continue
                if len(combo) > 1 and not corr.empty:
                    worst = max(corr.loc[a, b] for a, b in
                                itertools.combinations(combo, 2))
                    if worst > r.mev_corr_cap:
                        continue
                combos.append(combo)
        out[name] = combos
    return out


# ── stage 3: fit every combination and emit rows ─────────────────────────────
def joint_rows(cfg: LgdSelectionConfig, cores: list[Core],
               combos: dict[str, list[tuple[str, ...]]],
               train: pd.DataFrame, test: pd.DataFrame,
               progress=None, cancel=None) -> list[dict]:
    rules = cfg.rules
    by_hash: dict[str, dict] = {}
    total = sum(len(v) for v in combos.values())
    done = 0
    for core in cores:
        for combo in combos.get(core.name, []):
            done += 1
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            spec = LgdSpec(portfolio=cfg.portfolio,
                           drivers=tuple(core.drivers + list(combo)))
            h = spec.hash()
            if h in by_hash:
                by_hash[h]["lineage"].append(
                    {"core": core.name, "method": "stepwise+mev_enum"})
                continue
            if progress:
                progress(done, total,
                         f"severity fit {done}/{total}: {core.name} core + "
                         + " + ".join(combo))
            try:
                f = _fit(train, spec)
            except (ValueError, KeyError) as e:
                by_hash[h] = {"hash": h, "name": friendly_name(h),
                              "spec": spec.to_dict(), "error": str(e),
                              "filtered": True, "filter_reason": "fit_failed",
                              "lineage": [{"core": core.name,
                                           "method": "stepwise+mev_enum"}]}
                continue
            mae_oot, rmse_oot = _score_oot(f, test)
            named = [c for col, c in f.coef.items() if col != "intercept"]
            ps = [c["p_value"] for c in named if c.get("p_value") is not None]
            max_p = max(ps) if ps else None
            max_vif = max(f.vif.values(), default=None)
            shifts = _core_shift(core, f, rules.core_shift_pct)
            row = {
                "hash": h,
                # The severity half's own name — the same name the LGD surface
                # and the collated Model name will use for this specification.
                "name": friendly_name(h),
                "spec": spec.to_dict(),
                "lineage": [{"core": core.name, "method": "stepwise+mev_enum"}],
                "n_predictors": len(core.drivers) + len(combo),
                "n_core": len(core.drivers),
                "core_columns": list(core.drivers),
                "mevs": [{"key": parse_term(t).key,
                          "transform": parse_term(t).transform,
                          "lag_months": parse_term(t).lag_months,
                          "label": t} for t in combo],
                "n_mevs": len(combo),
                "coefficients": [
                    {"name": col, "estimate": c["coefficient"],
                     "std_error": c.get("std_error"), "p_value": c.get("p_value"),
                     "term": col, "term_vif": f.vif.get(col)}
                    for col, c in f.coef.items()],
                "max_p": None if max_p is None else float(max_p),
                "all_significant": max_p is not None and max_p < rules.p_cutoff,
                "max_vif": None if max_vif is None else float(max_vif),
                "core_shifts": shifts,
                "core_shifted": bool(shifts),
                "mae_in": f.mae_in,
                "mae_oot": mae_oot,
                "rmse_oot": rmse_oot,
                "deviance_r2": None,   # finalists carry the full panel
                "n_train": int(len(train)), "n_test": int(len(test)),
                "mean_lgd": f.model.mean_lgd,
                # columns[0] is the intercept; means/stds cover the
                # standardised columns only, so the lookup is offset by one.
                "mev_scale": {t: {"mean": float(f.model.means[f.model.columns.index(t) - 1]),
                                  "std": float(f.model.stds[f.model.columns.index(t) - 1])}
                              for t in combo
                              if t in f.model.columns
                              and f.model.columns.index(t) >= 1},
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


def _core_shift(core: Core, joint: _Fit, pct: float) -> list[dict]:
    """Driver coefficients after the macro terms joined, against the core
    alone — the same stability check the PD search applies. The macro term is
    supposed to add the cycle, not rewrite the collateral story."""
    flags = []
    for col, before_c in core.fit.coef.items():
        if col == "intercept":
            continue
        before = before_c["coefficient"]
        now_c = joint.coef.get(col)
        if now_c is None:
            continue
        now = now_c["coefficient"]
        flipped = before * now < 0 and abs(before) > 1e-8
        shift = abs(now - before) / abs(before) * 100.0 if abs(before) > 1e-8 else 0.0
        if flipped or shift > pct:
            flags.append({"column": col, "before": float(before),
                          "after": float(now), "flipped": bool(flipped),
                          "shift_pct": float(shift)})
    return flags


# ── stress behaviour: severity must WORSEN under stress ──────────────────────
def stress_check(cfg: LgdSelectionConfig, rows: list[dict], d_full: pd.DataFrame,
                 progress=None, cancel=None) -> None:
    """Contract #3, severity edition: a scenario reaches the model only
    through its macro terms. The stressed shift in the severity logit is the
    sum of the macro coefficients times the change in their standardised
    series along the path, applied to the portfolio's mean severity. The
    board reports whether PEAK severity orders by scenario severity — the
    severe path must push loss severity UP, not down."""
    from . import scenario_service as scensvc
    if not rows:
        return
    as_of = pd.Timestamp(d_full["performance_date"].max())
    names = available_scenarios()
    paths = {n: scensvc.scenario_mev_path(n, as_of) for n in names}
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
        if row.get("filtered"):
            row["stress"] = None
            continue
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if progress:
            progress(i, len(rows), f"severity stress behaviour: {row['name']}")
        beta = {c["name"]: c["estimate"] for c in row["coefficients"]}
        anchor = float(np.log(np.clip(row["mean_lgd"], 1e-4, 1 - 1e-4)
                              / (1 - np.clip(row["mean_lgd"], 1e-4, 1 - 1e-4))))
        peak: dict[str, float] = {}
        usable = True
        for n in names:
            shift = None
            for m in row["mevs"]:
                col = m["label"]
                scale = row["mev_scale"].get(col)
                s = variant_series(m)[n]
                if scale is None or s is None or col not in beta:
                    usable = False
                    break
                fwd = s.loc[s.index > as_of]
                x0 = float(s.loc[:as_of].iloc[-1]) if len(s.loc[:as_of]) else 0.0
                term = beta[col] * (fwd - x0) / (scale["std"] or 1.0)
                shift = term if shift is None else shift.add(term, fill_value=0.0)
            if not usable or shift is None or shift.empty:
                usable = False
                break
            sev = 1.0 / (1.0 + np.exp(-(anchor + shift)))
            peak[n] = float(sev.max())
        if not usable:
            row["stress"] = {"usable": False}
            continue
        peaks = [peak[n] for n in names]
        row["stress"] = {
            "usable": True,
            "monotone": bool(all(b >= a - 1e-9 for a, b in zip(peaks, peaks[1:]))),
            "anchor_severity": float(row["mean_lgd"]),
            "peak_stressed_severity": peaks[-1],
            "scenarios": names,
        }


# ── stage 4: rank, and the full panel for finalists ──────────────────────────
# Mirrors the PD composite weight for weight; the discrimination slot is
# out-of-time MAE (lower is better, min-max inverted over the board), and the
# gap term is the in-time-to-out-of-time MAE gap, in loss points.
COMPOSITE_WEIGHTS = {
    "mae_oot": 0.30, "all_significant": 0.15, "stress_monotone": 0.15,
    "no_core_shift": 0.10, "vif": 0.20, "oot_gap": 0.10,
}


def composite_rank(rows: list[dict], max_vif: float | None = None) -> None:
    live = [r for r in rows if not r["filtered"]]
    if not live:
        return
    flag = max_vif if max_vif and max_vif > 0 else VIF_FLAG_DEFAULT
    maes = [r["mae_oot"] if r["mae_oot"] is not None else r["mae_in"]
            for r in live]
    lo, hi = min(maes), max(maes)
    span = (hi - lo) or 1.0
    for r, mae in zip(live, maes):
        gap = max(0.0, (r["mae_oot"] or r["mae_in"]) - r["mae_in"])
        vif = r["max_vif"] or 1.0
        stress_ok = bool((r.get("stress") or {}).get("monotone"))
        r["score"] = float(
            COMPOSITE_WEIGHTS["mae_oot"] * (hi - mae) / span
            + COMPOSITE_WEIGHTS["all_significant"] * float(r["all_significant"])
            + COMPOSITE_WEIGHTS["stress_monotone"] * float(stress_ok)
            + COMPOSITE_WEIGHTS["no_core_shift"] * float(not r["core_shifted"])
            + COMPOSITE_WEIGHTS["vif"] * _vif_credit(vif, flag)
            + COMPOSITE_WEIGHTS["oot_gap"] * max(0.0, 1.0 - gap / 0.05))
    live.sort(key=lambda r: -r["score"])
    for i, r in enumerate(live, 1):
        r["auto_rank"] = i
    for r in rows:
        if r["filtered"]:
            r["score"] = None
            r["auto_rank"] = None


def run_finalists(cfg: LgdSelectionConfig, rows: list[dict],
                  train: pd.DataFrame, d_full: pd.DataFrame,
                  progress=None, cancel=None) -> None:
    """The full diagnostic panel and the refit backtest for the top of the
    board — deviance R², calibration cohorts, the link test, and the
    train-before/score-after backtest with its thin-sample honesty."""
    finalists = [r for r in rows if r.get("auto_rank")
                 and r["auto_rank"] <= cfg.rules.top_n_full]
    for i, row in enumerate(finalists, 1):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if progress:
            progress(i, len(finalists),
                     f"full severity diagnostics: {row['name']} "
                     f"(rank {row['auto_rank']})")
        spec = LgdSpec.from_dict(row["spec"])
        m = LGD.fit_lgd(train, spec, mevpanel.monthly_panel())
        diag = lgd_diag.diagnostics(m, train)
        row["deviance_r2"] = diag["deviance_r2"]
        row["finalist"] = True
        row["full"] = {
            "deviance_r2": diag["deviance_r2"],
            "spearman": diag["spearman"],
            "link_test_ok": (diag.get("link_test") or {}).get("ok"),
            "backtest": lgd_diag.backtest(m, d_full, cfg.oot_from),
        }
    for r in rows:
        r.setdefault("finalist", False)


# ── the whole search ─────────────────────────────────────────────────────────
def run_search(cfg: LgdSelectionConfig, progress=None, cancel=None,
               checkpoint=None) -> dict:
    def stage(no: int):
        def f(step, total, label):
            if progress:
                progress(no, N_STAGES, step, total, label)
        return f

    train, d_full = _frames(cfg)
    test = d_full.loc[pd.DatetimeIndex(d_full["performance_date"])
                      >= pd.Timestamp(cfg.oot_from)]
    if not cfg.mev_terms:
        raise ValueError(
            "No macro terms are shortlisted for LGD on the Macro surface. "
            "Every emitted severity model must carry a macro term, so there "
            "is nothing to enumerate. Shortlist terms against the LGD target "
            "on the Macro surface first.")
    cores = build_cores(cfg, train, progress=stage(1), cancel=cancel)
    if not cores:
        raise ValueError(
            "No severity core survived construction: no candidate driver "
            f"showed a significant severity coefficient (robust p under "
            f"{cfg.rules.entry_threshold}) on the resolved defaults. Pick "
            "candidates that rank on the severity screen — spread and "
            "Spearman against realised severity — rather than tape columns "
            "with no loss signal.")
    survivors, screened_out = screen_terms(cfg, cores, train,
                                           progress=stage(2), cancel=cancel)
    combos = _combos(cfg, survivors, train)
    n_combos = sum(len(v) for v in combos.values())
    if n_combos == 0:
        raise ValueError(
            "Every shortlisted term was screened out beside every core. "
            "Loosen the screen p-value or revisit the LGD shortlist.")
    rows = joint_rows(cfg, cores, combos, train, test,
                      progress=stage(3), cancel=cancel)
    stress_check(cfg, rows, d_full, progress=stage(3), cancel=cancel)
    composite_rank(rows, max_vif=cfg.rules.max_vif)

    payload = {
        "target": "lgd",
        "config": cfg.to_dict(),
        "config_hash": cfg.hash(),
        "portfolio": cfg.portfolio,
        "generated_at": pd.Timestamp.utcnow().isoformat(timespec="seconds"),
        "scenarios": available_scenarios(),
        "cores": [{"name": c.name, "columns": c.drivers,
                   "warnings": [], "steps": c.steps} for c in cores],
        "survivors": survivors,
        "screened_out": screened_out,
        "n_combos": n_combos,
        "n_rows": len(rows),
        "n_filtered": sum(1 for r in rows if r["filtered"]),
        "n_train": int(len(train)), "n_test": int(len(test)),
        "rows": rows,
    }
    if checkpoint:
        checkpoint(payload)
    run_finalists(cfg, rows, train, d_full, progress=stage(4), cancel=cancel)
    return payload
