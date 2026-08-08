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
    monkeypatch.setattr(agent_harness, "_openrouter_model", lambda model=None, operation="analysis": object())
    monkeypatch.setattr(graph, "resolve_model", lambda: "test/model")

    with pytest.raises(RuntimeError) as err:
        lab_research._research_with_agent("Researcher", "University", ["Paper"])
    assert "model provider" in str(err.value)
    assert secret not in str(err.value)


def test_each_author_takes_its_own_hold(temp_project, monkeypatch):
    """One agentic web pass per author, so one hold per author.

    A single `lab_research` hold covering the whole pass under-reserved by the author count: a
    reader admitted with roughly one author's worth of headroom went on to run ten. The job's
    ticket is now nominal and the gate sits where the money is, exactly as a graph build is gated
    paper by paper rather than corpus-wide.
    """
    from app import spend_ceiling

    _seed(temp_project)
    holds: list[str] = []
    monkeypatch.setattr(spend_ceiling, "hold",
                        lambda operation, job_id, **kw: holds.append(operation))
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    snap = _settled(lab_research.start_research(
        research_fn=lambda n, a, t: {"found": False}).id)

    assert snap["status"] == "done"
    # One admission ticket for the job, then one per author. Before the split there was only the
    # ticket, covering however many passes the loop happened to run.
    assert holds == ["lab_research"] * 3, f"expected a ticket plus one hold per author, got {holds}"


def test_running_out_of_budget_stops_the_pass_instead_of_failing_every_author(
    temp_project, monkeypatch,
):
    """Out of budget is not the same as broken.

    Grinding on to refuse each remaining author would cache a not-found for every one of them and
    burn the ledger round trips to do it. Stopping leaves the unreached authors without a
    fingerprint, so they retry once the period rolls over.
    """
    from app import graph, quotas, spend_ceiling

    _seed(temp_project)
    researched: list[str] = []
    calls = {"n": 0}

    def one_then_broke(operation, job_id, **kw):
        calls["n"] += 1
        if calls["n"] > 2:  # ticket, first author, then out of budget
            raise quotas.QuotaExceeded(
                used_nanousd=200_000_000, requested_nanousd=40_000_000,
                limit_nanousd=200_000_000,
            )
        return None

    monkeypatch.setattr(spend_ceiling, "hold", one_then_broke)
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    def research(name, affiliation, titles):
        researched.append(name)
        return {"found": False}

    snap = _settled(lab_research.start_research(research_fn=research).id)

    # Reported as an error carrying the refusal, NOT a quiet `done`. A finished-looking pass with
    # zero labs is rendered by the client as "not every topic concentrates in labs" — which tells
    # a reader their field has no labs when the truth is we never looked. An earlier version of
    # this test asserted `done` and locked that silence in.
    assert snap["status"] == "error", "a pass that could not look must not read as having looked"
    # The ledger's own refusal text, not a generic failure — it is what tells the reader whether
    # to wait fifteen seconds or until the period rolls over.
    assert "usage limit" in snap["error"].lower(), snap["error"]
    assert "could not complete" not in snap["error"], (
        "a budget refusal must not be dressed up as a provider failure"
    )
    assert snap["current"] == "", "the unreached author must not be left named as in progress"
    assert len(researched) == 1, "the pass must stop, not refuse each remaining author in turn"

    # The distinguishing property, and the reason this is a `break` rather than a `continue`: an
    # author the pass never reached must carry NO cache entry. Falling through to the generic
    # handler instead writes each unreached author a not-found record, which reads afterwards as
    # "we looked and there was nothing there" — indistinguishable, to every later view, from a
    # genuine miss.
    cache = lab_research.load_cache()
    unreached = [name for name in ("Song Han", "Ji Lin") if name not in researched]
    for name in unreached:
        assert graph._author_key(name) not in cache, (
            f"{name} was never researched but was cached as a result"
        )


def test_a_refused_pass_is_not_masked_by_authors_cached_from_earlier_runs(
    temp_project, monkeypatch,
):
    """`job.found` counts cache hits from PREVIOUS passes, so a pass that researched nobody could
    still report `done — 1 of 2 mapped` and hand the reader a success toast. Re-running produced
    the same cheerful nothing forever.

    The distinguishing quantity is what THIS pass found, not what the cache holds.
    """
    from app import graph, quotas, spend_ceiling

    _seed(temp_project)

    # First pass: both authors researched and cached.
    _settled(lab_research.start_research(
        research_fn=lambda n, a, t: {"found": True, "lab_name": f"{n} Lab",
                                     "institution": "MIT", "url": "u", "focus": "f",
                                     "evidence": "e"}).id)

    # Invalidate one author so the next pass must actually research them, then refuse its hold.
    cache = lab_research.load_cache()
    board = lab_research._board()
    stale = board[1]["name"]
    cache[graph._author_key(stale)]["fingerprint"] = "no-longer-matching"
    lab_research._save_cache(cache)

    # The job's own admission ticket is granted; the per-author hold that follows is refused. The
    # cached author is skipped without a hold, so the stale one is the only unit that asks.
    calls = {"n": 0}

    def refuse_after_admission(operation, job_id, **kw):
        calls["n"] += 1
        if calls["n"] > 1:
            raise quotas.QuotaExceeded(used_nanousd=10, requested_nanousd=10, limit_nanousd=10)
        return None

    monkeypatch.setattr(spend_ceiling, "hold", refuse_after_admission)
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    snap = _settled(lab_research.start_research(
        research_fn=lambda n, a, t: {"found": True}).id)

    assert snap["status"] == "error", (
        f"a pass that researched nobody reported {snap['status']} because an EARLIER pass had "
        f"cached a find (found={snap['found']})"
    )
    assert "usage limit" in (snap["error"] or "").lower(), snap["error"]


def test_a_budget_refusal_outranks_the_every_author_failed_message(temp_project, monkeypatch):
    """One genuine failure then a refusal satisfies `failed == attempted` too.

    Taking that branch produced "Lab research failed for every author — you have used your monthly
    allowance", which frames a budget limit as a provider outage and points the reader at the wrong
    problem. The refusal is both more specific and more actionable.
    """
    from app import quotas, spend_ceiling

    _seed(temp_project)
    calls = {"n": 0}

    def refuse_after_one_author(operation, job_id, **kw):
        calls["n"] += 1
        if calls["n"] > 2:  # ticket, first author, then out of budget
            raise quotas.QuotaExceeded(used_nanousd=10, requested_nanousd=10, limit_nanousd=10)
        return None

    monkeypatch.setattr(spend_ceiling, "hold", refuse_after_one_author)
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    def always_fails(name, affiliation, titles):
        raise RuntimeError("provider down")

    snap = _settled(lab_research.start_research(research_fn=always_fails).id)

    assert snap["status"] == "error"
    assert "usage limit" in (snap["error"] or "").lower(), snap["error"]
    assert "every author" not in snap["error"], (
        "a budget refusal was reported as a provider failure across all authors"
    )
