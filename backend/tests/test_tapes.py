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
