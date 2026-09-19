"""Loan tape ingestion: a validation gate, not a preparation engine.

credit-iq accepts a file that is ALREADY a panel — one row per account per
month at risk — maps the seller's column names onto the canonical schema,
asks the four questions the synthetic books hardcode (default definition,
EAD method, out-of-time start, a name), and registers the result as a book
beside the synthetic ones. It refuses clearly when the file is not a panel.

It never builds a panel. Converting a snapshot or a raw performance file
into account-months requires judgement — a default definition, exit rules,
an observation window — and judgement belongs in the CECL product, where
every such decision is documented (docs/CECL-FORK.md). Here the only
"preparation" is renaming columns and parsing dates, both shown to the user
before anything is written.

Mapping direction: the seller's names map ONTO the canonical names. The
whole app addresses `default_flag`, `performance_date`, `lgd_realised` by
name; standardising at the door means zero special cases past it. The
original names are recorded in the book's registry entry.

The registry is one JSON file per book in `data/tapes/`, next to the two
parquet files. On import, `register_all()` rebuilds the in-memory
`PORTFOLIOS` entries, so ingested books survive a server restart exactly
like synthetic ones. The registry also carries a content fingerprint that
plays the role `build_report.json` plays for synthetic books: caches and
saved versions key on it, so replacing a tape's data invalidates cleanly
instead of serving stale results.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import shutil
from pathlib import Path

import pandas as pd

from ..mev.registry import PORTFOLIO_MEVS, by_key
from .portfolios import PORTFOLIOS
from .spec import PortfolioSpec, TargetDef

TAPES_DIR = Path(__file__).resolve().parents[3] / "data" / "tapes"
STAGING = TAPES_DIR / ".staging"

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,23}$")

# Words the frontend router and the API own; a book by these names would
# shadow a route.
RESERVED_KEYS = {"rollup", "brand", "tapes", "api", "assets", "data"}

# ── the canonical schema ─────────────────────────────────────────────────────
# One row per account per month. `role` is what the app uses the column for;
# `required` means ingestion refuses without it. Everything not listed simply
# rides along as a candidate driver.
SCHEMA: list[dict] = [
    {"name": "account_id", "role": "identity", "required": True,
     "about": "One value per account, stable across months."},
    {"name": "performance_date", "role": "identity", "required": True,
     "about": "The observation month. Parsed as a date; monthly grain."},
    {"name": "default_flag", "role": "target", "required": True,
     "about": "1 in the month the account defaults under your definition, else 0."},
    {"name": "current_balance", "role": "exposure", "required": False,
     "about": "Outstanding balance at the observation month. Needed for ECL."},
    {"name": "origination_date", "role": "driver", "required": False,
     "about": "Lets the app derive months on book if absent."},
    {"name": "months_on_book", "role": "driver", "required": False,
     "about": "Account age in months. Derived from origination_date if absent."},
    {"name": "scheduled_payment", "role": "exposure", "required": False,
     "about": "Needed to project amortising exposure at default."},
    {"name": "interest_rate", "role": "exposure", "required": False,
     "about": "Needed to project amortising exposure at default."},
    {"name": "remaining_term", "role": "exposure", "required": False,
     "about": "Needed to project amortising exposure at default."},
    {"name": "committed_amount", "role": "exposure", "required": False,
     "about": "Facility commitment. Needed for the CCF exposure method."},
    {"name": "lgd_realised", "role": "severity", "required": False,
     "about": "Realised loss severity on resolved defaults, 0 to 1. "
              "Without it this book cannot have a severity model."},
    {"name": "exposure_at_default", "role": "severity", "required": False,
     "about": "Exposure at the default month, for severity weighting."},
    {"name": "recovery_amount", "role": "severity", "required": False,
     "about": "Recovered amount on resolved defaults."},
    {"name": "workout_months", "role": "severity", "required": False,
     "about": "Months from default to resolution."},
]
REQUIRED = [c["name"] for c in SCHEMA if c["required"]]

# Column-name variants sellers actually use, for suggesting a mapping. The
# suggestion is a preselect in the UI, never applied silently.
ALIASES: dict[str, list[str]] = {
    "account_id": ["loan_id", "acct_id", "loan_number", "account_number", "id",
                   "loanid", "acct_no"],
    "performance_date": ["as_of_date", "asof_date", "report_date", "month",
                         "period", "activity_date", "snapshot_date", "date"],
    "default_flag": ["default", "defaulted", "df", "default_ind",
                     "default_indicator", "chargeoff_flag", "co_flag"],
    "current_balance": ["balance", "upb", "current_upb", "outstanding_balance",
                        "principal_balance", "bal"],
    "origination_date": ["orig_date", "open_date", "boarding_date",
                         "funded_date", "note_date"],
    "months_on_book": ["mob", "age", "loan_age", "seasoning"],
    "scheduled_payment": ["payment", "pmt", "monthly_payment", "p_and_i"],
    "interest_rate": ["rate", "note_rate", "coupon", "apr", "int_rate"],
    "remaining_term": ["rem_term", "remaining_months", "term_remaining"],
    "committed_amount": ["commitment", "credit_limit", "limit", "facility_amount"],
    "lgd_realised": ["lgd", "realised_lgd", "realized_lgd", "loss_severity",
                     "severity", "lgd_actual"],
    "exposure_at_default": ["ead", "default_balance", "balance_at_default"],
    "recovery_amount": ["recoveries", "recovery", "recovered", "net_recovery"],
    "workout_months": ["workout_period", "resolution_months", "months_to_resolve"],
}

# SEC Form ABS-EE, Reg AB II Schedule AL — the public standard every
# securitized tape is filed in, so a buyer's diligence file often arrives in
# exactly these names. Case and separators are normalized away, so the
# camelCase the SEC files (`assetNumber`) matches the snake_case written here.
#
# There is deliberately NO default_flag alias. ABS-EE carries
# `zeroBalanceCode`, which is neither 0/1 nor a hazard target: it is sticky,
# repeating on every filing after the loan resolves, and it covers prepayment
# and repurchase alongside charge-off. Turning it into a target means deciding
# what counts as default and which month it fired, which is panel construction
# and belongs upstream of this gate (docs/CECL-FORK.md).
ABS_EE_ALIASES: dict[str, list[str]] = {
    "account_id": ["asset_number"],
    "performance_date": ["reporting_period_beginning_date",
                         "reporting_period_ending_date"],
    "current_balance": ["reporting_period_actual_end_balance_amount",
                        "reporting_period_beginning_loan_balance_amount"],
    "scheduled_payment": ["reporting_period_scheduled_payment_amount",
                          "next_reporting_period_payment_amount_due"],
    "interest_rate": ["reporting_period_interest_rate_percentage",
                      "original_interest_rate_percentage"],
    "remaining_term": ["remaining_term_to_maturity_number"],
    "recovery_amount": ["recovered_amount", "liquidation_proceeds_amount"],
    "exposure_at_default": ["charged_off_principal_amount"],
}
for _canon, _names in ABS_EE_ALIASES.items():
    ALIASES.setdefault(_canon, []).extend(_names)


def _read_table(path: Path) -> pd.DataFrame:
    if path.suffix.lower() in (".parquet", ".pq"):
        return pd.read_parquet(path)
    return pd.read_csv(path, low_memory=False)


def _alias_key(s: str) -> str:
    """Lowercase, letters and digits only. The one place naming convention is
    normalized away; `.lower()` matters on the alias side too, or an alias
    written with a capital would silently lose that letter entirely."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def suggest_mapping(columns: list[str]) -> dict[str, str | None]:
    """canonical name -> the seller's column that likely holds it, or None.

    Exact match first (case/space-insensitive), then the alias list. A seller
    column is suggested at most once, best claim wins in schema order.
    """
    # Case and separators are stripped on BOTH sides, so one alias covers every
    # convention a seller might file in: loan_id, loanId, LoanId, LOAN_ID,
    # loan-id and "Loan Id" all reduce to the same key. Only the VOCABULARY has
    # to be listed — a name built from different words still needs its alias.
    norm = {_alias_key(c): c for c in columns}
    taken: set[str] = set()
    out: dict[str, str | None] = {}
    for item in SCHEMA:
        name = item["name"]
        hit = None
        key = _alias_key(name)
        if key in norm and norm[key] not in taken:
            hit = norm[key]
        else:
            for alias in ALIASES.get(name, []):
                akey = _alias_key(alias)
                if akey in norm and norm[akey] not in taken:
                    hit = norm[akey]
                    break
        out[name] = hit
        if hit:
            taken.add(hit)
    return out


