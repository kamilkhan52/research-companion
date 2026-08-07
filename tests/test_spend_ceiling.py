"""Holding a reservation across one job, and settling it to what was really spent.

The dangerous failure here is quiet in both directions: a ceiling that never holds looks exactly
like a well-behaved account, and a ceiling that holds but never RELEASES silently eats a reader's
monthly budget a job at a time. So these assert the release/settle paths as hard as the refusal.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import pytest
from app import config, jobs, quotas, spend_ceiling, spend_limits
from app.jobs import Job, JobRegistry, new_id

ALICE = "11111111-1111-4111-8111-111111111111"


@dataclass
class SampleJob(Job):
    value: int = 0


class _FakeReservation:
    def __init__(self, rid): self.id = rid


class _FakeAttempt:
    def __init__(self, aid): self.id = aid


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    monkeypatch.setattr(jobs, "_ALL_REGISTRIES", [])
    yield


@pytest.fixture
def ledger(monkeypatch):
    """A stand-in for the durable ledger, recording what the registry asked it to do."""
    calls = {"reserve": [], "settle": [], "release": [], "resolve": [], "complete": []}

    def reserve(**kw):
        calls["reserve"].append(kw)
        return _FakeReservation(f"res-{len(calls['reserve'])}")

    monkeypatch.setattr(quotas, "reserve", reserve)
    # The attempt lifecycle is part of settling, not an optional extra: `quotas.settle` refuses a
    # reservation that was never marked dispatched. Stubbing it here keeps these tests focused on
    # the REGISTRY wiring — `tests/test_spend_ceiling_pg.py` is what proves the ledger accepts the
    # sequence, which is the check whose absence let an unsettleable version pass CI.
    monkeypatch.setattr(quotas, "begin_attempt",
                        lambda rid, **kw: (_FakeAttempt(f"att-{rid}"), True))
    monkeypatch.setattr(quotas, "resolve_attempt",
                        lambda aid, **kw: calls["resolve"].append((aid, kw["actual_nanousd"])))
    monkeypatch.setattr(quotas, "mark_dispatches_complete",
                        lambda rid, **kw: calls["complete"].append(rid))
    monkeypatch.setattr(quotas, "settle", lambda rid, *, user_id, actual_nanousd, **kw:
                        calls["settle"].append((rid, actual_nanousd)))
    monkeypatch.setattr(quotas, "release", lambda rid, *, user_id:
                        calls["release"].append(rid))
    monkeypatch.setattr(spend_limits, "enabled", lambda: True)
    return calls


def _settled(reg, job_id, timeout=5.0):
    """Wait for the client-visible status to go terminal."""
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = reg.jobs.get(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError("job did not settle")


def _wait_for(predicate, timeout=5.0, what="condition"):
    """Wait for the RESERVATION to settle, which is later than the status flip.

    `status` goes terminal inside the worker while it is still unwinding; the reservation is
    settled in the same `finally` that clears the worker marker, strictly afterwards. Asserting
    immediately after `_settled` therefore reads an empty ledger — and passed in isolation only
    because a quiet machine won the race, then failed under a full-suite run.
    """
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def test_a_metered_job_reserves_its_operations_pessimistic_maximum(ledger):
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    assert len(ledger["reserve"]) == 1
    held = ledger["reserve"][0]
    assert held["operation"] == "analysis"
    assert held["maximum_cost_nanousd"] == spend_limits.max_cost_nanousd("analysis")
    assert held["limit_nanousd"] == spend_limits.monthly_limit_nanousd()
    assert held["user_id"] == ALICE


def test_an_unmetered_job_reserves_nothing(ledger):
    reg: JobRegistry[SampleJob] = JobRegistry("internal")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    assert ledger["reserve"] == []


def test_the_job_settles_to_what_was_actually_spent_not_the_maximum_held(ledger):
    """The whole point of reserving a maximum: the unspent remainder must go back."""
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")

    def work(_job):
        spend_ceiling.note_spend(1_234)   # as usage.record would, from inside the worker
        spend_ceiling.note_spend(766)

    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), work)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    assert ledger["settle"] == [("res-1", 2_000)]
    assert ledger["settle"][0][1] < spend_limits.max_cost_nanousd("analysis")


def test_a_job_that_spends_nothing_still_settles_at_zero(ledger):
    """Settled-at-zero records the admission as used; releasing would say it never happened."""
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    assert ledger["settle"] == [("res-1", 0)]


def test_a_failing_job_still_settles_so_the_hold_is_not_stranded(ledger):
    """An exception must not leave a reservation eating the account's budget until it expires."""
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")

    def boom(_job):
        spend_ceiling.note_spend(500)     # money really was spent before it failed
        raise RuntimeError("provider exploded")

    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), boom)
        settled = _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    assert settled.status == "error"
    _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    assert ledger["settle"] == [("res-1", 500)], "a failed job must still be charged what it spent"


