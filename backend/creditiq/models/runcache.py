"""Disk persistence for fitted results.

The in-memory caches answer "have I run this specification before?" only for
the life of the process. Restart the server and every previously fitted model
comes back as a twenty-second refit, which reads on screen as "this was never
run" — the opposite of what actually happened. So a computed result is also
written to disk, and the memory caches fall back here before recomputing.

Everything stored is DERIVED — spec plus panel, nothing else — so this cache
can be deleted at any time and costs only recomputation. Two rules keep it
honest:

  * Keys include the portfolio's data fingerprint. A rebuilt panel gets a new
    fingerprint, so every run fitted on the old panel silently stops being
    found rather than being served stale. Directories for superseded
    fingerprints of the same portfolio are pruned on the next write.

  * A bounded number of entries per portfolio, oldest out first, because a
    PD run carries its scored panel (needed to re-cohort the backtest without
    refitting) and those are tens of megabytes each.

Pickle is acceptable here: the files are written and read only by this
process, live inside the project's own data directory, and never cross a
trust boundary.
"""
from __future__ import annotations

import functools
import pickle
from pathlib import Path

from .versions import data_fingerprint

CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "cache"
MAX_PER_PORTFOLIO = 24


def _dir(portfolio: str) -> Path:
    fp = data_fingerprint(portfolio) or "nofp"
    return CACHE_DIR / f"{portfolio}-{fp}"


def load(portfolio: str, kind: str, key: str):
    """The cached object, or None. A file that fails to unpickle — a version
    skew, a truncated write — is treated as absent and recomputed."""
    p = _dir(portfolio) / f"{kind}-{key}.pkl"
    if not p.exists():
        return None
    try:
        return pickle.loads(p.read_bytes())
    except Exception:                                                   # noqa: BLE001
        try:
            p.unlink()
        except OSError:
            pass
        return None


def save(portfolio: str, kind: str, key: str, obj) -> None:
    """Best-effort: a full disk or read-only volume degrades to memory-only
    caching rather than failing the request that produced the result."""
    try:
        d = _dir(portfolio)
        d.mkdir(parents=True, exist_ok=True)
        _prune_superseded(portfolio, d)
        tmp = d / f".{kind}-{key}.tmp"
        tmp.write_bytes(pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL))
        tmp.replace(d / f"{kind}-{key}.pkl")
        _prune_oldest(d)
    except Exception:                                                   # noqa: BLE001
        pass


def _prune_superseded(portfolio: str, current: Path) -> None:
    """Directories for OLD fingerprints of this portfolio. Other portfolios'
    directories are left alone — their fingerprints differ by construction."""
    if not CACHE_DIR.exists():
        return
    for d in CACHE_DIR.glob(f"{portfolio}-*"):
        if d.is_dir() and d != current:
            for f in d.iterdir():
                f.unlink(missing_ok=True)
            d.rmdir()


def _prune_oldest(d: Path) -> None:
    files = sorted(d.glob("*.pkl"), key=lambda p: p.stat().st_mtime)
    for f in files[:-MAX_PER_PORTFOLIO]:
        f.unlink(missing_ok=True)


def disk_through(kind: str):
    """Give a per-portfolio derived computation the disk layer.

    Stack UNDER an lru_cache: memory answers first, this layer answers across
    process restarts, and a miss on both computes and saves. The development
    loop restarts the server on every code edit, so without this the expensive
    read-only surfaces — screening, the panel profile, the macro library —
    recomputed for seconds on every first visit after every edit, which the
    user met as a full-page skeleton.

    The one tradeoff, accepted for the fitted runs already: the key is the
    DATA's fingerprint, so a change to the computation's own code keeps
    serving the old result until the data is rebuilt or data/cache/ is
    deleted. `make reset` clears it.
    """
    def deco(fn):
        @functools.wraps(fn)
        def wrapped(portfolio: str):
            prev = load(portfolio, kind, "all")
            if prev is not None:
                return prev
            out = fn(portfolio)
            save(portfolio, kind, "all", out)
            return out
        return wrapped
    return deco