# ── staging: inspect once, ingest without re-uploading ───────────────────────
def stage(filename: str, content: bytes) -> dict:
    """Hold an upload, look at its columns, and report what a mapping needs.

    Nothing is registered here. The report carries a token; ingest() takes
    the token plus the confirmed mapping and the four answers.
    """
    STAGING.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(8)
    suffix = Path(filename).suffix.lower() or ".csv"
    if suffix not in (".csv", ".parquet", ".pq"):
        raise ValueError(f"unsupported file type {suffix!r}: upload a .csv or "
                         f".parquet export of the panel")
    p = STAGING / f"{token}{suffix}"
    p.write_bytes(content)
    try:
        df = _read_table(p)
    except Exception as e:                                              # noqa: BLE001
        p.unlink(missing_ok=True)
        raise ValueError(f"could not read {filename}: {type(e).__name__}: {e}")
    if len(df) == 0:
        p.unlink(missing_ok=True)
        raise ValueError(f"{filename} parsed but holds no rows")
    suggestion = suggest_mapping(list(df.columns))
    return {
        "token": token,
        "filename": filename,
        "n_rows": int(len(df)),
        "n_columns": int(df.shape[1]),
        "columns": [{"name": c, "dtype": str(df[c].dtype),
                     "n_unique": int(df[c].nunique(dropna=True)),
                     "sample": [str(v) for v in df[c].dropna().head(3)]}
                    for c in df.columns],
        "schema": SCHEMA,
        "suggested_mapping": suggestion,
        "missing_required": [n for n in REQUIRED if suggestion.get(n) is None],
    }


