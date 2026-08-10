"""R7.6 — one-paragraph LLM author profiles: background job, per-author cache with an input
fingerprint, and the board read-time merge. LLM injected; no network."""
from __future__ import annotations

import time

import pytest
from app import author_profiles, graph_store

from tests.conftest import add_paper


@pytest.fixture(autouse=True)
def _clear_jobs():
    author_profiles._jobs.clear()
    yield
    author_profiles._jobs.clear()


def _seed_graph(temp_project):
    add_paper(temp_project, "awq", "AWQ: Activation-aware Weight Quantization")
    data = graph_store.load()
    data["graph"] = {"nodes": [
        {"id": "awq", "kind": "project", "slug": "awq", "title": "AWQ",
         "authors": ["Song Han"], "significant_cited_by_count": 1, "year": 2023},
        {"id": "ext:st", "kind": "external", "slug": None, "title": "StreamingLLM",
         "authors": ["Song Han"], "year": 2023, "arxiv_id": "2309.17453"},
    ], "edges": []}
    graph_store.save(data)


def _settled(job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = author_profiles.snapshot(job_id)
        if snap and snap["status"] != "running":
            return snap
        time.sleep(0.02)
    raise TimeoutError(job_id)


def test_profile_job_generates_caches_and_merges(temp_project, monkeypatch):
    _seed_graph(temp_project)
    calls: list[str] = []
    kwargs_seen: list[dict] = []

    def fake_complete(messages, **kwargs):
        calls.append(messages[1]["content"])
        kwargs_seen.append(kwargs)
        return "Song Han leads efficient-ML research central to this project."

    monkeypatch.setattr(author_profiles.llm, "complete", fake_complete)

    snap = _settled(author_profiles.start_profile("Song Han").id)
    assert snap["status"] == "done"
    assert "efficient-ML" in snap["profile"]
    # DR-047: a profile is a rewrite of supplied context — hidden reasoning must be off, or a
    # reasoning model can spend the whole 600-token budget thinking and emit nothing.
    assert kwargs_seen[0]["reasoning"] == {"enabled": False}
    # And the staged-progress marker reached the snapshot: the model call is the last stage.
    assert snap["stage"] == "writing"
    # Generous context: the project brief and both paper groups reached the model.
    assert "AWQ" in calls[0] and "StreamingLLM" in calls[0]

    # Cached: a second start serves the stored paragraph with no second LLM call.
    snap2 = _settled(author_profiles.start_profile("Song Han").id)
    assert snap2["cached"] is True and len(calls) == 1

    entry = author_profiles._board_entry("Song Han")
    assert author_profiles.profiles_for_board([entry]) == {
        "song han": "Song Han leads efficient-ML research central to this project."
    }


def test_changed_inputs_regenerate(temp_project, monkeypatch):
    _seed_graph(temp_project)
    monkeypatch.setattr(author_profiles.llm, "complete", lambda m, **k: "v1")
    _settled(author_profiles.start_profile("Song Han").id)

    # A new paper by the author changes the fingerprint -> regeneration, not the cache.
    data = graph_store.load()
    data["graph"]["nodes"].append(
        {"id": "sq", "kind": "project", "slug": "sq", "title": "SmoothQuant",
         "authors": ["Song Han"], "significant_cited_by_count": 0, "year": 2022})
    graph_store.save(data)
    add_paper(temp_project, "sq", "SmoothQuant")
    monkeypatch.setattr(author_profiles.llm, "complete", lambda m, **k: "v2")

    snap = _settled(author_profiles.start_profile("Song Han").id)
    assert snap["cached"] is False and snap["profile"] == "v2"


def test_unknown_author_raises(temp_project):
    _seed_graph(temp_project)
    with pytest.raises(ValueError):
        author_profiles.start_profile("Nobody Here")


def test_stale_profile_is_withheld_from_the_board_merge(temp_project, monkeypatch):
    """A cached paragraph whose inputs changed must NOT reach the board — the client then
    shows Generate again instead of stale project-specific claims."""
    _seed_graph(temp_project)
    monkeypatch.setattr(author_profiles.llm, "complete", lambda m, **k: "old take")
    _settled(author_profiles.start_profile("Song Han").id)

    data = graph_store.load()
    data["graph"]["nodes"].append(
        {"id": "sq", "kind": "project", "slug": "sq", "title": "SmoothQuant",
         "authors": ["Song Han"], "significant_cited_by_count": 0, "year": 2022})
    graph_store.save(data)
    add_paper(temp_project, "sq", "SmoothQuant")

    entry = author_profiles._board_entry("Song Han")
    assert author_profiles.profiles_for_board([entry]) == {}
