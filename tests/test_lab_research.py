"""R7.7 — the lab research pass: parse contract, cached-skip behavior, per-author persist,
error isolation, and the lab-centric grouping. The web agent is injected; no network."""
from __future__ import annotations

import time

import pytest
from app import graph_store, lab_research, quotas

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


def test_agent_run_disables_reasoning(temp_project, monkeypatch):
    """Lab research is a lookup, not a problem to think about: the run must ask the model builder
    to turn hidden reasoning off (DR-047 — a reasoning model on this job can spend the entire
    budget thinking and emit nothing, exactly the failure that broke Get profile)."""
    import pydantic_ai
    from app import agent_harness, graph

    captured: dict = {}

    class QuietAgent:
        def __init__(self, *args, **kwargs):
            self.model = object()

        async def run(self, *args, **kwargs):
            class Result:
                output = 'RESULT: {"found": false}'
            return Result()

    def fake_model(model=None, operation="analysis", **kw):
        captured.update(kw, operation=operation)
        return object()

    monkeypatch.setattr(pydantic_ai, "Agent", QuietAgent)
    monkeypatch.setattr(agent_harness, "_openrouter_model", fake_model)
    monkeypatch.setattr(graph, "resolve_model", lambda: "test/model")

    lab_research._research_with_agent("Researcher", "University", ["Paper"])
    assert captured["no_reasoning"] is True
    assert captured["operation"] == "lab_research"


def test_reasoning_rejection_retries_without_the_hint(temp_project, monkeypatch):
    """The agentic mirror of `llm.complete`'s fallback. The graph model is an operator override
    (`RC_GRAPH_LLM_MODEL`) that can name a reasoning-mandatory model; without the retry, every
    author in every labs pass fails with a scrubbed message and no in-app remedy."""
    import pydantic_ai
    from app import agent_harness, graph

    built: list[bool] = []

    class RejectsTheHint:
        def __init__(self, *args, **kwargs):
            self.model = object()

        async def run(self, *args, **kwargs):
            if built[-1]:  # constructed with the no-reasoning hint
                raise RuntimeError(
                    "Provider returned 400: reasoning cannot be disabled for this model")

            class Result:
                output = 'RESULT: {"found": false}'
            return Result()

    def fake_model(model=None, operation="analysis", **kw):
        built.append(bool(kw.get("no_reasoning")))
        return object()

    monkeypatch.setattr(pydantic_ai, "Agent", RejectsTheHint)
    monkeypatch.setattr(agent_harness, "_openrouter_model", fake_model)
    monkeypatch.setattr(graph, "resolve_model", lambda: "test/model")

    out = lab_research._research_with_agent("Researcher", "University", ["Paper"])
    assert built == [True, False], built
    assert out == {"found": False}


def test_an_unrelated_failure_does_not_retry(temp_project, monkeypatch):
    """The fallback is for the hint being refused, not a second attempt at every error — a
    quota blowout or provider outage retried once would double the most expensive failures."""
    import pydantic_ai
    from app import agent_harness, graph

    built: list[bool] = []

    class AlwaysDown:
        def __init__(self, *args, **kwargs):
            self.model = object()

        async def run(self, *args, **kwargs):
            raise RuntimeError("provider 503")

    def fake_model(model=None, operation="analysis", **kw):
        built.append(bool(kw.get("no_reasoning")))
        return object()

    monkeypatch.setattr(pydantic_ai, "Agent", AlwaysDown)
    monkeypatch.setattr(agent_harness, "_openrouter_model", fake_model)
    monkeypatch.setattr(graph, "resolve_model", lambda: "test/model")

    with pytest.raises(RuntimeError) as err:
        lab_research._research_with_agent("Researcher", "University", ["Paper"])
    assert built == [True], "an unrelated failure must not trigger the reasoning retry"
    assert "model provider" in str(err.value)


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
    monkeypatch.setattr(agent_harness, "_openrouter_model",
                        lambda model=None, operation="analysis", **kw: object())
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
    # One hold per author and NOTHING for the job itself. The registry is `reserves=False`: its
    # own thread dispatches nothing to a provider, and a nominal ticket beside the real hold meant
    # a reader with $0.06 was admitted on a $0.04 ticket and then refused the $0.04 author, while a
    # crash mid-author left the reconciler charging both. An earlier version of this test asserted
    # the ticket-plus-unit shape, which codified that bug rather than catching it.
    assert holds == ["lab_research"] * 2, (
        f"expected exactly one hold per author and none for the job, got {holds}"
    )


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
        if calls["n"] > 1:  # first author, then out of budget
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

    # The cached author is skipped without a hold, so the stale one is the only unit that asks —
    # and it is refused. There is no admission ticket to grant first.
    def refuse_after_admission(operation, job_id, **kw):
        raise quotas.QuotaExceeded(used_nanousd=10, requested_nanousd=10, limit_nanousd=10)

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
        if calls["n"] > 1:  # first author, then out of budget
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


def test_a_reader_who_can_afford_one_author_gets_one_author(temp_project, monkeypatch):
    """Sol's scenario, and the partial-progress promise the design rests on.

    When the job also took a nominal ticket, a reader with $0.06 left was admitted on a $0.04
    ticket and then could not afford the $0.04 author — refused work they had the money for, and
    told so only after the job had started. Admission is a rate question; spend authorization is a
    money question, and answering both with one reservation made the ledger disagree with itself.
    """
    from app import spend_ceiling

    _seed(temp_project)
    budget = {"remaining": 60_000_000}   # $0.06
    researched: list[str] = []

    def hold(operation, job_id, **kw):
        cost = 40_000_000               # one author's pass
        if budget["remaining"] < cost:
            raise quotas.QuotaExceeded(
                used_nanousd=200_000_000 - budget["remaining"],
                requested_nanousd=cost, limit_nanousd=200_000_000,
            )
        budget["remaining"] -= cost
        return None

    monkeypatch.setattr(spend_ceiling, "hold", hold)
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    def research(name, affiliation, titles):
        researched.append(name)
        return {"found": True, "lab_name": f"{name} Lab", "institution": "MIT",
                "url": "u", "focus": "f", "evidence": "e"}

    snap = _settled(lab_research.start_research(research_fn=research).id)

    assert len(researched) == 1, (
        f"$0.06 bought {len(researched)} authors at $0.04 each; one was affordable"
    )
    # It found a lab, so the pass is a partial success rather than an error, and carries why it
    # stopped.
    assert snap["status"] == "done" and snap["found"] == 1
    assert "usage limit" in snap["stopped_reason"].lower(), snap["stopped_reason"]
