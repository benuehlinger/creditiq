"""The in-process store: what is cached, and what invalidates it.

Everything here is about the panels being STATIC for the life of the process.
That is what makes caching safe, and it is also what makes a cache that outlives
a rebuild dangerous.
"""

from __future__ import annotations


def test_a_derived_cache_is_dropped_with_the_panels():
    """A cache built FROM a panel must not outlive it.

    The panel profile is cached because it is static for the life of the process
    and costs 7.4 seconds on the mortgage book. That makes it stale the moment
    the panels are dropped — after a rebuild, say — so `clear()` has to reach it.
    Registering the clear function keeps `store.clear()` the one place that has
    to be right.
    """
    from creditiq import store
    from creditiq.api import main as api_main

    api_main._health("cre")
    assert api_main._health.cache_info().currsize > 0
    store.clear()
    assert api_main._health.cache_info().currsize == 0, (
        "the profile cache survived a store clear and would serve a stale panel")


def test_low_cardinality_strings_are_stored_as_categories():
    """The dtype change that made the larger panels affordable.

    A low-cardinality string costs about 55 bytes per row as Python objects and
    about one as a categorical code. Nine such columns held 1,036 MB of the
    mortgage frame's 1,445 MB.
    """
    import pandas as pd

    from creditiq import store

    df = store.analysis_frame("mortgage")
    strings = [c for c in df.columns if df[c].dtype == object]
    assert not [c for c in strings if not c.endswith("_id") and c != "account_id"], (
        f"low-cardinality strings left as objects: {strings}")
    # Categories must still behave as their values did.
    cats = [c for c in df.columns if isinstance(df[c].dtype, pd.CategoricalDtype)]
    assert cats, "nothing was converted"
    for c in cats[:3]:
        assert df[c].nunique() == df[c].astype(str).nunique()
