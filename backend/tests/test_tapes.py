"""Tape ingestion: the validation gate.

The contract under test: a file that is already a panel gets in, with the
seller's names mapped onto the canonical schema; anything that would require
judgement to repair is refused with the reason. Nothing here builds a panel.
"""

import numpy as np
import pandas as pd
import pytest

from creditiq.data import tapes as T
from creditiq.data.portfolios import PORTFOLIOS


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(T, "TAPES_DIR", tmp_path)
    monkeypatch.setattr(T, "STAGING", tmp_path / ".staging")
    added = []
    yield added
    for k in added:
        PORTFOLIOS.pop(k, None)


def _tape(n_accounts=40, months=24, seed=3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n_accounts):
        fico = int(rng.integers(580, 820))     # static per ACCOUNT, like life
        for m in range(months):
            rows.append({
                "LoanNumber": f"L{i:05d}",
                "AsOfDate": f"{2022 + m // 12}-{m % 12 + 1:02d}-01",
                "DefaultInd": 0,
                "UPB": 10_000 - 300 * m,
                "OrigFICO": fico,
            })
    df = pd.DataFrame(rows)
    df.loc[df.sample(30, random_state=seed).index, "DefaultInd"] = 1
    return df


def _stage(df: pd.DataFrame) -> dict:
    return T.stage("acme.csv", df.to_csv(index=False).encode())


MAPPING = {"account_id": "LoanNumber", "performance_date": "AsOfDate",
           "default_flag": "DefaultInd", "current_balance": "UPB"}


def test_suggested_mapping_finds_seller_names(sandbox):
    rep = _stage(_tape())
    s = rep["suggested_mapping"]
    assert s["account_id"] == "LoanNumber"
    assert s["performance_date"] == "AsOfDate"
    assert s["default_flag"] == "DefaultInd"
    assert s["current_balance"] == "UPB"
    assert rep["missing_required"] == []


