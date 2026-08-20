"""Build the committed FRED cache.

The app must run with no key and no network. So we fetch once, here, and commit
the result. FRED's public CSV endpoint (fredgraph.csv) serves observations with
no API key, which is what makes a genuinely offline demo possible.

The brief requires that every series id is VERIFIED at build time and that any
failure is LOGGED rather than silently dropping the variable. That is what
`fetch_all` returns: a manifest with a row per attempted series, resolved or not.
"""

from __future__ import annotations

import io
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import pandas as pd

from .registry import ALL_CANDIDATES, CRE_CANDIDATES, Mev

FREDGRAPH = "https://fred.stlouisfed.org/graph/fredgraph.csv"
CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "mev_cache"
START = "1990-01-01"


def fetch_series(series_id: str, client: httpx.Client) -> pd.Series:
    """One FRED series as a date-indexed float Series. Raises on failure."""
    r = client.get(FREDGRAPH, params={"id": series_id, "cosd": START}, timeout=45)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    if df.shape[1] < 2:
        raise ValueError(f"{series_id}: unexpected shape {df.shape}")
    date_col = df.columns[0]
    df[date_col] = pd.to_datetime(df[date_col])
    # FRED writes "." for a missing observation.
    vals = pd.to_numeric(df[df.columns[1]], errors="coerce")
    s = pd.Series(vals.to_numpy(), index=pd.DatetimeIndex(df[date_col]), name=series_id)
    s = s.dropna()
    if s.empty:
        raise ValueError(f"{series_id}: no usable observations")
    return s


def _resolve(m: Mev, client: httpx.Client, need_start: str) -> tuple[str, pd.Series, list[str]]:
    """Try the primary id then each alternate. Return the first that resolves AND
    covers `need_start`. Every rejection is returned so the manifest can log it."""
    tried: list[str] = []
    partial: tuple[str, pd.Series] | None = None
    for sid in (m.series_id, *m.alternates):
        try:
            s = fetch_series(sid, client)
        except Exception as e:                  # noqa: BLE001 — logged, never dropped
            tried.append(f"{sid}: {type(e).__name__}: {e}".split("\nFor more")[0])
            continue
        if s.index.min() <= pd.Timestamp(need_start):
            return sid, s, tried
        tried.append(f"{sid}: resolves but starts {s.index.min().date()}, "
                     f"after the required {need_start}")
        partial = partial or (sid, s)
    if partial:                                  # nothing covers; keep the best we have
        return partial[0], partial[1], tried
    raise ValueError("; ".join(tried) or "no candidates")


def fetch_all(verbose: bool = True, need_start: str = "2014-01-01") -> dict:
    """Fetch every catalog series. `need_start` is the coverage bar: the synthetic
    panel starts 2015-01, and the hazard needs a year of lead for lagged terms."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    frames: dict[str, pd.Series] = {}
    resolved_keys: set[str] = set()
    cre_ids = {m.series_id for m in CRE_CANDIDATES}

    with httpx.Client(follow_redirects=True,
                      headers={"User-Agent": "helios-demo/0.1"}) as client:
        for m in ALL_CANDIDATES:
            if m.key in resolved_keys and m.series_id in cre_ids:
                continue
            row = {"key": m.key, "requested_id": m.series_id, "label": m.label,
                   "native": m.native, "kind": m.kind, "measure": m.measure,
                   "agg": m.agg, "unit": m.unit, "group": m.group,
                   "derive": m.derive, "note": m.note}
            try:
                sid, s, tried = _resolve(m, client, need_start)
                frames[m.key] = s
                resolved_keys.add(m.key)
                covers = s.index.min() <= pd.Timestamp(need_start)
                row |= {"status": "ok" if covers else "ok_short", "series_id": sid,
                        "n_obs": int(s.size), "first": str(s.index.min().date()),
                        "last": str(s.index.max().date()),
                        "substituted": sid != m.series_id, "rejected": tried}
                flag = "ok   " if covers else "SHORT"
                if verbose:
                    sub = f"  (substituted for {m.series_id})" if sid != m.series_id else ""
                    print(f"  {flag} {m.key:28s} {sid:20s} {s.size:6d} obs  "
                          f"{s.index.min().date()} .. {s.index.max().date()}{sub}")
                    for t in tried:
                        print(f"        rejected {t}")
            except Exception as e:               # noqa: BLE001
                row |= {"status": "FAILED", "error": str(e)}
                if verbose:
                    print(f"  FAIL  {m.key:28s} {m.series_id:20s} {e}", file=sys.stderr)
            manifest.append(row)

    long = pd.concat(
        [pd.DataFrame({"key": k, "date": s.index, "value": s.to_numpy()})
         for k, s in frames.items()],
        ignore_index=True,
    )
    long.to_parquet(CACHE_DIR / "fred_history.parquet", index=False)

    ok = [r for r in manifest if r["status"] == "ok"]
    short = [r for r in manifest if r["status"] == "ok_short"]
    failed = [r for r in manifest if r["status"] == "FAILED"]
    doc = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "FRED public CSV endpoint (fredgraph.csv) — no API key required",
        "start": START, "coverage_required_from": need_start,
        "n_resolved": len(ok), "n_short": len(short), "n_failed": len(failed),
        "series": manifest,
    }
    (CACHE_DIR / "manifest.json").write_text(json.dumps(doc, indent=2))
    if verbose:
        print(f"\n  {len(ok)} full coverage, {len(short)} short, {len(failed)} failed "
              f"-> {CACHE_DIR}")
        for r in short:
            print(f"  SHORT  {r['key']} / {r['series_id']} starts {r['first']}")
        for r in failed:
            print(f"  FAILED {r['key']} / {r['requested_id']}: {r.get('error')}")
    return doc


def load_history() -> pd.DataFrame:
    """The committed cache, long format. Works offline."""
    return pd.read_parquet(CACHE_DIR / "fred_history.parquet")


if __name__ == "__main__":
    fetch_all()