def test_a_refusal_reaches_the_caller_and_holds_nothing(ledger, monkeypatch):
    """Out of budget fails CLOSED — the work must not start."""
    monkeypatch.setattr(quotas, "reserve", lambda **kw: (_ for _ in ()).throw(
        quotas.QuotaExceeded(used_nanousd=2_500_000_000, requested_nanousd=80_000,
                             limit_nanousd=2_500_000_000)))
    ran = threading.Event()
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        with pytest.raises(quotas.QuotaExceeded):
            reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: ran.set())
    finally:
        config.reset_active_user(token)
    assert not ran.is_set(), "refused work must never run"
    assert ledger["settle"] == [] and ledger["release"] == []


def test_an_unreachable_ledger_refuses_rather_than_admitting_free_work(ledger, monkeypatch):
    """A ceiling that opens when its store is down is not a ceiling (architectural rule 5)."""
    monkeypatch.setattr(quotas, "reserve", lambda **kw: (_ for _ in ()).throw(
        quotas.QuotaUnavailable("Usage limits are temporarily unavailable.")))
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        with pytest.raises(quotas.QuotaUnavailable):
            reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
    finally:
        config.reset_active_user(token)


def test_spend_outside_a_job_is_ignored_rather_than_charged_to_someone_else():
    """No bound reservation means no accumulator — a stray call must not land on a random job."""
    spend_ceiling.note_spend(9_999)  # must not raise
    assert spend_ceiling.active() is None


def test_ceilings_are_inert_without_a_database_or_user(monkeypatch):
    monkeypatch.setattr(spend_limits, "enabled", lambda: False)
    called = []
    monkeypatch.setattr(quotas, "reserve", lambda **kw: called.append(kw))
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
    _settled(reg, job.id)
    assert called == [], "local dev must behave exactly as before"


def test_real_usage_recording_feeds_the_reservation(ledger, temp_project):
    """Drive the ACTUAL accounting seam, not the accumulator directly.

    Every other test here calls `note_spend` by hand, which proves the accumulator works while
    proving nothing about whether anything calls it — deleting the line in `usage.record` left
    them all green. `usage.record` is the one seam every metered call already passes through, so
    this is the wiring that has to hold.
    """
    from app import usage

    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")

    def work(_job):
        # Exactly what llm.py does after a completed OpenRouter call.
        usage.record("analysis", "deepseek/deepseek-v4-pro", {"cost": 0.002})

    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), work)
        _settled(reg, job.id)
        _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    finally:
        config.reset_active_user(token)

    # $0.002 -> 2,000,000 nano-USD, charged against the reservation rather than only the ledger.
    assert ledger["settle"] == [("res-1", 2_000_000)]


def test_a_continuation_is_exempt_from_the_rate_ceiling_but_still_holds_budget(ledger):
    """Rate limiting and budget answer different questions about the same work.

    A listening turn's narration was exempt from BOTH because one flag controlled both — so the
    largest variable cost in the app (audio) sat entirely outside the spend ceiling on the path
    readers actually take. It must still not consume a concurrency slot, since it was authorized
    when its parent turn was admitted.
    """
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="speech_synthesis")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join(
            "k", lambda: SampleJob(id=new_id()), lambda j: None,
            metered=False, reserves=True,
        )
        _settled(reg, job.id)
        _wait_for(lambda: ledger["settle"], what="the continuation to settle")
    finally:
        config.reset_active_user(token)
    assert len(ledger["reserve"]) == 1, "a continuation's spend must still be held"
    assert ledger["reserve"][0]["operation"] == "speech_synthesis"


