"""In-process data store.

The panels are large (1.7M rows for mortgage) and the refit budget is about two
seconds, so nothing is read from disk twice. Everything here is cached for the
life of the process and keyed by portfolio.

`load_panel` also carries the DEMO SAFETY property: it never returns a column
whose name starts with `_truth`. Those are stripped at generation time already;
the guard here is belt and braces, because a generative-truth column reaching the
model surface would silently produce a perfect model in front of a client.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import pandas as pd

from .data.portfolios import PORTFOLIOS
from .data.spec import PortfolioSpec

DATA = Path(__file__).resolve().parents[2] / "data" / "synthetic"


@dataclass(frozen=True)
class Portfolio:
    spec: PortfolioSpec
    panel: pd.DataFrame
    accounts: pd.DataFrame

    @property
    def key(self) -> str:
        return self.spec.key


def available() -> list[str]:
    return [k for k in PORTFOLIOS if (DATA / f"{k}_panel.parquet").exists()]


@lru_cache(maxsize=8)
def load(key: str) -> Portfolio:
    if key not in PORTFOLIOS:
        raise KeyError(f"unknown portfolio {key!r}")
    p = pd.read_parquet(DATA / f"{key}_panel.parquet")
    a = pd.read_parquet(DATA / f"{key}_accounts.parquet")
    for df in (p, a):
        drop = [c for c in df.columns if c.startswith("_truth")]
        if drop:
            df.drop(columns=drop, inplace=True)
    p["performance_date"] = pd.to_datetime(p["performance_date"])
    a["origination_date"] = pd.to_datetime(a["origination_date"])
    return Portfolio(PORTFOLIOS[key], p, a)


@lru_cache(maxsize=8)
def analysis_frame(key: str) -> pd.DataFrame:
    """Panel joined to account attributes — the frame every surface analyses.

    Built once per portfolio. This is the single largest object in the process and
    the reason the API holds state rather than recomputing per request.
    """
    pf = load(key)
    acc_cols = [c for c in pf.accounts.columns if c not in pf.panel.columns
                or c == "account_id"]
    return pf.panel.merge(pf.accounts[acc_cols], on="account_id", how="left")


def clear() -> None:
    load.cache_clear()
    analysis_frame.cache_clear()
