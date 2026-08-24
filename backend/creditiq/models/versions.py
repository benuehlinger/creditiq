"""Model version storage.

A version is a portable JSON file holding EVERYTHING needed to reproduce a fit —
data source, cleaning, target, sample design, variables with their full binning
maps, estimator, macro specification with lags, EAD method, scenario weights,
plus the fitted metrics for reference.

Because it is portable, a specification can be emailed, diffed in git, and re-run
to identical results. That is the reproducibility story, and it is worth saying
out loud in the demo.

The IDENTITY is the content hash. The friendly name is derived from it, so an
identical specification always produces an identical name and an accidental
duplicate is visible immediately. Renaming never breaks a reference because
nothing references the name.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import pandas as pd

from .naming import friendly_name
from .spec import ModelSpec

VERSIONS_DIR = Path(__file__).resolve().parents[3] / "versions"
BUILD_REPORT = Path(__file__).resolve().parents[3] / "data" / "synthetic" / "build_report.json"
SCHEMA_VERSION = 2


def data_fingerprint(portfolio: str) -> str:
    """What the model was fitted ON, not just what it was fitted WITH.

    A specification reproduces exactly — same variables, same binning, same
    hash — against a DIFFERENT panel, and returns different coefficients, a
    different AUC and a different loss number while still calling itself the same
    model. That happened here: moving the panel open from 2015 to 2008 left seven
    saved versions whose stored metrics described a dataset that no longer
    existed, and nothing on screen said so.

    So the data gets an identity too. A version fitted on a superseded panel is
    now visible as one, rather than quietly wrong.
    """
    try:
        rep = json.loads(BUILD_REPORT.read_text())[portfolio]
    except Exception:                                                   # noqa: BLE001
        return ""
    blob = json.dumps({k: rep[k] for k in ("rows", "accounts", "defaults", "window",
                                           "seed") if k in rep}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


@dataclass
class Version:
    hash: str
    name: str
    portfolio: str
    created_at: str
    spec: dict
    metrics: dict = field(default_factory=dict)
    ecl: dict = field(default_factory=dict)
    status: str = "challenger"          # champion | challenger | archived
    starred: bool = False
    tags: list[str] = field(default_factory=list)
    notes: str = ""
    parent_hash: str | None = None
    # Set when this version replaced an earlier one in place. The earlier file is
    # removed, so this records what it superseded.
    replaced_hash: str | None = None
    author: str = "CreditIQ"
    # Empty means the version predates fingerprinting, which is itself the
    # finding: nothing recorded which panel produced these numbers.
    data_fingerprint: str = ""
    schema_version: int = SCHEMA_VERSION

    def data_is_current(self) -> bool:
        return bool(self.data_fingerprint) and \
            self.data_fingerprint == data_fingerprint(self.portfolio)

    def to_dict(self) -> dict:
        return asdict(self)


def _path(hash_: str) -> Path:
    return VERSIONS_DIR / f"{hash_}.json"


def save(spec: ModelSpec, metrics: dict, ecl: dict | None = None,
         label: str | None = None, notes: str = "", tags: list[str] | None = None,
         parent_hash: str | None = None, author: str = "CreditIQ",
         replaces: str | None = None) -> Version:
    """Write a version.

    `replaces` supersedes an existing version. The hash is derived from the
    specification, so a changed specification cannot keep the old hash; the new
    version inherits the replaced one's status, tags and starred flag, records
    what it superseded, and the replaced file is removed. Without it, saving
    leaves both versions in place and the new one records the other as its
    parent.
    """
    prior = load(replaces) if replaces else None
    VERSIONS_DIR.mkdir(parents=True, exist_ok=True)
    h = spec.hash()
    existing = load(h)
    inherit = existing or prior
    v = Version(
        hash=h, name=label or (existing.name if existing else friendly_name(h)),
        portfolio=spec.portfolio,
        created_at=existing.created_at if existing
        else pd.Timestamp.utcnow().isoformat(timespec="seconds"),
        spec=spec.to_dict(), metrics=metrics, ecl=ecl or {},
        status=inherit.status if inherit else "challenger",
        starred=inherit.starred if inherit else False,
        tags=tags if tags is not None else (inherit.tags if inherit else []),
        notes=notes or (inherit.notes if inherit else ""),
        parent_hash=parent_hash or (existing.parent_hash if existing
                                    else prior.parent_hash if prior else None),
        replaced_hash=(prior.hash if prior and prior.hash != h else None),
        author=author, data_fingerprint=data_fingerprint(spec.portfolio),
    )
    _path(h).write_text(json.dumps(v.to_dict(), indent=2, default=str))
    if prior is not None and prior.hash != h:
        # Anything that recorded the replaced version as its parent is re-pointed,
        # so the lineage graph does not lose a branch when a node is superseded.
        for other in list_all(spec.portfolio):
            if other.parent_hash == prior.hash and other.hash != h:
                update(other.hash, parent_hash=h)
        delete(prior.hash)
    return v


def load(hash_: str) -> Version | None:
    p = _path(hash_)
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    d.pop("schema_version", None)
    return Version(**d, schema_version=SCHEMA_VERSION)


def list_all(portfolio: str | None = None) -> list[Version]:
    if not VERSIONS_DIR.exists():
        return []
    out = []
    for p in sorted(VERSIONS_DIR.glob("*.json")):
        try:
            d = json.loads(p.read_text())
            d.pop("schema_version", None)
            v = Version(**d, schema_version=SCHEMA_VERSION)
        except Exception:                                               # noqa: BLE001
            continue                              # a malformed file never breaks the list
        if portfolio is None or v.portfolio == portfolio:
            out.append(v)
    return sorted(out, key=lambda v: v.created_at, reverse=True)


def update(hash_: str, **fields) -> Version | None:
    v = load(hash_)
    if v is None:
        return None
    for k, val in fields.items():
        if hasattr(v, k) and val is not None:
            setattr(v, k, val)
    _path(hash_).write_text(json.dumps(v.to_dict(), indent=2, default=str))
    return v


def promote(hash_: str) -> Version | None:
    """Exactly one champion per portfolio. Promoting demotes the incumbent."""
    v = load(hash_)
    if v is None:
        return None
    for other in list_all(v.portfolio):
        if other.hash != hash_ and other.status == "champion":
            update(other.hash, status="challenger")
    return update(hash_, status="champion")


def delete(hash_: str) -> bool:
    p = _path(hash_)
    if p.exists():
        p.unlink()
        return True
    return False


def champion(portfolio: str) -> Version | None:
    return next((v for v in list_all(portfolio) if v.status == "champion"), None)


# ── comparison ───────────────────────────────────────────────────────────────
def compare(hashes: list[str]) -> dict:
    """Two to four versions, side by side.

    The variable diff is a SET DIFF, not two lists to eyeball, and a coefficient
    SIGN FLIP between specifications is called out loudly — a variable that
    changes direction when another is added is a real finding about collinearity,
    not a rounding difference.
    """
    versions = [v for v in (load(h) for h in hashes) if v is not None]
    if not versions:
        return {"versions": [], "metrics": [], "variables": {}, "coefficients": []}

    metric_keys = [
        ("auc_test", "AUC (test)", "up"), ("auc_oot", "AUC (out of time)", "up"),
        ("ks_test", "KS (test)", "up"), ("gini_test", "Gini (test)", "up"),
        ("log_loss_test", "Log loss (test)", "down"),
        ("brier_test", "Brier (test)", "down"),
        ("calibration_error", "PD calibration error", "down"),
        # Severity. `zero` is a third direction: a bias is best at nothing, and
        # neither the largest nor the smallest signed value is the good one.
        ("lgd_bias", "LGD bias (out of time)", "zero"),
        ("lgd_rmse", "LGD RMSE (out of time)", "down"),
        ("lgd_mae", "LGD mean absolute error", "down"),
        ("lgd_deviance_r2", "LGD deviance R²", "up"),
        ("lgd_spearman", "LGD rank correlation", "up"),
        ("ecl_severely_adverse", "ECL — severely adverse", "down"),
        ("ecl_baseline", "ECL — baseline", "down"),
    ]
    metrics = []
    for key, label, good in metric_keys:
        vals = [v.metrics.get(key, v.ecl.get(key)) for v in versions]
        if all(x is None for x in vals):
            continue
        metrics.append({"key": key, "label": label, "better": good, "values": vals})

    sets = {v.hash: {x["column"] for x in v.spec.get("variables", [])} for v in versions}
    all_vars = sorted(set().union(*sets.values())) if sets else []
    shared = sorted(set.intersection(*sets.values())) if sets else []
    variables = {
        "all": all_vars, "shared": shared,
        "per_version": {h: sorted(s) for h, s in sets.items()},
        "added": {v.hash: sorted(sets[v.hash] - set(shared)) for v in versions},
        "missing": {v.hash: sorted(set(all_vars) - sets[v.hash]) for v in versions},
    }

    coefficients = []
    for col in shared:
        row = {"variable": col, "values": []}
        signs = set()
        for v in versions:
            c = (v.metrics.get("coefficients") or {}).get(f"{col}_woe")
            row["values"].append(c)
            if c is not None:
                signs.add(1 if c > 0 else -1)
        row["sign_flip"] = len(signs) > 1
        coefficients.append(row)
    coefficients.sort(key=lambda r: (not r["sign_flip"], r["variable"]))

    return {"versions": [v.to_dict() for v in versions], "metrics": metrics,
            "variables": variables, "coefficients": coefficients}


def lineage(portfolio: str) -> dict:
    """The fork graph. It tells the story of the analyst's afternoon in one picture."""
    vs = list_all(portfolio)
    known = {v.hash for v in vs}
    return {
        "nodes": [{"hash": v.hash, "name": v.name, "status": v.status,
                   "created_at": v.created_at, "starred": v.starred,
                   "auc": v.metrics.get("auc_test"),
                   "n_variables": len(v.spec.get("variables", []))} for v in vs],
        "edges": [{"from": v.parent_hash, "to": v.hash}
                  for v in vs if v.parent_hash and v.parent_hash in known],
    }
