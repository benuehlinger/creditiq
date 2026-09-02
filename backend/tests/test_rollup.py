

def test_saving_a_version_invalidates_the_roll_up_picker():
    """The roll-up carries the list of AVAILABLE versions for its model picker.

    That list goes stale the moment a version is saved, deleted or promoted, and
    the roll-up is memoised because projecting three books is expensive — so the
    picker offered a set of models that no longer matched the versions page.
    """
    from creditiq.models import rollup as R
    from creditiq.models import versions as V

    before = R.run()
    n_before = len(before.available.get("cre", []))
    assert R.run() is before, "the roll-up should be memoised"

    R.clear_cache()
    after = R.run()
    assert after is not before, "clear_cache must drop the memo"
    assert len(after.available.get("cre", [])) == len(V.list_all("cre"))


def test_every_version_mutation_clears_the_cache():
    """A new endpoint that mutates a version must not be able to forget."""
    import inspect

    from creditiq.api import main as api_main

    for fn in (api_main.save_version, api_main.promote_version,
               api_main.delete_version):
        src = inspect.getsource(fn)
        assert "clear_cache()" in src, (
            f"{fn.__name__} mutates a version without dropping the roll-up cache")
