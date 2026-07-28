"""R7.7 — the lab research pass: parse contract, cached-skip behavior, per-author persist,
error isolation, and the lab-centric grouping. The web agent is injected; no network."""
from __future__ import annotations

import time

import pytest
from app import graph_store, lab_research

from tests.conftest import add_paper


@pytest.fixture(autouse=True)
def _clear_jobs():
    lab_research._jobs.clear()
    yield
    lab_research._jobs.clear()


def _seed(temp_project, authors=("Song Han", "Ji Lin")):
    add_paper(temp_project, "awq", "AWQ")
    data = graph_store.load()
    data["graph"] = {"nodes": [
        {"id": "awq", "kind": "project", "slug": "awq", "title": "AWQ",
         "authors": list(authors), "significant_cited_by_count": 2, "year": 2023},
    ], "edges": []}
    graph_store.save(data)


def _settled(job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = lab_research.snapshot(job_id)
        if snap and snap["status"] != "running":
            return snap
        time.sleep(0.02)
    raise TimeoutError(job_id)


def test_parse_result_takes_last_line_and_requires_lab_name():
    out = 'thinking...\nRESULT: {"found": false}\nmore\nRESULT: {"found": true, "lab_name": "HAN Lab", "institution": "MIT", "url": "https://hanlab.mit.edu", "focus": "efficient ML"}'
    parsed = lab_research.parse_result(out)
    assert parsed["found"] is True and parsed["lab_name"] == "HAN Lab"
    assert lab_research.parse_result('RESULT: {"found": true, "lab_name": ""}') == {"found": False}
    assert lab_research.parse_result("no marker at all") == {"found": False}
    assert lab_research.parse_result('RESULT: {broken json') == {"found": False}


def test_research_caches_per_author_and_groups_labs(temp_project):
    _seed(temp_project)
    calls: list[str] = []

    def fake_research(name, affiliation, titles):
        calls.append(name)
        assert titles == ["AWQ"]
        return {"found": True, "lab_name": "HAN Lab", "institution": "MIT",
                "url": "https://hanlab.mit.edu", "focus": "efficient ML", "evidence": "people page"}

    snap = _settled(lab_research.start_research(research_fn=fake_research).id)
    assert snap["status"] == "done" and snap["found"] == 2
    assert sorted(calls) == ["Ji Lin", "Song Han"]

    # Second pass: fingerprints match, nothing re-spent.
    snap2 = _settled(lab_research.start_research(research_fn=fake_research).id)
    assert snap2["skipped_cached"] == 2 and len(calls) == 2

    board = lab_research._board()
    labs = lab_research.labs_board(board)
    assert labs["researched"] is True
    [lab] = labs["labs"]
    assert lab["lab_name"] == "HAN Lab"
    assert sorted(lab["members"]) == ["Ji Lin", "Song Han"]
    assert lab["in_project_count"] == 2  # one paper each in this fixture's board
    assert labs["covered_authors"] == ["Ji Lin", "Song Han"]


def test_one_authors_failure_is_isolated_and_retried_next_run(temp_project):
    _seed(temp_project)
    attempts: list[str] = []

    def flaky(name, affiliation, titles):
        attempts.append(name)
        if name == "Song Han" and attempts.count("Song Han") == 1:
            raise RuntimeError("network sad")
        return {"found": False}

    snap = _settled(lab_research.start_research(research_fn=flaky).id)
    assert snap["status"] == "done" and snap["done"] == 2  # the pass finished despite the error

    # The errored author has no fingerprint, so the next run retries ONLY them.
    snap2 = _settled(lab_research.start_research(research_fn=flaky).id)
    assert snap2["status"] == "done"
    assert attempts.count("Song Han") == 2 and attempts.count("Ji Lin") == 1


def test_no_board_raises(temp_project):
    with pytest.raises(ValueError):
        lab_research.start_research(research_fn=lambda *a: {"found": False})


def test_total_failure_errors_the_job_and_does_not_claim_researched(temp_project):
    """When every attempted author fails (no API key, provider down), the pass must surface
    as a job error — not settle 'done' and let the client read 'researched, no labs'."""
    _seed(temp_project)

    def broken(name, affiliation, titles):
        raise RuntimeError("no API key")

    snap = _settled(lab_research.start_research(research_fn=broken).id)
    assert snap["status"] == "error" and "every author" in snap["error"]
    assert lab_research.labs_board(lab_research._board())["researched"] is False


def test_agent_provider_error_excludes_upstream_message(temp_project, monkeypatch):
    import pydantic_ai
    from app import agent_harness, graph

    secret = "PRIVATE_PROMPT_ECHO_lab"

    class FailedAgent:
        def __init__(self, *args, **kwargs):
            pass

        async def run(self, *args, **kwargs):
            raise RuntimeError(secret)

    monkeypatch.setattr(pydantic_ai, "Agent", FailedAgent)
    monkeypatch.setattr(agent_harness, "_openrouter_model", lambda model=None: object())
    monkeypatch.setattr(graph, "resolve_model", lambda: "test/model")

    with pytest.raises(RuntimeError) as err:
        lab_research._research_with_agent("Researcher", "University", ["Paper"])
    assert "model provider" in str(err.value)
    assert secret not in str(err.value)
