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
                   dpd_state=4, ead_method="amortizing", oot_from="2023-06-01")
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
                 dpd_state=4, ead_method="amortizing", oot_from="2023-01-01")


def test_a_non_binary_default_flag_is_refused_not_recoded(sandbox):
    df = _tape()
    df["DefaultInd"] = df["DefaultInd"].map({0: "N", 1: "Y"})
    rep = _stage(df)
    with pytest.raises(ValueError, match="0/1"):
        T.ingest(rep["token"], "acme_t3", "Acme", MAPPING,
                 dpd_state=4, ead_method="amortizing", oot_from="2023-01-01")


def test_duplicate_account_months_are_refused(sandbox):
    df = _tape()
    df = pd.concat([df, df.head(50)], ignore_index=True)
    rep = _stage(df)
    with pytest.raises(ValueError, match="duplicate account-month"):
        T.ingest(rep["token"], "acme_t4", "Acme", MAPPING,
                 dpd_state=4, ead_method="amortizing", oot_from="2023-01-01")


def test_missing_lgd_warns_rather_than_refuses(sandbox):
    rep = _stage(_tape())
    rec = T.ingest(rep["token"], "acme_t5", "Acme", MAPPING,
                   dpd_state=4, ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t5")
    assert any("severity model" in w for w in rec["warnings"])


def test_remove_unregisters_and_deletes(sandbox):
    rep = _stage(_tape())
    T.ingest(rep["token"], "acme_t6", "Acme", MAPPING,
             dpd_state=4, ead_method="amortizing", oot_from="2023-06-01")
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
             dpd_state=4, ead_method="amortizing", oot_from="2023-06-01")
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
             dpd_state=4, ead_method="amortizing", oot_from="2023-06-01")
    sandbox.append("acme_t8")

    assert "acme_t8" in PORTFOLIOS, "an ingested book is a book everywhere else"
    assert "acme_t8" not in SYNTHETIC_KEYS, "but it is not a GENERATED book"
    assert set(SYNTHETIC_KEYS) == {"consumer", "mortgage", "cre"}