def test_an_explicit_maximum_overrides_the_flat_per_operation_hold(ledger):
    """The override still exists for work whose size is known at admission, even though graph
    builds no longer use it — each of their papers holds for itself now."""
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join(
            "k", lambda: SampleJob(id=new_id()), lambda j: None,
            hold_max_nanousd=12_345_000,
        )
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    assert ledger["reserve"][0]["maximum_cost_nanousd"] == 12_345_000

def test_pool_threads_charge_their_spend_to_the_parent_reservation(ledger):
    """`run_parallel` fan-out is the SAME job, so its spend belongs to the hold already taken.

    A pool thread inherits no contextvars, so without an explicit bind `note_spend` finds nothing
    and drops the cost. That silently zeroed the two most expensive operations in the app — a graph
    build extracting a whole corpus, and every parallel discovery stage — and three review passes
    confirmed no test failed when the bind was removed.
    """
    from app import jobs as jobs_module

    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="graph_build")

    def work(_job):
        # Exactly the shape of graph extraction: fan out, each worker spends.
        jobs_module.run_parallel(
            [1_000, 2_000, 3_000],
            lambda cost: spend_ceiling.note_spend(cost),
            max_workers=3,
        )

    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), work)
        _settled(reg, job.id)
        _wait_for(lambda: ledger["settle"], what="the build to settle")
    finally:
        config.reset_active_user(token)
    assert ledger["settle"] == [("res-1", 6_000)], (
        "spend from pool threads must reach the parent reservation, not vanish"
    )


def test_app_global_spend_with_no_project_still_charges_the_reservation(ledger):
    """`usage.record` returns early when there is no active project, but reservations are scoped to
    the USER. Audio is app-global — `/api/audio/jobs` has no project in its path — and it is the
    largest variable cost in the app, so charging behind that guard let it escape the ceiling."""
    from app import usage

    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="speech_synthesis")

    def work(_job):
        usage.record("speech_synthesis", "tts-1", {"cost": 0.004})

    token = config.set_active_user(ALICE)
    project_token = config.set_active_project(None)   # app-global, like an audio job
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), work)
        _settled(reg, job.id)
        _wait_for(lambda: ledger["settle"], what="the audio job to settle")
    finally:
        config.reset_active_project(project_token)
        config.reset_active_user(token)
    assert ledger["settle"] == [("res-1", 4_000_000)], (
        "app-global spend must still be charged to the user's reservation"
    )


def test_the_real_continuation_call_sites_hold_budget(ledger, temp_project, monkeypatch):
    """Pin the production wiring, not a synthetic registry passing the flag to itself.

    The existing continuation test builds its own registry and supplies `reserves=True`, so it
    proves the registry honours the flag and nothing about whether `chat_jobs` and `audio_jobs`
    actually pass it. Removing it from both left the whole suite green across three review passes.
    """
    import ast
    import inspect

    from app import audio_jobs, chat_jobs

    def reserves_kw(module, owner: str, attr: str):
        tree = ast.parse(inspect.getsource(module))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == attr
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == owner
            ):
                for kw in node.keywords:
                    if kw.arg == "reserves":
                        yield kw.value

    for module, owner, attr in (
        (chat_jobs, "_registry", "start_or_join"),
        (audio_jobs, "_registry", "start_or_join"),
    ):
        values = list(reserves_kw(module, owner, attr))
        assert values, (
            f"{module.__name__} must state `reserves` explicitly: it passes `metered` through for "
            "continuations, and inheriting the registry default there is what left the largest "
            "variable cost in the app outside the ceiling"
        )
        assert all(
            isinstance(v, ast.Constant) and v.value is True for v in values
        ), f"{module.__name__} must pass reserves=True — a continuation's spend is still spend"


