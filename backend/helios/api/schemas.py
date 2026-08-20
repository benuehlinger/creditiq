"""Response shapes. Kept thin — pandas does the work, these just name the fields."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


class PortfolioInfo(BaseModel):
    key: str
    label: str
    accent_slot: int
    n_accounts: int
    n_rows: int
    n_defaults: int
    annual_default_rate_pct: float
    window: list[str]
    target: dict[str, Any]
    ead_method: str
    ead_note: str
    mev_keys: list[str]
    drivers: list[str]
    categorical_drivers: list[str]
    expected_signs: dict[str, int]


class ColumnProfile(BaseModel):
    name: str
    dtype: str
    role: Literal["identifier", "date", "target", "driver", "outcome", "other"]
    missing_pct: float
    n_unique: int
    is_constant: bool
    # numeric only
    mean: float | None = None
    std: float | None = None
    p01: float | None = None
    p25: float | None = None
    p50: float | None = None
    p75: float | None = None
    p99: float | None = None
    min: float | None = None
    max: float | None = None
    n_outliers: int | None = None
    # categorical only
    top_levels: list[dict[str, Any]] | None = None
    note: str | None = None


class IntegrityIssue(BaseModel):
    check: str
    severity: Literal["critical", "serious", "warning", "good"]
    passed: bool
    detail: str
    n_affected: int = 0


class DataHealth(BaseModel):
    portfolio: str
    n_rows: int
    n_accounts: int
    n_columns: int
    score: float
    issues: list[IntegrityIssue]
    columns: list[ColumnProfile]


class MevInfo(BaseModel):
    key: str
    label: str
    series_id: str
    native: str
    kind: str
    measure: str
    agg: str
    unit: str
    group: str
    rebase: bool
    note: str | None
    substituted: bool
    first: str | None
    last: str | None
