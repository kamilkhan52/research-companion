from __future__ import annotations

import threading
import time

import pytest
from app import affiliation_jobs, affiliations, config, jobs, paper_metadata, store
from app.affiliations import _extract_missing as real_extract_missing

from tests.conftest import add_paper


def _wait(job_id: str, timeout: float = 3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = affiliation_jobs._registry.get(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError(job_id)


def test_retrieval_affiliation_job_caches_and_ranks_the_top_two(temp_project):
    add_paper(
        temp_project,
        "paper",
        "Paper",
        full_text="A1, B1, C2. 1 MIT. 2 Stanford University. Abstract...",
    )
    calls = []

    def complete(messages, **kwargs):
        calls.append(messages)
        return "\n".join([
            "A | MIT",
            "B | MIT",
            "C | Stanford University",
            "D | Other Lab",
        ])

    job = affiliation_jobs.start("paper", complete=complete)
    assert job is not None
    finished = _wait(job.id)

    assert finished.status == "done"
    assert affiliations.top_affiliations("paper") == ["MIT", "Other Lab"]
    record = paper_metadata.affiliation_record("paper")
    assert record["status"] == "done"
    assert len(calls) == 1

    cached = affiliation_jobs.start("paper", complete=complete)
    assert cached is not None and cached.status == "done"
    assert len(calls) == 1


def test_graph_enrichment_reuses_the_retrieval_prefetch(temp_project):
    add_paper(temp_project, "paper", "Paper", full_text="A1. 1 MIT. Abstract...")
    node = {"id": "paper", "kind": "project", "slug": "paper", "arxiv_id": None}
    key = affiliations._cache_key(node)
    paper_metadata.set_affiliation_record("paper", {
        "status": "done",
        "key": key,
        "authorships": [{"name": "A", "affiliation": "MIT"}],
        "error": None,
    })
    graph_cache = {}

    real_extract_missing(
        [node],
        {},
        graph_cache,
        complete=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("prefetched affiliation should avoid a second LLM call")
        ),
    )

    assert graph_cache["paper"]["authorships"] == [{"name": "A", "affiliation": "MIT"}]


def test_unexpected_extraction_failure_settles_metadata_instead_of_polling_forever(
    temp_project,
):
    add_paper(temp_project, "paper", "Paper", full_text="A1. 1 MIT. Abstract...")

    def exploding(*args, **kwargs):
        raise RuntimeError("parser exploded")

    job = affiliation_jobs.start("paper", complete=exploding)
    assert job is not None
    finished = _wait(job.id)

    assert finished.status == "done"
    record = paper_metadata.affiliation_record("paper")
    assert record["status"] == "error"
    assert record["error"]


def test_restart_orphaned_pending_record_is_terminalized(temp_project):
    add_paper(temp_project, "paper", "Paper", full_text="A1. 1 MIT. Abstract...")
    key = affiliations._cache_key({
        "id": "paper",
        "kind": "project",
        "slug": "paper",
        "arxiv_id": None,
    })
    paper_metadata.set_affiliation_record("paper", {
        "status": "pending",
        "key": key,
        "authorships": [],
        "error": None,
    })

    affiliation_jobs.reconcile_pending(["paper"])

    record = paper_metadata.affiliation_record("paper")
    assert record["status"] == "error"
    assert "interrupted" in record["error"]


def test_pending_write_failure_releases_registered_worker(temp_project, monkeypatch):
    """A cache write failure after admission must not leave a forever-running gated job."""
    add_paper(temp_project, "paper", "Paper", full_text="A1. 1 MIT. Abstract...")
    before = set(affiliation_jobs._jobs)
    original = paper_metadata.set_affiliation_record

    def fail_pending(slug, record, **kwargs):
        if record.get("status") == "pending":
            raise OSError("disk full")
        return original(slug, record, **kwargs)

    monkeypatch.setattr(paper_metadata, "set_affiliation_record", fail_pending)

    with pytest.raises(OSError, match="disk full"):
        affiliation_jobs.start("paper", complete=lambda *args, **kwargs: "A | MIT")

    created = list(set(affiliation_jobs._jobs) - before)
    assert len(created) == 1
    assert _wait(created[0]).status == "done"
    assert jobs.any_running_for_project(temp_project) is None


def test_new_text_pending_cannot_be_overtaken_by_older_start(temp_project, monkeypatch):
    """Corpus replacement and fingerprint publication are ordered by one paper identity lock."""
    add_paper(temp_project, "paper", "Paper", full_text="Old header. Abstract...")
    node = {"id": "paper", "kind": "project", "slug": "paper", "arxiv_id": None}
    old_key = affiliations._cache_key(node)
    pending_a_reached = threading.Event()
    release_pending_a = threading.Event()
    release_old_llm = threading.Event()
    replacement_finished = threading.Event()
    original_save = paper_metadata.set_affiliation_record
    results = {}

    def pause_old_pending(slug, record, **kwargs):
        if record.get("status") == "pending" and record.get("key") == old_key:
            pending_a_reached.set()
            assert release_pending_a.wait(2)
        return original_save(slug, record, **kwargs)

    def old_complete(*args, **kwargs):
        assert release_old_llm.wait(2)
        return "Old Author | Old University"

    def start_old():
        token = config.set_active_project(temp_project)
        try:
            results["old_job"] = affiliation_jobs.start("paper", complete=old_complete)
        finally:
            config.reset_active_project(token)

    def replace_text():
        token = config.set_active_project(temp_project)
        try:
            store.write_full_text(
                "paper",
                "Paper",
                "New header. Abstract...",
                {"slug": "paper"},
            )
            replacement_finished.set()
        finally:
            config.reset_active_project(token)

    monkeypatch.setattr(paper_metadata, "set_affiliation_record", pause_old_pending)
    old_thread = threading.Thread(target=start_old)
    old_thread.start()
    assert pending_a_reached.wait(2)

    replacement_thread = threading.Thread(target=replace_text)
    replacement_thread.start()
    time.sleep(0.05)
    assert not replacement_finished.is_set()
    assert store.read_full_text("paper") == "Old header. Abstract..."

    release_pending_a.set()
    old_thread.join(2)
    replacement_thread.join(2)
    assert replacement_finished.is_set()

    new_key = affiliations._cache_key(node)
    assert new_key != old_key
    new_job = affiliation_jobs.start(
        "paper",
        complete=lambda *args, **kwargs: "New Author | New University",
    )
    assert new_job is not None
    assert _wait(new_job.id).status == "done"

    release_old_llm.set()
    old_job = results["old_job"]
    assert old_job is not None
    assert _wait(old_job.id).status == "done"
    record = paper_metadata.affiliation_record("paper")
    assert record["key"] == new_key
    assert record["authorships"] == [
        {"name": "New Author", "affiliation": "New University"},
    ]
