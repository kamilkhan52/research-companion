from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app import discovery_checkpoint


class _Paper:
    def __init__(self, slug: str, title: str, arxiv_id: str = "", doi: str = ""):
        self.slug, self.title, self.arxiv_id, self.doi = slug, title, arxiv_id, doi


def test_checkpoint_round_trips_only_for_the_same_goals_and_library(temp_project):
    papers = [_Paper("one", "One", "2401.00001")]
    key = discovery_checkpoint.fingerprint("memory systems", papers, pipeline="v2")
    discovery_checkpoint.save(key, "recall", {
        "focus": "memory", "queries": [], "candidates": [{"title": "A"}],
        "ledger": {}, "recall_audit": {}, "frontier_updates": [],
    })

    loaded = discovery_checkpoint.load(key)
    assert loaded is not None
    assert loaded["stage"] == "recall"
    assert loaded["state"]["candidates"][0]["title"] == "A"

    changed = discovery_checkpoint.fingerprint(
        "memory systems", [_Paper("two", "Two", "2401.00002")], pipeline="v2")
    assert discovery_checkpoint.load(changed) is None


def test_pipeline_version_invalidates_a_snapshot(temp_project):
    papers = [_Paper("one", "One")]
    old = discovery_checkpoint.fingerprint("g", papers, pipeline="v1")
    new = discovery_checkpoint.fingerprint("g", papers, pipeline="v2")
    discovery_checkpoint.save(old, "gated", {"survivors": []})
    assert discovery_checkpoint.load(new) is None


def test_expired_checkpoint_is_not_resumed(temp_project):
    key = discovery_checkpoint.fingerprint("g", [], pipeline="v2")
    then = datetime(2026, 7, 1, tzinfo=UTC)
    discovery_checkpoint.save(key, "recall", {"candidates": []}, now=then)
    assert discovery_checkpoint.load(key, now=then + discovery_checkpoint.MAX_AGE
                                     + timedelta(seconds=1)) is None


def test_syntactically_valid_but_wrongly_typed_stage_state_is_a_cache_miss(temp_project):
    key = discovery_checkpoint.fingerprint("g", [], pipeline="v2")
    discovery_checkpoint.save(key, "recall", {
        "focus": "g", "queries": [], "candidates": "not-a-list", "ledger": {},
        "recall_audit": {}, "frontier_updates": [],
    })
    assert discovery_checkpoint.load(key) is None


def test_clear_is_idempotent(temp_project):
    key = discovery_checkpoint.fingerprint("g", [], pipeline="v2")
    discovery_checkpoint.save(key, "scored", {"scored": []})
    discovery_checkpoint.clear()
    discovery_checkpoint.clear()
    assert discovery_checkpoint.load(key) is None
