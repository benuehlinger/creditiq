"""CCAR supervisory scenarios: load, splice onto history, convert to monthly.

Provenance, stated plainly because it is the first thing a validator asks:

  * The BASELINE and SEVERELY ADVERSE paths are the Federal Reserve's published
    2026 supervisory scenarios, downloaded from federalreserve.gov and committed
    verbatim to `data/scenarios`. Nothing about them is modelled.

  * The Fed publishes NO ADVERSE scenario. It has not since the 2022 cycle — the
    URL 404s for 2023, 2024, 2025 and 2026. CreditIQ therefore SHIPS NO ADVERSE
    SCENARIO. An earlier version interpolated one at 50% severity between the two
    published paths and labelled it "derived"; that has been removed. A middle
    path invented by the platform looks exactly like a supervisory path on a
    chart, and the label carries the whole burden of the distinction. Two real
    scenarios beat three where one is ours.

    A user who needs a middle path builds it in the scenario editor, where it is
    their assumption and is marked as a custom path throughout.

The horizon is read from the file, never hardcoded. The 2026 cycle runs 13
quarters; an earlier or later cycle will run a different length and the app
follows whatever the file says.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from . import reconcile
from .registry import by_key

SCENARIO_DIR = Path(__file__).resolve().parents[3] / "data" / "scenarios"

# Fed column heading -> our registry key. Any heading absent from this map is
# reported rather than silently ignored.
FED_COLUMNS: dict[str, str] = {
    "Real GDP growth": "real_gdp_growth",
    "Nominal GDP growth": "nominal_gdp_growth",
    "Real disposable income growth": "real_disp_income_growth",
    "Nominal disposable income growth": "nominal_disp_income_growth",
    "Unemployment rate": "unemployment_rate",
    "CPI inflation rate": "cpi_inflation",
    "3-month Treasury rate": "treasury_3m",
    "5-year Treasury yield": "treasury_5y",
    "10-year Treasury yield": "treasury_10y",
    "BBB corporate yield": "bbb_yield",
    "Mortgage rate": "mortgage_rate",
    "Prime rate": "prime_rate",
    "Dow Jones Total Stock Market Index (Level)": "equity_index",
    "House Price Index (Level)": "hpi",
    "Commercial Real Estate Price Index (Level)": "cre_price_index",
    "Market Volatility Index (Level)": "vix",
    # international block
    "Euro area real GDP growth": "euro_real_gdp_growth",
    "Euro area inflation": "euro_inflation",
    "Euro area bilateral dollar exchange rate (USD/euro)": "usd_eur",
    "Developing Asia real GDP growth": "developing_asia_real_gdp_growth",
    "Developing Asia inflation": "developing_asia_inflation",
    "Developing Asia bilateral dollar exchange rate (F/USD, index)":
        "developing_asia_fx",
    "Japan real GDP growth": "japan_real_gdp_growth",
    "Japan inflation": "japan_inflation",
    "Japan bilateral dollar exchange rate (yen/USD)": "jpy_usd",
    "U.K. real GDP growth": "uk_real_gdp_growth",
    "U.K. inflation": "uk_inflation",
    "U.K. bilateral dollar exchange rate (USD/pound)": "usd_gbp",
}

SEVERITIES = {"baseline": 0.0, "severely_adverse": 1.0}


@dataclass
class Scenario:
    key: str
    label: str
    published: bool
    quarterly: pd.DataFrame          # index = quarter start, columns = registry keys
    source: str
    note: str = ""

    @property
    def horizon_quarters(self) -> int:
        return len(self.quarterly)


def _parse_quarter(s: str) -> pd.Timestamp:
    year, q = s.strip().split()
    return pd.Timestamp(year=int(year), month=(int(q[1]) - 1) * 3 + 1, day=1)


def _read(path: Path) -> tuple[pd.DataFrame, list[str]]:
    raw = pd.read_csv(path)
    dates = raw["Date"].map(_parse_quarter)
    keep, unmapped = {}, []
    for col in raw.columns:
        if col in ("Scenario Name", "Date"):
            continue
        key = FED_COLUMNS.get(col.strip())
        if key is None:
            unmapped.append(col)
            continue
        keep[key] = pd.to_numeric(raw[col], errors="coerce")
    df = pd.DataFrame(keep)
    df.index = pd.DatetimeIndex(dates, name="quarter")
    return df, unmapped


def load_published() -> tuple[dict[str, Scenario], list[str]]:
    """Baseline and severely adverse, straight from the committed Fed files."""
    out: dict[str, Scenario] = {}
    warnings: list[str] = []
    files = {
        "baseline": ("Baseline", "Supervisory Baseline"),
        "severely_adverse": ("Severely_Adverse", "Supervisory Severely Adverse"),
    }
    for key, (stem, label) in files.items():
        dom = SCENARIO_DIR / f"2026_Final_Supervisory_{stem}_Domestic.csv"
        intl = SCENARIO_DIR / f"2026_Final_Supervisory_{stem}_International.csv"
        if not dom.exists():
            warnings.append(f"missing {dom.name}")
            continue
        df, unmapped = _read(dom)
        warnings += [f"{dom.name}: unmapped column {c!r}" for c in unmapped]
        if intl.exists():
            idf, iun = _read(intl)
            warnings += [f"{intl.name}: unmapped column {c!r}" for c in iun]
            df = df.join(idf, how="outer")
        out[key] = Scenario(key, label, True, df.sort_index(),
                            source="Federal Reserve 2026 supervisory scenarios "
                                   "(federalreserve.gov), committed verbatim")
    return out, warnings


def load_all() -> tuple[dict[str, Scenario], list[str]]:
    """Every scenario the platform offers — all of them published by the Fed.

    There is deliberately no synthesised middle path here. See the module note.
    """
    return load_published()


# ── splicing history to the forward path ─────────────────────────────────────
@dataclass
class Splice:
    monthly: pd.Series
    splice_date: pd.Timestamp
    shift: float
    shift_kind: str          # "ratio" | "additive" | "none"
    last_actual: float
    first_scenario_raw: float


def splice_variable(history: pd.Series, scenario_q: pd.Series, key: str) -> Splice:
    """Join real history to a scenario path with no visible discontinuity.

    Two different things meet at the seam, and only one of them is a problem.

    THE PROBLEM: our historical proxy may be a different index from the Fed's
    variable, on a different arbitrary base. The Fed's CRE index reads 309.5
    where our reconstructed BIS index reads about 151. Concatenating those is
    meaningless. Such a variable is rebased multiplicatively, which preserves the
    scenario's percentage path exactly and lands it on our history's scale.

    NOT THE PROBLEM: a genuine jump in a rate at the first projected quarter.
    Unemployment going from an actual 4.1% to 5.9% is the shock arriving. It must
    survive. Rates, yields, growth rates and the VIX are on absolute scales and
    are never shifted.

    The seam is returned, not hidden. Every MEV chart draws it as a vertical rule
    with the projected side in a distinct line style.
    """
    mev = by_key().get(key)
    hist = history.dropna()
    last_actual = float(hist.iloc[-1])
    first_raw = float(scenario_q.iloc[0])

    # Rebase ONLY where our historical proxy is a different index from the Fed's
    # variable, so the two carry different arbitrary bases (our reconstructed BIS
    # CRE index reads ~151 where the Fed's reads 309.5; NASDAQCOM is not the Dow
    # Jones Total Stock Market). Everything else is on an absolute scale and must
    # be left alone.
    #
    # This is easy to get wrong in the expensive direction. Shifting a rate to
    # "remove the discontinuity" at the seam removes the SHOCK: unemployment
    # jumping from an actual 4.1% to 5.9% in the first projected quarter is the
    # scenario doing its job, not an artefact to smooth away. An earlier version
    # of this function shifted every variable and quietly capped severely adverse
    # unemployment at 8.2% instead of 10.0%.
    if mev is not None and mev.rebase:
        shift = last_actual / first_raw if first_raw else 1.0
        kind, path = "ratio", scenario_q.astype(float) * shift
    else:
        shift, kind, path = 0.0, "none", scenario_q.astype(float)

    # quarterly -> monthly on the variable's own aggregation rule
    agg = mev.agg if mev else "avg"
    if agg == "max":
        agg = "eop"                                   # max has no linear form
    months = pd.date_range(path.index.min(),
                           path.index.max() + pd.offsets.QuarterEnd(0), freq="MS")
    vals = reconcile.denton_cholette(path.to_numpy(float), len(months), agg)
    reconcile.assert_aggregates_back(vals, path.to_numpy(float), agg)
    fwd = pd.Series(vals, index=months, name=key)

    joined = pd.concat([hist[hist.index < months[0]], fwd])
    return Splice(joined, months[0], shift, kind, last_actual, first_raw)
