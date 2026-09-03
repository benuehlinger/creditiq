"""A panel rebuilt UNDER a running server must invalidate every derived cache.

The failure this guards against read, in use, as "sometimes an old LGD fit
appears at random": `make data` in a second terminal (or the in-app generate
button) replaced the panels, and every in-process cache — fitted runs,
severity models, projections, screenings — kept answering from the dataset
that no longer existed until someone restarted the server by hand.

The store now stamps the build report's mtime and checks it on every public
read; a change drops the store's own caches and every registered dependent.
"""
import os

from creditiq import store


def test_rebuild_under_server_clears_dependents():
    fired = {"n": 0}
    store.register_dependent_cache(lambda: fired.__setitem__("n", fired["n"] + 1))

    store.load("consumer")            # fill the cache and take the stamp
    baseline = fired["n"]

    store.load("consumer")            # unchanged data: nothing clears
    assert fired["n"] == baseline

    st = store._BUILD_REPORT.stat()
    os.utime(store._BUILD_REPORT, (st.st_atime, st.st_mtime + 1))
    store.load("consumer")            # the rebuild is noticed on the next read
    assert fired["n"] == baseline + 1

    store.load("consumer")            # and only once per rebuild
    assert fired["n"] == baseline + 1


def test_model_service_caches_are_registered():
    """The caches that actually held the stale fits must be on the dependent
    list — a sentinel nobody subscribes to guards nothing."""
    from creditiq.models import rollup, scenario_service, service  # noqa: F401
    names = {str(getattr(fn, "__module__", "") or "") for fn in store._DEPENDENT}
    assert any("service" in n for n in names)
    assert any("scenario_service" in n for n in names)
