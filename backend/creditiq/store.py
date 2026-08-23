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

import numpy as np
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


SCREEN_ROWS = 300_000


@lru_cache(maxsize=8)
def screening_frame(key: str, n: int = SCREEN_ROWS) -> tuple[pd.DataFrame, bool]:
    """A deterministic subsample used for VARIABLE SCREENING only.

    Information value, correlation and stability are population statistics that
    are stable well below a million rows, and optimal binning on 1.7M rows takes
    seconds per variable — which would make the screen feel broken. Final model
    fits always use the full panel.

    The sample is EVENT-PRESERVING: every default is kept and only non-events are
    thinned, so a rare target is not made rarer. The returned flag says whether
    any thinning happened, and the UI states it — an approximation the user
    cannot see is not an approximation, it is a lie.
    """
    df = analysis_frame(key)
    if len(df) <= n:
        return df, False
    tgt = PORTFOLIOS[key].target.column
    ev = df.index[df[tgt] == 1]
    rest = df.index[df[tgt] == 0]
    rng = np.random.default_rng(20260819)
    take = rng.choice(rest, size=max(n - len(ev), 1000), replace=False)
    out = df.loc[np.concatenate([ev.to_numpy(), take])].sort_index()
    return out, True


def clear() -> None:
    load.cache_clear()
    analysis_frame.cache_clear()
    screening_frame.cache_clear()
