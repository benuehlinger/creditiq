"""A version must know when the data underneath it has moved.

The fingerprint hashed the row count, the account count, the default count, the
window and the seed. None of those move when the VALUES in a column change.
Rebalancing the three books moved the mean commercial loan from $11.3M to $0.4M
without moving any of them, so every saved version still reported itself as
current while its stored loss figures described a portfolio 28 times larger.
"""
import json

import pandas as pd
import pytest

from creditiq.data.build import _content_digest
from creditiq.models import versions as V


def _panel(scale: float = 1.0) -> pd.DataFrame:
    return pd.DataFrame({
        "account_id": ["a", "b", "c", "d"],
        "current_balance": [x * scale for x in (100.0, 250.0, 900.0, 40.0)],
        "default_flag": [0, 0, 1, 0],
        "property_type": ["office", "retail", "office", "industrial"],
    })


def test_a_rescaling_of_the_money_changes_the_digest() -> None:
    """The exact change that used to be invisible: same rows, same accounts,
    same defaults, different amounts."""
    a, b = _panel(), _panel(scale=1 / 28)
    assert len(a) == len(b)
    assert a["default_flag"].sum() == b["default_flag"].sum()
    assert _content_digest(a) != _content_digest(b)


def test_the_digest_is_stable_for_identical_data() -> None:
    assert _content_digest(_panel()) == _content_digest(_panel())


def test_the_digest_ignores_column_order() -> None:
    p = _panel()
    assert _content_digest(p) == _content_digest(p[list(reversed(p.columns))])


def test_the_fingerprint_reads_the_content_digest() -> None:
    """The build report carries it, and the fingerprint consumes it."""
    rep = json.loads(V.BUILD_REPORT.read_text())
    for portfolio in ("consumer", "mortgage", "cre"):
        assert rep[portfolio].get("content"), f"{portfolio} has no content digest"
        assert V.data_fingerprint(portfolio)