def _staged_path(token: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{16}", token or ""):
        raise ValueError("unknown staging token")
    hits = list(STAGING.glob(f"{token}.*"))
    if not hits:
        raise ValueError("this upload is no longer staged — upload the file again")
    return hits[0]


# ── ingest ───────────────────────────────────────────────────────────────────
def ingest(token: str, key: str, label: str, mapping: dict[str, str],
           dpd_state: int, ead_method: str, oot_from: str) -> dict:
    """Validate the staged file as a panel and register it as a book.

    Refuses, with the reason, when: the key is taken or malformed, a required
    column is unmapped or missing, dates do not parse, the default flag is
    not 0/1, or the account-month key is not unique. Integrity findings that
    are judgements rather than impossibilities (gaps, negative balances, an
    implausible default rate) do NOT refuse — they are exactly what the Data
    surface exists to show.
    """
    if not KEY_RE.fullmatch(key):
        raise ValueError("the book key must be 2-24 characters of lowercase "
                         "letters, digits or underscore, starting with a letter")
    if key in RESERVED_KEYS:
        raise ValueError(f"{key!r} is reserved — pick another key")
    if key in PORTFOLIOS:
        raise ValueError(f"a book named {key!r} already exists")
    if ead_method not in ("amortizing", "ccf"):
        raise ValueError("ead_method must be 'amortizing' or 'ccf'")
    label = (label or "").strip()
    if not label:
        raise ValueError("give the book a display name")

    src = _staged_path(token)
    df = _read_table(src)

    # Apply the confirmed mapping: seller's name -> canonical name.
    rename = {theirs: ours for ours, theirs in mapping.items()
              if theirs and theirs in df.columns and theirs != ours}
    clash = [ours for ours, theirs in mapping.items()
             if theirs and theirs != ours and ours in df.columns]
    if clash:
        raise ValueError(
            "the file already has columns named "
            f"{', '.join(sorted(clash))}, and the mapping would overwrite "
            "them — unmap those fields or rename the originals")
    df = df.rename(columns=rename)

    missing = [n for n in REQUIRED if n not in df.columns]
    if missing:
        raise ValueError(
            "not a usable panel: missing " + ", ".join(missing)
            + ". Map an existing column onto each, or add it to the file.")

    # Dates parse or the file is refused — a panel without a readable month
    # grain cannot be modelled, and coercing silently would hide it.
    for col in ("performance_date", "origination_date"):
        if col not in df.columns:
            continue
        parsed = pd.to_datetime(df[col], errors="coerce")
        bad = int(parsed.isna().sum()) - int(df[col].isna().sum())
        if bad > 0.02 * len(df):
            raise ValueError(
                f"{col}: {bad:,} of {len(df):,} values did not parse as "
                f"dates (e.g. {df[col][parsed.isna()].dropna().iloc[0]!r})")
        df[col] = parsed.dt.to_period("M").dt.to_timestamp()

    flag = pd.to_numeric(df["default_flag"], errors="coerce")
    # Values that refuse to be numbers ('Y', 'CO', a status word) coerce to
    # NaN — and an all-NaN column would sail through a bare subset check and
    # silently become zeros, which is exactly the recode this gate exists to
    # refuse. Count the coercions, not just the survivors.
    coerced = int(flag.isna().sum()) - int(df["default_flag"].isna().sum())
    vals = set(flag.dropna().unique().tolist())
    if coerced > 0 or not vals.issubset({0, 1, 0.0, 1.0}):
        examples = df["default_flag"][flag.isna() & df["default_flag"].notna()]             .astype(str).unique()[:4].tolist() or sorted(list(vals))[:6]
        raise ValueError(
            "default_flag must be 0/1; found values "
            f"{examples}. Recode it before uploading — choosing what counts "
            "as a default is a judgement this tool will not make.")
    df["default_flag"] = flag.fillna(0).astype("int8")

    dup = int(df.duplicated(["account_id", "performance_date"]).sum())
    if dup:
        raise ValueError(
            f"{dup:,} duplicate account-month rows. A panel has one row per "
            "account per month; deduplicate before uploading.")

    if "months_on_book" not in df.columns and "origination_date" in df.columns:
        df["months_on_book"] = (
            (df["performance_date"].dt.year - df["origination_date"].dt.year) * 12
            + (df["performance_date"].dt.month - df["origination_date"].dt.month)
        ).clip(lower=0).astype("int32")

    warnings: list[str] = []
    if "lgd_realised" in df.columns:
        df["lgd_realised"] = pd.to_numeric(df["lgd_realised"], errors="coerce") \
            .clip(0.0, 1.0)
    else:
        warnings.append(
            "No realised-LGD column was mapped, so this book cannot have a "
            "severity model — and without one, no ECL. PD modelling works.")
    if "current_balance" not in df.columns:
        warnings.append(
            "No current balance was mapped, so exposure — and therefore ECL — "
            "is unavailable. PD modelling works.")
    if ead_method == "amortizing":
        need = [c for c in ("scheduled_payment", "interest_rate",
                            "remaining_term") if c not in df.columns]
        if need:
            warnings.append(
                "Amortising exposure projection needs "
                + ", ".join(need) + "; projections fall back to current "
                "balance held flat.")
    if ead_method == "ccf" and "committed_amount" not in df.columns:
        warnings.append("The CCF exposure method needs committed_amount; "
                        "it is not mapped.")
    oot = pd.Timestamp(oot_from)
    lo, hi = df["performance_date"].min(), df["performance_date"].max()
    if not (lo < oot <= hi):
        warnings.append(
            f"The out-of-time start {oot.date()} is outside the panel's "
            f"window {lo.date()} to {hi.date()}; backtests will be empty "
            "until it is moved.")

    # The accounts table: columns constant within account, first value each.
    # Sellers often ship one wide monthly file; the app expects the static
    # attributes split out. Constancy is measured, not assumed.
    ids = df["account_id"]
    sample_ids = ids.drop_duplicates().head(5000)
    probe = df[ids.isin(sample_ids)]
    static_cols = ["account_id"]
    for c in df.columns:
        if c in ("account_id", "performance_date", "default_flag"):
            continue
        if probe.groupby("account_id", observed=True)[c].nunique(dropna=False) \
                .le(1).all():
            static_cols.append(c)
    accounts = df.groupby("account_id", as_index=False, observed=True)[
        static_cols].first() if len(static_cols) > 1 else \
        df[["account_id"]].drop_duplicates()

    TAPES_DIR.mkdir(parents=True, exist_ok=True)
    panel_path = TAPES_DIR / f"{key}_panel.parquet"
    accounts_path = TAPES_DIR / f"{key}_accounts.parquet"
    df.to_parquet(panel_path, index=False)
    accounts.to_parquet(accounts_path, index=False)

    fingerprint = hashlib.sha256(
        panel_path.read_bytes() + accounts_path.read_bytes()).hexdigest()[:12]

    record = {
        "key": key, "label": label,
        "target": {"column": "default_flag",
                   "description": f"Default under the seller's definition, "
                                  f"tripping at delinquency state {dpd_state}",
                   "dpd_state": int(dpd_state), "label": "Default"},
        "ead_method": ead_method,
        "default_oot_from": str(oot.date()),
        "mapping": {ours: theirs for ours, theirs in mapping.items() if theirs},
        "original_columns": sorted(rename.keys()),
        "fingerprint": fingerprint,
        "ingested_at": pd.Timestamp.utcnow().isoformat(timespec="seconds"),
        "source_file": src.name,
        "n_rows": int(len(df)), "n_accounts": int(accounts.shape[0]),
        "warnings": warnings,
    }
    (TAPES_DIR / f"{key}.json").write_text(json.dumps(record, indent=2))
    src.unlink(missing_ok=True)

    _register(record, accounts)
    return record


def _spec_from_record(record: dict, accounts: pd.DataFrame) -> PortfolioSpec:
    """A PortfolioSpec for a book that was ingested, not generated.

    The generator parameters are inert placeholders — an ingested book is
    never generated. The driver lists are derived from the columns actually
    present, which is what the runtime reads them for.
    """
    numeric, categorical = {}, {}
    for c in accounts.columns:
        if c == "account_id":
            continue
        if pd.api.types.is_numeric_dtype(accounts[c]):
            numeric[c] = 0.0
        else:
            categorical[c] = {}
    t = record["target"]
    return PortfolioSpec(
        key=record["key"], label=record["label"],
        n_accounts=int(record["n_accounts"]),
        accent_slot=4,      # series-4: every ingested book, distinct from the three
        target=TargetDef(column=t["column"], description=t["description"],
                         dpd_state=int(t["dpd_state"]), label=t["label"]),
        ead_method=record["ead_method"],
        ead_note="Ingested tape. Exposure fields as mapped at upload.",
        marginals=[], correlations={},
        intercept=0.0, frailty_sd=0.0, seasoning=(12.0, 0.0, 0.1),
        numeric_betas=numeric, categorical_betas=categorical,
        mev_keys=sorted(by_key(None).keys()),
        mev_betas={}, interactions=[],
        roll_forward=0.0, cure_base=0.0, prepay_intercept=0.0,
    )


def _register(record: dict, accounts: pd.DataFrame) -> None:
    key = record["key"]
    PORTFOLIOS[key] = _spec_from_record(record, accounts)
    PORTFOLIO_MEVS.setdefault(key, sorted(by_key(None).keys()))


def register_all() -> None:
    """Re-register every ingested book. Called at import by the store, so a
    restart finds the same books an upload created."""
    if not TAPES_DIR.exists():
        return
    for p in sorted(TAPES_DIR.glob("*.json")):
        try:
            record = json.loads(p.read_text())
            apath = TAPES_DIR / f"{record['key']}_accounts.parquet"
            if not apath.exists():
                continue
            _register(record, pd.read_parquet(apath))
        except Exception:                                               # noqa: BLE001
            continue          # a malformed registry entry never blocks boot


def is_ingested(key: str) -> bool:
    """Whether this book came from someone's uploaded tape rather than the
    generator. The interface labels synthetic data on every data-bearing view,
    and that label must not ride along on real loans."""
    return (TAPES_DIR / f"{key}.json").exists()


def records() -> list[dict]:
    if not TAPES_DIR.exists():
        return []
    out = []
    for p in sorted(TAPES_DIR.glob("*.json")):
        try:
            out.append(json.loads(p.read_text()))
        except Exception:                                               # noqa: BLE001
            continue
    return out


def fingerprint_for(key: str) -> str:
    p = TAPES_DIR / f"{key}.json"
    if not p.exists():
        return ""
    try:
        return json.loads(p.read_text()).get("fingerprint", "")
    except Exception:                                                   # noqa: BLE001
        return ""


def archive_all() -> int:
    """Move every ingested book out of the registry, keeping the files.

    "Start from scratch" means scratch: a tape ingested during a session is
    exactly the kind of artifact a reset exists to clear. Archived rather
    than deleted — same rule as the versions archive — and the upload the
    tape came from is still wherever the user keeps it, so nothing is lost.
    register_all() globs the top level only, so an archived book is invisible
    to the app while its files remain on disk."""
    recs = records()
    if not recs:
        return 0
    dest = TAPES_DIR / f"archive-{pd.Timestamp.utcnow().strftime('%Y-%m-%dT%H-%M-%S')}"
    dest.mkdir(parents=True, exist_ok=True)
    for r in recs:
        key = r["key"]
        for suffix in (".json", "_panel.parquet", "_accounts.parquet"):
            f = TAPES_DIR / f"{key}{suffix}"
            if f.exists():
                shutil.move(str(f), str(dest / f.name))
        PORTFOLIOS.pop(key, None)
        PORTFOLIO_MEVS.pop(key, None)
    return len(recs)


def remove(key: str) -> bool:
    """Delete an ingested book: registry, data, and its cache directory.
    Synthetic books cannot be removed this way."""
    if not (TAPES_DIR / f"{key}.json").exists():
        return False
    for suffix in (".json", "_panel.parquet", "_accounts.parquet"):
        (TAPES_DIR / f"{key}{suffix}").unlink(missing_ok=True)
    PORTFOLIOS.pop(key, None)
    PORTFOLIO_MEVS.pop(key, None)
    cache = Path(__file__).resolve().parents[3] / "data" / "cache"
    if cache.exists():
        for d in cache.glob(f"{key}-*"):
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
    return True
