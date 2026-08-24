"""Lifetime expected credit loss, projected under a scenario.

The formula, and every part of it stated:

    ECL_i = SUM over t of   MPD_i(t) x LGD_i(t) x EAD_i(t) x DF(t)

    MPD_i(t) = PD_i(t) x PRODUCT over s < t of ( 1 - PD_i(s) )

The survival adjustment is the part that gets skipped. `PD_i(t)` from a
discrete-time hazard is a CONDITIONAL probability — the chance of defaulting in
month t GIVEN the account is still alive at t. Summing conditional probabilities
across a lifetime double-counts: an account cannot default in month 30 if it
already defaulted in month 12. The running survival product is what converts the
conditional hazard into a marginal probability, and without it a lifetime ECL on
a long-dated book is materially overstated.

`PD_i(t)` and `LGD_i(t)` are both scenario-conditioned. Discounting is at the
account's effective interest rate.

CECL lifetime is the primary frame. IFRS 9 staging is available as a secondary
view: twelve-month ECL for stage 1, lifetime for stages 2 and 3, with a
significant-increase-in-credit-risk trigger.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..analysis.mev_search import Candidate as MevCandidate
from . import design as D
from .design import apply_mev_transform
from . import ead as EAD
from . import lgd as LGD
from .fit import predict
from .spec import ModelSpec

SICR_MULTIPLE = 2.0        # PD at least doubling since origination triggers stage 2
SICR_ABSOLUTE = 0.005      # ...or an absolute 12-month PD above 50bp


@dataclass
class EclResult:
    scenario: str
    portfolio: str
    horizon_months: int
    n_accounts: int
    total_exposure: float
    ecl: float
    ecl_bps: float
    weighted_pd_12m: float
    weighted_lgd: float
    monthly: list[dict] = field(default_factory=list)
    by_segment: list[dict] = field(default_factory=list)
    ifrs9: dict = field(default_factory=dict)
    components: dict = field(default_factory=dict)


def _as_of_frame(df: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """The book as it stands at the projection date: the last observation of every
    account that is still open."""
    d = df.loc[df["performance_date"] == as_of]
    if d.empty:
        last = df["performance_date"].max()
        d = df.loc[df["performance_date"] == last]
    return d.loc[d["terminal_event"].isin(["none", "censored"])].copy()


def project(spec: ModelSpec, fit_result, df: pd.DataFrame, mev_path: pd.DataFrame,
            lgd_model: LGD.LgdModel, ead_assumption: EAD.EadAssumption,
            scenario: str, horizon_months: int,
            as_of: pd.Timestamp | None = None,
            segment_column: str | None = None) -> EclResult:
    """Project every open account forward over the scenario horizon."""
    as_of = as_of or df["performance_date"].max()
    book = _as_of_frame(df, as_of)
    n = len(book)
    if n == 0:
        raise ValueError("no open accounts at the projection date")

    future = pd.date_range(as_of + pd.DateOffset(months=1), periods=horizon_months,
                           freq="MS")

    # exposure path, from the portfolio's own EAD method
    ead_path = EAD.project(book, ead_assumption, horizon_months)

    # one long frame: account x projected month, so the design is built once
    rep = np.repeat(np.arange(n), horizon_months)
    proj = book.iloc[rep].reset_index(drop=True)
    tgrid = np.tile(np.arange(1, horizon_months + 1), n)
    proj["performance_date"] = np.tile(future.to_numpy(), n)
    proj["months_on_book"] = book["months_on_book"].to_numpy()[rep] + tgrid
    proj["remaining_term"] = np.maximum(
        book["remaining_term"].to_numpy()[rep] - tgrid, 0)
    proj["current_balance"] = ead_path.reshape(-1)

    # dynamic drivers follow the scenario's own macro path
    idx = pd.DatetimeIndex(proj["performance_date"])
    if "current_ltv" in proj.columns and "hpi" in mev_path.columns:
        hpi_now = mev_path["hpi"].reindex(idx).to_numpy(float)
        hpi_ref = float(mev_path["hpi"].reindex([as_of]).iloc[0])
        # value moves with the scenario HPI; balance moves on the amortization path
        val = (book["current_balance"].to_numpy()[rep]
               / np.maximum(book["current_ltv"].to_numpy()[rep], 1e-6) * 100.0)
        proj["current_ltv"] = np.clip(
            100.0 * proj["current_balance"].to_numpy()
            / np.maximum(val * (hpi_now / hpi_ref), 1.0), 1.0, 300.0)
        if "cltv" in proj.columns:
            proj["cltv"] = proj["current_ltv"] + (
                book["cltv"].to_numpy()[rep] - book["current_ltv"].to_numpy()[rep])
    if "dscr_reported" in proj.columns and "cre_price_index" in mev_path.columns:
        ix = mev_path["cre_price_index"].reindex(idx).to_numpy(float)
        ref = float(mev_path["cre_price_index"].reindex([as_of]).iloc[0])
        proj["dscr_reported"] = np.clip(
            book["dscr_reported"].to_numpy()[rep] * (ix / ref) ** 0.8, 0.05, 6.0)
        if "current_ltv" in proj.columns:
            proj["current_ltv"] = np.clip(
                book["current_ltv"].to_numpy()[rep] * (ref / np.maximum(ix, 1e-6)),
                1.0, 300.0)

    # conditional PD from the fitted hazard, on the SCENARIO macro path
    des = D.build(proj, spec, woe_maps=fit_result.woe_maps, means=fit_result.means,
                  stds=fit_result.stds, mev_override=mev_path,
                  basis_maps=fit_result.basis_maps)
    pd_t = predict(des.X, fit_result.beta).reshape(n, horizon_months)

    # LGD, also scenario-conditioned. Every macro column the severity model is
    # ALLOWED to be fitted on, not a hardcoded subset of them: the fit attaches
    # all of LGD_MACRO and this attached three, so a model carrying real GDP
    # growth or a BBB yield reached scoring with that column missing.
    for c in LGD.LGD_MACRO:
        if c in mev_path.columns:
            proj[c] = mev_path[c].reindex(idx).to_numpy(float)
    # Transformed macro terms promoted from the macro search. Built from the
    # SCENARIO path, through the same function the fit used — otherwise a model
    # whose severity depends on a lagged growth rate would be projected on
    # whatever the fixed block above happened to contain, or on nothing at all.
    for col in lgd_model.spec.drivers:
        if "@" not in col:
            continue
        cand = MevCandidate.parse(col)
        if cand is None or cand.key not in mev_path.columns:
            raise ValueError(
                f"LGD was fitted on {col!r}, which this scenario path cannot "
                f"produce: {cand.key if cand else col!r} is not projected.")
        srs = apply_mev_transform(mev_path[cand.key], cand.transform)
        if cand.lag_months:
            srs = srs.shift(cand.lag_months)
        proj[col] = srs.reindex(idx).to_numpy(float)
    if "workout_months" in proj.columns:
        # An account that has not defaulted has no workout duration — the column
        # is zero for every open account, so imputing the median would impute
        # zero (and taking the median of an all-NaN column gives NaN, which is
        # what the first draft did: every projected LGD came back NaN).
        # A PROJECTED default gets the book's realised mean workout duration.
        proj["workout_months"] = float(lgd_model.mean_workout_months)
    lgd_t = lgd_model.predict(LGD.design_for(proj, lgd_model)).reshape(n, horizon_months)

    # survival adjustment — the step that is usually skipped
    surv = np.cumprod(np.concatenate([np.ones((n, 1)), 1.0 - pd_t[:, :-1]], axis=1),
                      axis=1)
    mpd = pd_t * surv

    eir = np.maximum(book["interest_rate"].to_numpy(float), 0.0) / 12.0
    df_t = 1.0 / np.power(1.0 + eir[:, None], np.arange(1, horizon_months + 1)[None, :])

    loss = mpd * lgd_t * ead_path * df_t
    ecl_i = loss.sum(axis=1)

    exposure = float(book["current_balance"].sum())
    ecl = float(ecl_i.sum())
    pd12 = float(np.average(1.0 - np.prod(1.0 - pd_t[:, :12], axis=1),
                            weights=np.maximum(book["current_balance"], 1.0)))
    wl = float(np.average(lgd_t[:, :12].mean(axis=1),
                          weights=np.maximum(book["current_balance"], 1.0)))

    monthly = [{
        "month": future[t].strftime("%Y-%m-%d"),
        "marginal_pd": float(mpd[:, t].mean()),
        "survival": float(surv[:, t].mean()),
        "lgd": float(lgd_t[:, t].mean()),
        "exposure": float(ead_path[:, t].sum()),
        "loss": float(loss[:, t].sum()),
        "cumulative_loss": float(loss[:, : t + 1].sum()),
    } for t in range(horizon_months)]

    by_segment: list[dict] = []
    if segment_column and segment_column in book.columns:
        g = pd.DataFrame({"seg": book[segment_column].astype(str).to_numpy(),
                          "ecl": ecl_i,
                          "exp": book["current_balance"].to_numpy(float)})
        for seg, sub in g.groupby("seg"):
            by_segment.append({
                "segment": seg, "n": int(len(sub)),
                "exposure": float(sub["exp"].sum()), "ecl": float(sub["ecl"].sum()),
                "ecl_bps": float(sub["ecl"].sum() / max(sub["exp"].sum(), 1) * 10_000),
            })
        by_segment.sort(key=lambda r: -r["ecl"])

    return EclResult(
        scenario=scenario, portfolio=spec.portfolio, horizon_months=horizon_months,
        n_accounts=n, total_exposure=exposure, ecl=ecl,
        ecl_bps=ecl / max(exposure, 1.0) * 10_000,
        weighted_pd_12m=pd12, weighted_lgd=wl, monthly=monthly, by_segment=by_segment,
        ifrs9=_ifrs9(pd_t, lgd_t, ead_path, df_t, surv, book),
        components={"pd": pd_t, "lgd": lgd_t, "ead": ead_path, "df": df_t,
                    "survival": surv, "ecl_i": ecl_i,
                    "exposure_i": book["current_balance"].to_numpy(float)},
    )


def _ifrs9(pd_t, lgd_t, ead, df_t, surv, book) -> dict:
    """IFRS 9 staging as a secondary view.

    Stage 1 carries a TWELVE-MONTH expected loss; stages 2 and 3 carry a lifetime
    one. The staging trigger is a significant increase in credit risk since
    origination — here, the 12-month PD at least doubling, or exceeding 50 basis
    points outright. Accounts already in default sit in stage 3.
    """
    n, h = pd_t.shape
    mpd = pd_t * surv
    loss_full = (mpd * lgd_t * ead * df_t).sum(axis=1)
    k = min(12, h)
    loss_12 = (mpd[:, :k] * lgd_t[:, :k] * ead[:, :k] * df_t[:, :k]).sum(axis=1)

    pd12 = 1.0 - np.prod(1.0 - pd_t[:, :k], axis=1)
    origination_pd = np.maximum(np.median(pd12), 1e-9)
    stage = np.where(book["delinquency_bucket"].astype(str).to_numpy() != "Current", 3,
                     np.where((pd12 > SICR_MULTIPLE * origination_pd)
                              | (pd12 > SICR_ABSOLUTE), 2, 1))
    ecl_staged = np.where(stage == 1, loss_12, loss_full)
    exp = book["current_balance"].to_numpy(float)
    return {
        "trigger": (f"Stage 2 when the 12-month PD exceeds {SICR_MULTIPLE:.0f}x the "
                    f"portfolio median at origination or {SICR_ABSOLUTE:.2%} outright; "
                    f"stage 3 when the account is already delinquent."),
        "total_ecl": float(ecl_staged.sum()),
        "stages": [{
            "stage": int(s), "n": int((stage == s).sum()),
            "exposure": float(exp[stage == s].sum()),
            "ecl": float(ecl_staged[stage == s].sum()),
            "basis": "12-month" if s == 1 else "lifetime",
        } for s in (1, 2, 3) if (stage == s).any()],
    }
