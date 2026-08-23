"""MEV catalog — the Fed supervisory (CCAR) variables and their metadata contract.

Why this catalog is restricted to the CCAR variables: they are the only macro
variables with *publicly published forward paths*. A macro variable without a
forward path cannot condition a scenario projection, however predictive it is in
sample. That sentence belongs in the UI next to the variable picker.

Every variable carries the four metadata fields that drive frequency conversion.
Conversion NEVER reads a global rule — it reads this table:

  native      the frequency FRED publishes  (D / W / M / Q)
  kind        stock (a level at a point in time) | flow (accumulated over a period)
  measure     level | rate | index | growth
  agg         how to collapse a higher frequency to monthly:
              avg  period-average   (rates, indices measured continuously)
              eop  end-of-period    (where the CCAR definition is end-of-period)
              sum  accumulate       (flows)
              max  period-maximum  (the Fed defines the VIX path this way)

`growth` variables get special handling: a growth rate is NEVER interpolated
directly. It is converted to a level index, the LEVEL is benchmarked, then the
result is re-differenced. See creditiq.mev.reconcile.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Literal

Freq = Literal["D", "W", "M", "Q"]
Kind = Literal["stock", "flow"]
Measure = Literal["level", "rate", "index", "growth"]
Agg = Literal["avg", "eop", "sum", "max"]


@dataclass(frozen=True)
class Mev:
    key: str            # stable internal id, used in model configs
    label: str          # what the UI shows
    series_id: str      # FRED series id
    native: Freq
    kind: Kind
    measure: Measure
    agg: Agg
    unit: str
    group: Literal["domestic", "international"]
    # CCAR publishes some variables as growth rates of a level FRED reports as a
    # level. `derive` names that transform so the app can reconcile the two.
    derive: str | None = None
    note: str | None = None
    # Ordered fallback FRED ids, tried when `series_id` 404s or fails the
    # coverage requirement. Some FRED series are retired (Wilshire) and some are
    # licence-truncated to a short window (ICE BofA), so a single id is fragile.
    alternates: tuple[str, ...] = ()
    # True when our historical series is a DIFFERENT INDEX from the Fed's
    # variable, so the two sit on different arbitrary bases and the scenario path
    # must be rebased onto our history before it can be plotted or used. False
    # for anything measured on an absolute scale — a rate, a yield, a growth
    # rate, or the VIX — where the Fed's number means the same thing ours does
    # and rebasing would destroy the shock.
    rebase: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


# ── the 16 domestic supervisory variables ────────────────────────────────────
DOMESTIC: list[Mev] = [
    Mev("real_gdp_growth", "Real GDP growth", "GDPC1", "Q", "flow", "growth", "avg",
        "% annualized", "domestic", derive="qoq_annualized_from_level",
        note="FRED publishes the level (chained 2017$). CCAR publishes annualized growth."),
    Mev("nominal_gdp_growth", "Nominal GDP growth", "GDP", "Q", "flow", "growth", "avg",
        "% annualized", "domestic", derive="qoq_annualized_from_level"),
    Mev("real_disp_income_growth", "Real disposable income growth", "DSPIC96", "M", "flow",
        "growth", "avg", "% annualized", "domestic", derive="qoq_annualized_from_level"),
    Mev("nominal_disp_income_growth", "Nominal disposable income growth", "DSPI", "M", "flow",
        "growth", "avg", "% annualized", "domestic", derive="qoq_annualized_from_level"),
    Mev("unemployment_rate", "Unemployment rate", "UNRATE", "M", "stock", "rate", "avg",
        "%", "domestic"),
    Mev("cpi_inflation", "CPI inflation", "CPIAUCSL", "M", "flow", "growth", "avg",
        "% annualized", "domestic", derive="qoq_annualized_from_level",
        note="FRED publishes the index. CCAR publishes annualized inflation."),
    Mev("treasury_3m", "3-month Treasury rate", "TB3MS", "M", "stock", "rate", "avg",
        "%", "domestic"),
    Mev("treasury_5y", "5-year Treasury yield", "GS5", "M", "stock", "rate", "avg",
        "%", "domestic"),
    Mev("treasury_10y", "10-year Treasury yield", "GS10", "M", "stock", "rate", "avg",
        "%", "domestic"),
    Mev("bbb_yield", "BBB corporate yield", "DBAA", "D", "stock", "rate", "avg",
        "%", "domestic", alternates=("BAMLC0A4CBBBEY", "BAA"),
        note="Moody's Seasoned Baa corporate bond yield. Baa is the Moody's "
             "equivalent of S&P/Fitch BBB. FRED serves the ICE BofA BBB effective "
             "yield (BAMLC0A4CBBBEY) under a licence that truncates it to roughly "
             "the last three years, which is too short to fit a panel that starts "
             "in 2015. Baa carries full history from 1919."),
    Mev("mortgage_rate", "Mortgage rate", "MORTGAGE30US", "W", "stock", "rate", "avg",
        "%", "domestic"),
    Mev("prime_rate", "Prime rate", "MPRIME", "M", "stock", "rate", "avg", "%", "domestic"),
    Mev("equity_index", "Broad equity index", "NASDAQCOM", "D", "stock",
        "index", "eop", "index", "domestic",
        alternates=("WILL5000IND", "SP500", "DJIA"), rebase=True,
        note="Stands in for the Fed's Dow Jones Total Stock Market path. The "
             "Wilshire 5000 series (WILL5000IND) was retired from FRED and now "
             "404s; SP500 and DJIA are licence-truncated to the last ten years, "
             "which does not cover a panel starting in 2015. NASDAQCOM is the "
             "only broad US equity index on FRED with full daily history. It is "
             "tech-weighted, so it is a WEAKER proxy than the Fed path — labelled "
             "as such in the UI. Aggregates end-of-period, matching the Fed's "
             "end-of-quarter definition."),
    Mev("hpi", "House Price Index", "CSUSHPINSA", "M", "stock", "index", "eop",
        "index", "domestic", rebase=True, note="S&P CoreLogic Case-Shiller US National, NSA."),
    Mev("hpi_fhfa", "House Price Index (FHFA, purchase-only)", "USSTHPI", "Q", "stock",
        "index", "eop", "index", "domestic",
        rebase=True, note="Secondary HPI. The Fed's supervisory HPI is closest to this series."),
    Mev("vix", "Market Volatility Index (VIX)", "VIXCLS", "D", "stock", "level", "max",
        "index", "domestic",
        note="The Fed path is the quarterly MAXIMUM of daily close, not the average. "
             "Handled as a special case in reconcile.py."),
]

# CRE price index — there is NO clean FRED equivalent of the Fed's supervisory
# Commercial Real Estate Price Index. Candidates are tried in order and the first
# that resolves is used. The choice is surfaced in the UI and recorded in
# docs/DECISIONS.md, per the brief.
CRE_CANDIDATES: list[Mev] = [
    Mev("cre_price_index", "Commercial Real Estate Price Index", "COMREPUSQ159N", "Q",
        "stock", "index", "eop", "index", "domestic",
        derive="level_from_yoy_growth", rebase=True,
        note="BIS commercial property prices, United States. FRED carries NO "
             "level index for US commercial property. The BIS series is published "
             "as a year-over-year GROWTH RATE (the '159' suffix in the BIS naming "
             "convention), so the index level is RECONSTRUCTED by cumulating that "
             "growth from a base of 100 over the first four quarters (2005). The "
             "base is arbitrary; only the shape and the growth carry meaning. "
             "This is the weakest link in the MEV catalog and the UI labels it."),
    Mev("cre_price_index", "Commercial Real Estate Price Index", "BOGZ1FL075035503Q", "Q",
        "stock", "index", "eop", "index", "domestic",
        note="Fallback: Financial Accounts commercial real estate value."),
]

# Indicator-only series. These are NOT supervisory variables and are never
# offered in the variable picker. They exist to anchor the within-quarter shape of
# a quarterly series during Denton-Cholette benchmarking (the Chow-Lin idea:
# borrow the monthly movement of a genuinely related series). Industrial
# production is the standard monthly indicator for GDP.
INDICATOR_ONLY: list[Mev] = [
    Mev("industrial_production", "Industrial Production Index", "INDPRO", "M", "stock",
        "index", "avg", "index", "domestic",
        note="Indicator series for GDP benchmarking. Not a supervisory variable."),
]

INTERNATIONAL: list[Mev] = [
    Mev("euro_real_gdp_growth", "Euro area real GDP growth", "CLVMNACSCAB1GQEA19", "Q",
        "flow", "growth", "avg", "% annualized", "international",
        derive="qoq_annualized_from_level"),
    Mev("uk_real_gdp_growth", "UK real GDP growth", "NGDPRSAXDCGBQ", "Q", "flow", "growth",
        "avg", "% annualized", "international", derive="qoq_annualized_from_level"),
    Mev("japan_real_gdp_growth", "Japan real GDP growth", "JPNRGDPEXP", "Q", "flow",
        "growth", "avg", "% annualized", "international",
        derive="qoq_annualized_from_level"),
    Mev("euro_inflation", "Euro area inflation", "CP0000EZ19M086NEST", "M", "flow",
        "growth", "avg", "% annualized", "international",
        derive="qoq_annualized_from_level"),
    Mev("japan_inflation", "Japan inflation", "JPNCPIALLMINMEI", "M", "flow", "growth",
        "avg", "% annualized", "international", derive="qoq_annualized_from_level"),
    Mev("usd_eur", "US$/Euro exchange rate", "DEXUSEU", "D", "stock", "level", "eop",
        "USD per EUR", "international"),
    Mev("usd_gbp", "US$/Pound exchange rate", "DEXUSUK", "D", "stock", "level", "eop",
        "USD per GBP", "international"),
    Mev("jpy_usd", "Yen/US$ exchange rate", "DEXJPUS", "D", "stock", "level", "eop",
        "JPY per USD", "international"),
]

ALL_CANDIDATES: list[Mev] = DOMESTIC + CRE_CANDIDATES + INTERNATIONAL + INDICATOR_ONLY

# MEVs each portfolio is allowed to use. This is the declarative registry the
# brief asks for: a fourth portfolio is a config entry, not a code path.
PORTFOLIO_MEVS: dict[str, list[str]] = {
    "consumer": ["unemployment_rate", "real_disp_income_growth", "real_gdp_growth",
                 "cpi_inflation", "prime_rate", "equity_index", "vix"],
    "mortgage": ["hpi", "unemployment_rate", "mortgage_rate", "real_gdp_growth",
                 "treasury_10y", "hpi_fhfa"],
    "cre": ["cre_price_index", "bbb_yield", "real_gdp_growth", "unemployment_rate",
            "treasury_10y", "vix", "nominal_gdp_growth"],
}


def by_key(keys: list[str] | None = None) -> dict[str, Mev]:
    out: dict[str, Mev] = {}
    for m in ALL_CANDIDATES:
        out.setdefault(m.key, m)          # first candidate wins for CRE
    return {k: v for k, v in out.items() if keys is None or k in keys}