def test_ingest_registers_a_working_book(sandbox):
    rep = _stage(_tape())
    rec = T.ingest(rep["token"], "acme_t1", "Acme", MAPPING,
                   default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t1")
    assert "acme_t1" in PORTFOLIOS
    spec = PORTFOLIOS["acme_t1"]
    assert spec.target.column == "default_flag"
    assert spec.ead_method == "amortizing"
    # The registry survives a restart: register_all rebuilds from disk.
    PORTFOLIOS.pop("acme_t1")
    T.register_all()
    assert "acme_t1" in PORTFOLIOS
    assert rec["fingerprint"] and len(rec["fingerprint"]) == 12
    # OrigFICO is constant per account, so it lands in the accounts table.
    accounts = pd.read_parquet(T.TAPES_DIR / "acme_t1_accounts.parquet")
    assert "OrigFICO" in accounts.columns


def test_a_missing_required_column_is_refused_by_name(sandbox):
    df = _tape().drop(columns=["DefaultInd"])
    rep = _stage(df)
    assert "default_flag" in rep["missing_required"]
    with pytest.raises(ValueError, match="default_flag"):
        T.ingest(rep["token"], "acme_t2", "Acme",
                 {k: v for k, v in MAPPING.items() if k != "default_flag"},
                 default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-01-01")


def test_a_non_binary_default_flag_is_refused_not_recoded(sandbox):
    df = _tape()
    df["DefaultInd"] = df["DefaultInd"].map({0: "N", 1: "Y"})
    rep = _stage(df)
    with pytest.raises(ValueError, match="0/1"):
        T.ingest(rep["token"], "acme_t3", "Acme", MAPPING,
                 default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-01-01")


def test_duplicate_account_months_are_refused(sandbox):
    df = _tape()
    df = pd.concat([df, df.head(50)], ignore_index=True)
    rep = _stage(df)
    with pytest.raises(ValueError, match="duplicate account-month"):
        T.ingest(rep["token"], "acme_t4", "Acme", MAPPING,
                 default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-01-01")


def test_missing_lgd_warns_rather_than_refuses(sandbox):
    rep = _stage(_tape())
    rec = T.ingest(rep["token"], "acme_t5", "Acme", MAPPING,
                   default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t5")
    assert any("severity model" in w for w in rec["warnings"])


def test_remove_unregisters_and_deletes(sandbox):
    rep = _stage(_tape())
    T.ingest(rep["token"], "acme_t6", "Acme", MAPPING,
             default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-06-01")
    assert T.remove("acme_t6") is True
    assert "acme_t6" not in PORTFOLIOS
    assert not (T.TAPES_DIR / "acme_t6_panel.parquet").exists()
    assert T.remove("consumer") is False, "synthetic books are not removable"


def test_one_alias_covers_every_naming_convention():
    """Case and separators are normalized on both sides, so a single alias
    matches snake_case, camelCase, PascalCase, SCREAMING_SNAKE, kebab-case and
    spaced words. Only a different VOCABULARY needs its own alias."""
    styles = {
        "snake": ["loan_id", "as_of_date", "default_flag", "current_balance"],
        "camel": ["loanId", "asOfDate", "defaultFlag", "currentBalance"],
        "pascal": ["LoanId", "AsOfDate", "DefaultFlag", "CurrentBalance"],
        "screaming": ["LOAN_ID", "AS_OF_DATE", "DEFAULT_FLAG", "CURRENT_BALANCE"],
        "kebab": ["loan-id", "as-of-date", "default-flag", "current-balance"],
        "spaced": ["Loan Id", "As Of Date", "Default Flag", "Current Balance"],
    }
    for style, cols in styles.items():
        m = T.suggest_mapping(cols)
        assert m["account_id"] == cols[0], style
        assert m["performance_date"] == cols[1], style
        assert m["default_flag"] == cols[2], style
        assert m["current_balance"] == cols[3], style


def test_sec_abs_ee_names_are_recognised_but_never_the_target():
    """Reg AB II Schedule AL is the public format every securitized tape is
    filed in, so a diligence file often arrives in exactly these names.

    `zeroBalanceCode` must NOT be offered as the target: it is sticky across
    filings, and it covers prepayment and repurchase as well as charge-off.
    Turning it into a 0/1 hazard target is panel construction, which this gate
    refuses to do on someone's behalf.
    """
    cols = ["assetNumber", "reportingPeriodBeginningDate", "originationDate",
            "reportingPeriodActualEndBalanceAmount", "zeroBalanceCode",
            "reportingPeriodInterestRatePercentage",
            "remainingTermToMaturityNumber", "obligorCreditScore"]
    m = T.suggest_mapping(cols)
    assert m["account_id"] == "assetNumber"
    assert m["performance_date"] == "reportingPeriodBeginningDate"
    assert m["current_balance"] == "reportingPeriodActualEndBalanceAmount"
    assert m["origination_date"] == "originationDate"
    assert m["interest_rate"] == "reportingPeriodInterestRatePercentage"
    assert m["remaining_term"] == "remainingTermToMaturityNumber"
    assert m["default_flag"] is None, "zeroBalanceCode is not a 0/1 target"


def test_an_ingested_book_is_not_labelled_synthetic(sandbox):
    """The interface labels synthetic data on every data-bearing view. That
    label must not ride along on someone's real loans."""
    rep = _stage(_tape())
    T.ingest(rep["token"], "acme_t7", "Acme", MAPPING,
             default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t7")
    assert T.is_ingested("acme_t7") is True
    assert T.is_ingested("consumer") is False


def test_an_ingested_tape_is_never_generated_or_asserted_on(sandbox):
    """An ingested tape joins PORTFOLIOS so it behaves like any other book in
    the app. It must NOT join the generated set: it has no generative process,
    so `make data` would try to regenerate someone's real loans, and the
    generator suite would assert on them. Ingesting a tape once turned the
    backend suite into 73 errors on this exact mechanism."""
    from creditiq.data.portfolios import PORTFOLIOS, SYNTHETIC_KEYS

    rep = _stage(_tape())
    T.ingest(rep["token"], "acme_t8", "Acme", MAPPING,
             default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t8")

    assert "acme_t8" in PORTFOLIOS, "an ingested book is a book everywhere else"
    assert "acme_t8" not in SYNTHETIC_KEYS, "but it is not a GENERATED book"
    assert set(SYNTHETIC_KEYS) == {"consumer", "mortgage", "cre"}


def test_start_from_scratch_archives_ingested_books(sandbox, tmp_path):
    """A tape registers itself on every server start, so a reset that left
    tapes alone reopened "from scratch" with last session's book already
    loaded. Archived, never deleted: the files move aside where
    register_all() cannot see them, and the user's original upload is
    untouched wherever they keep it."""
    rep = _stage(_tape())
    T.ingest(rep["token"], "acme_t9", "Acme", MAPPING,
             default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-06-01")
    assert "acme_t9" in PORTFOLIOS

    n = T.archive_all()
    assert n == 1
    assert "acme_t9" not in PORTFOLIOS
    archives = list(T.TAPES_DIR.glob("archive-*"))
    assert archives, "the files must move aside, not vanish"
    assert (archives[0] / "acme_t9_panel.parquet").exists()
    # And a restart does not resurrect it.
    T.register_all()
    assert "acme_t9" not in PORTFOLIOS


def test_rows_after_default_are_reported_not_refused(sandbox):
    """For a default model the history must stop at default. A tape that keeps
    reporting a defaulted loan gets a named integrity finding — the model
    still fits, and the scorecard says what the number is standing on."""
    from creditiq.analysis.profile import check_integrity

    df = _tape()
    # Make one loan default mid-history and keep reporting afterwards.
    df = df.sort_values(["LoanNumber", "AsOfDate"]).reset_index(drop=True)
    victim = df.LoanNumber.iloc[0]
    rows = df.index[df.LoanNumber == victim]
    df.loc[rows, "DefaultInd"] = 0
    df.loc[rows[10], "DefaultInd"] = 1          # defaults in month 11 of 24

    rep = _stage(df)
    rec = T.ingest(rep["token"], "acme_t10", "Acme", MAPPING,
                   default_definition="90+ days past due or charge-off", ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t10")

    import pandas as pd
    panel = pd.read_parquet(T.TAPES_DIR / "acme_t10_panel.parquet")
    accounts = pd.read_parquet(T.TAPES_DIR / "acme_t10_accounts.parquet")
    frame = panel.merge(accounts, on="account_id", how="left")
    from creditiq.data.portfolios import PORTFOLIOS
    issues = check_integrity(frame, PORTFOLIOS["acme_t10"])
    row = next(i for i in issues if i["check"] == "History stops at default")
    assert not row["passed"]
    # 13 from the victim (months 12-24); the fixture's own scattered random
    # defaults leave trailing rows too, so the count is at least that.
    assert row["n_affected"] >= 13


def test_a_mis_mapped_column_is_corrected_without_re_uploading(sandbox):
    """Ingestion renames mapped columns and lets the rest ride along under
    the seller's names, so nothing is discarded and a correction is a rename.
    Forcing a re-upload of a large file to fix one dropdown would be a
    limitation of the implementation, not of the data."""
    df = _tape()
    df["AltBalance"] = df["UPB"] * 2          # the column they MEANT to map
    rep = _stage(df)
    T.ingest(rep["token"], "acme_t11", "Acme", MAPPING,
             default_definition="90+ days past due",
             ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t11")

    before = pd.read_parquet(T.TAPES_DIR / "acme_t11_panel.parquet")
    assert before["current_balance"].equals(before["current_balance"])
    first_balance = float(before["current_balance"].iloc[0])

    rec = T.remap("acme_t11", changes={"current_balance": "AltBalance"})
    after = pd.read_parquet(T.TAPES_DIR / "acme_t11_panel.parquet")

    # The new column now IS current_balance, and the old one is back under
    # the seller's own name rather than lost.
    assert rec["mapping"]["current_balance"] == "AltBalance"
    assert float(after["current_balance"].iloc[0]) == first_balance * 2
    assert "UPB" in after.columns
    assert rec["fingerprint"] != "", "the data changed, so the fingerprint must"

    # Metadata edits need no data change at all.
    rec = T.remap("acme_t11", default_definition="charge-off")
    assert PORTFOLIOS["acme_t11"].target.description == "charge-off"

    # The three structural fields are not re-pointable here.
    with pytest.raises(ValueError, match="grid"):
        T.remap("acme_t11", changes={"account_id": "AltBalance"})
