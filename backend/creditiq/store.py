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
_BUILD_REPORT = DATA / "build_report.json"

# The mtime of the build report the caches were filled against. The panels can
# be rebuilt UNDER a running server — `make data` in another terminal, or the
# in-app generate button — and every cache in the process is then a cache of a
# dataset that no longer exists. Nothing used to notice: a fitted LGD would
# keep answering from the old panel until the server was restarted by hand,
# which read as "sometimes an old fit appears at random". Every public read
# below stats this one file first (microseconds) and, on a change, drops the
# store's own caches AND every registered dependent in one move.
_data_stamp: float | None = None


def _check_current() -> None:
    global _data_stamp
    try:
        stamp = _BUILD_REPORT.stat().st_mtime
    except OSError:
        stamp = -1.0
    if _data_stamp is None:
        _data_stamp = stamp
        return
    if stamp != _data_stamp:
        _data_stamp = stamp
        clear()


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


def load(key: str) -> Portfolio:
    _check_current()
    return _load(key)


@lru_cache(maxsize=8)
def _load(key: str) -> Portfolio:
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
    return Portfolio(PORTFOLIOS[key], _compact(p), _compact(a))


# A low-cardinality string column costs about 55 bytes per row as Python
# objects and about 1 as a categorical code. On the mortgage panel nine such
# columns — none with more than 144 distinct values, several with two — held
# 1,036 MB of a 1,445 MB frame. Storing them as categories is what makes room
# for panels large enough to fill a month with workouts.
#
# The threshold is deliberately generous: a column with thousands of distinct
# values still saves, and one with a distinct value per row is left alone
# because a category of that shape costs more than it saves.
_CATEGORY_MAX_RATIO = 0.5


def _compact(df: pd.DataFrame) -> pd.DataFrame:
    """Narrow the dtypes without changing a single value.

    Categoricals compare and group exactly as the strings did. Floats are left
    at double precision — these are model inputs, and narrowing them would move
    coefficients rather than only the memory."""
    for c in df.columns:
        if df[c].dtype != object:
            continue
        # An identifier column is excluded: it is a key, not a level.
        if c.endswith("_id") or c == "account_id":
            continue
        if df[c].nunique(dropna=False) <= max(2, int(len(df) * _CATEGORY_MAX_RATIO)):
            df[c] = df[c].astype("category")
    return df


def analysis_frame(key: str) -> pd.DataFrame:
    _check_current()
    return _analysis_frame(key)


@lru_cache(maxsize=8)
def _analysis_frame(key: str) -> pd.DataFrame:
    """Panel joined to account attributes — the frame every surface analyses.

    Built once per portfolio. This is the single largest object in the process and
    the reason the API holds state rather than recomputing per request.
    """
    pf = load(key)
    acc_cols = [c for c in pf.accounts.columns if c not in pf.panel.columns
                or c == "account_id"]
    return pf.panel.merge(pf.accounts[acc_cols], on="account_id", how="left")


SCREEN_ROWS = 300_000


def screening_frame(key: str, n: int = SCREEN_ROWS) -> tuple[pd.DataFrame, bool]:
    _check_current()
    return _screening_frame(key, n)


@lru_cache(maxsize=8)
def _screening_frame(key: str, n: int = SCREEN_ROWS) -> tuple[pd.DataFrame, bool]:
    """A deterministic subsample used for VARIABLE SCREENING only.

    Information value, correlation and stability are population statistics that
    are stable well below a million rows, and optimal binning over 2M rows takes
    seconds per variable. Model fits always use the full panel.

    The sample is event-preserving: every default is retained and only non-events
    are thinned, so the event rate is unchanged. The returned flag records
    whether any thinning occurred, and the interface reports it.
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


# Caches held elsewhere that are DERIVED from these panels, and so are stale the
# moment the panels are dropped. Registering them here keeps `clear()` the one
# place that has to be right — a derived cache that outlives its source is the
# kind of bug that only shows up after a rebuild.
_DEPENDENT: list = []


def register_dependent_cache(clear_fn) -> None:
    _DEPENDENT.append(clear_fn)


def clear() -> None:
    _load.cache_clear()
    _analysis_frame.cache_clear()
    _screening_frame.cache_clear()
    for fn in _DEPENDENT:
        fn()
