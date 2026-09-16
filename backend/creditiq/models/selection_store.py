"""User-made selection state: saved configurations and the review record.

Everything here is the reviewer's work product, not a computation: which
candidates they offered the search, how they re-ranked the board, what they
rejected and why. It lives under `versions/selection/` — the same gitignored,
restart-surviving, `make reset`-cleared home as saved models — and never in
the run cache, which prunes.

The review record is append-only where it matters: every mutation writes an
audit row (reviewer, timestamp, field, before, after), because the point of a
reviewer workflow is that model validation can read what happened afterwards.
The automated rank is never stored here — it belongs to the search results —
and the user rank never overwrites it. Two rankings, kept side by side, is
the design.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pandas as pd

REASON_CODES = (
    "counterintuitive_mev_sign",
    "mev_not_intuitive_for_portfolio",
    "unstable_coefficients",
    "weak_stress_response",
    "business_judgment",
    "other",
)
STATUSES = ("champion", "challenger", "rejected")


def _base() -> Path:
    # Resolved at call time through the versions module, so a test that
    # repoints VERSIONS_DIR moves this store with it.
    from . import versions as V
    return Path(V.VERSIONS_DIR) / "selection"


def _configs_dir() -> Path:
    return _base() / "configs"


def _reviews_dir() -> Path:
    return _base() / "reviews"


# ── configurations ───────────────────────────────────────────────────────────
def save_config(cfg, name: str | None = None) -> dict:
    from .selection import SelectionConfig
    assert isinstance(cfg, SelectionConfig)
    _configs_dir().mkdir(parents=True, exist_ok=True)
    rec = {
        "id": cfg.hash(), "portfolio": cfg.portfolio,
        "name": name or cfg.label or cfg.hash(),
        "saved_at": pd.Timestamp.utcnow().isoformat(timespec="seconds"),
        "config": cfg.to_dict(),
    }
    path = _configs_dir() / f"{cfg.portfolio}-{cfg.hash()}.json"
    path.write_text(json.dumps(rec, indent=2, default=str))
    return rec


def list_configs(portfolio: str) -> list[dict]:
    d = _configs_dir()
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob(f"{portfolio}-*.json")):
        try:
            rec = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        out.append({k: rec.get(k) for k in ("id", "portfolio", "name", "saved_at")})
    return out


def load_config(portfolio: str, config_id: str) -> dict | None:
    p = _configs_dir() / f"{portfolio}-{config_id}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


def delete_config(portfolio: str, config_id: str) -> bool:
    p = _configs_dir() / f"{portfolio}-{config_id}.json"
    if p.exists():
        p.unlink()
        return True
    return False


# ── the review record ────────────────────────────────────────────────────────
def _review_path(portfolio: str, config_hash: str) -> Path:
    return _reviews_dir() / f"{portfolio}-{config_hash}.json"


def load_review(portfolio: str, config_hash: str) -> dict:
    p = _review_path(portfolio, config_hash)
    if not p.exists():
        return {"portfolio": portfolio, "config_hash": config_hash,
                "rows": {}, "audit": []}
    return json.loads(p.read_text())


def _write(review: dict) -> None:
    _reviews_dir().mkdir(parents=True, exist_ok=True)
    p = _review_path(review["portfolio"], review["config_hash"])
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(review, indent=2, default=str))
    tmp.replace(p)


def _audit(review: dict, reviewer: str, model_hash: str,
           field: str, before, after) -> None:
    review["audit"].append({
        "reviewer": reviewer,
        "at": pd.Timestamp.utcnow().isoformat(timespec="seconds"),
        "model_hash": model_hash, "field": field,
        "before": before, "after": after,
    })


class ReviewError(ValueError):
    """A review mutation the record refuses, with the reason stated."""


def update_row(portfolio: str, config_hash: str, model_hash: str,
               changes: dict, reviewer: str, auto_rank: int | None) -> dict:
    """Apply status / reason / justification / user_rank changes to one model.

    The record enforces the two rules the export is later judged by:
    a rejection carries a justification, and a user rank that differs from
    the automated rank carries one too. A missing justification is an error
    naming the field, not a silent save.
    """
    if not reviewer or not reviewer.strip():
        raise ReviewError("reviewer is required: the audit trail records who")
    review = load_review(portfolio, config_hash)
    row = review["rows"].get(model_hash, {})
    merged = {**row, **{k: v for k, v in changes.items() if k in
                        ("status", "reason_code", "justification", "user_rank")}}

    status = merged.get("status")
    if status is not None and status not in STATUSES:
        raise ReviewError(f"status must be one of {', '.join(STATUSES)}")
    reason = merged.get("reason_code")
    if reason is not None and reason not in REASON_CODES:
        raise ReviewError(f"reason_code must be one of {', '.join(REASON_CODES)}")

    just = (merged.get("justification") or "").strip()
    if status == "rejected" and not just:
        raise ReviewError(
            "justification is required to reject a model. The export has to "
            "say why")
    user_rank = merged.get("user_rank")
    if (user_rank is not None and auto_rank is not None
            and user_rank != auto_rank and not just):
        raise ReviewError(
            "justification is required when the user rank differs from the "
            "automated rank")

    for k in ("status", "reason_code", "justification", "user_rank"):
        if k in changes and row.get(k) != merged.get(k):
            _audit(review, reviewer, model_hash, k, row.get(k), merged.get(k))
    review["rows"][model_hash] = merged
    _write(review)
    return review


def reorder(portfolio: str, config_hash: str, order: list[str],
            reviewer: str, auto_ranks: dict[str, int | None],
            justifications: dict[str, str] | None = None) -> dict:
    """Set the user rank for the whole board in one move.

    `order` is the hashes as the reviewer arranged them, best first. Every
    model whose new rank differs from its automated rank needs a
    justification — supplied now, or already on file for that model.
    """
    if not reviewer or not reviewer.strip():
        raise ReviewError("reviewer is required: the audit trail records who")
    justifications = justifications or {}
    review = load_review(portfolio, config_hash)

    missing = []
    for i, h in enumerate(order, 1):
        auto = auto_ranks.get(h)
        if auto is not None and i != auto:
            just = (justifications.get(h)
                    or (review["rows"].get(h, {}).get("justification") or "")).strip()
            if not just:
                missing.append(h)
    if missing:
        raise ReviewError(
            "justification is required for every model ranked away from its "
            "automated rank; missing for: " + ", ".join(missing))

    for i, h in enumerate(order, 1):
        row = review["rows"].get(h, {})
        if row.get("user_rank") != i:
            # The audit records DEVIATIONS, not the identity ordering: a board
            # of seven hundred models all confirmed at their automated rank is
            # one fact, not seven hundred rows. A model moved away from its
            # automated rank is recorded, and so is one moved back to it.
            diverges = auto_ranks.get(h) is not None and i != auto_ranks[h]
            returned = row.get("user_rank") is not None
            if diverges or returned:
                _audit(review, reviewer, h, "user_rank", row.get("user_rank"), i)
        if h in justifications and justifications[h].strip() \
                and row.get("justification") != justifications[h]:
            _audit(review, reviewer, h, "justification",
                   row.get("justification"), justifications[h])
            row = {**row, "justification": justifications[h]}
        review["rows"][h] = {**row, "user_rank": i}
    _write(review)
    return review


def export_csv(portfolio: str, config_hash: str) -> str:
    """The audit trail as CSV, for the model-validation binder."""
    review = load_review(portfolio, config_hash)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["reviewer", "at", "model_hash", "field", "before", "after"])
    for a in review["audit"]:
        w.writerow([a["reviewer"], a["at"], a["model_hash"],
                    a["field"], a["before"], a["after"]])
    return buf.getvalue()