def test_spend_inside_a_child_registrys_worker_reaches_the_parents_reservation(ledger):
    """The hop that made the whole graph ceiling inert.

    A build binds its reservation on the fan-out thread, then hands each paper to a DIFFERENT
    registry (`paper-references`), whose worker runs on a third thread. That registry takes no
    reservation of its own, so it bound `None` and the extraction's cost was dropped — every build
    settled at $0 however much it spent, and the per-paper gating that bounds a large build
    never fired because there was never any spend to settle.

    Binding `run_parallel` was not enough: this is a registry hop, not a pool hop.
    """
    parent: JobRegistry[SampleJob] = JobRegistry("parent", metered=True, operation="graph_build")
    child: JobRegistry[SampleJob] = JobRegistry("child")   # unmetered, like paper-references

    def child_work(_job):
        spend_ceiling.note_spend(5_000_000)   # the extraction's real cost

    def parent_work(_job):
        job = child.start_or_join("paper", lambda: SampleJob(id=new_id()), child_work)
        _settled(child, job.id)

    token = config.set_active_user(ALICE)
    try:
        job = parent.start_or_join("build", lambda: SampleJob(id=new_id()), parent_work)
        _settled(parent, job.id)
        _wait_for(lambda: ledger["settle"], what="the build to settle")
    finally:
        config.reset_active_user(token)

    assert len(ledger["reserve"]) == 1, "the child must not take a reservation of its own"
    assert ledger["settle"] == [("res-1", 5_000_000)], (
        "spend inside a child registry's worker must reach the parent's reservation"
    )


def test_a_child_job_never_settles_the_reservation_it_inherited(ledger):
    """Inheriting is only safe if the child cannot finalize what it borrowed.

    A build runs many short child jobs. If each settled the hold it inherited, the first paper
    would close the build's reservation and every later one would fail against a settled row.
    """
    parent: JobRegistry[SampleJob] = JobRegistry("parent", metered=True, operation="graph_build")
    child: JobRegistry[SampleJob] = JobRegistry("child")
    settles_during_build: list[int] = []

    def parent_work(_job):
        for i in range(3):
            job = child.start_or_join(
                f"p{i}", lambda: SampleJob(id=new_id()),
                lambda _j: spend_ceiling.note_spend(1_000_000),
            )
            _settled(child, job.id)
        settles_during_build.append(len(ledger["settle"]))

    token = config.set_active_user(ALICE)
    try:
        job = parent.start_or_join("build", lambda: SampleJob(id=new_id()), parent_work)
        _settled(parent, job.id)
        _wait_for(lambda: ledger["settle"], what="the build to settle")
    finally:
        config.reset_active_user(token)

    assert settles_during_build == [0], "no child may settle the build's hold while it runs"
    assert ledger["settle"] == [("res-1", 3_000_000)], "all three papers charged, settled once"


def test_a_child_that_outlives_its_parent_holds_its_own_budget(ledger):
    """Fire-and-forget children were charged to a hold that had already settled.

    `chat_jobs` starts the listening-cue coordinator and returns; the analysis hold settles; the
    coordinator then runs for the whole narration wait, starting an uncapped stream of cues. Each
    cue's spend landed on a dead reservation and was never charged. The retrieval worker does the
    same with the canonical-warm chain. Inheriting is only safe while the parent is still running,
    and these deliberately are not — so they reserve their own budget instead.
    """
    from app import affiliation_jobs, preview_jobs, reference_jobs

    for registry, operation in (
        (preview_jobs._registry, "listening_preview"),
        (preview_jobs._coordinator_registry, "listening_preview"),
        (reference_jobs._registry, "graph_extraction"),
        (affiliation_jobs._registry, "affiliations"),
    ):
        assert registry.reserves, (
            f"{registry.name} outlives the request that starts it, so it must hold its own budget"
        )
        assert registry.operation == operation
        assert not registry.metered, (
            f"{registry.name} is not an entry point a reader queues, so it must not consume one "
            "of their concurrency slots"
        )


def test_reserving_and_rate_limiting_are_independent_registry_decisions(ledger):
    """A registry can hold budget without counting against the concurrency ceiling, and the
    default keeps them together so an ordinary entry point needs no extra thought."""
    both: JobRegistry[SampleJob] = JobRegistry("both", metered=True, operation="analysis")
    assert both.metered and both.reserves

    budget_only: JobRegistry[SampleJob] = JobRegistry(
        "budget-only", reserves=True, operation="analysis",
    )
    assert budget_only.reserves and not budget_only.metered

    neither: JobRegistry[SampleJob] = JobRegistry("neither")
    assert not neither.metered and not neither.reserves
