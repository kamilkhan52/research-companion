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


def test_per_unit_binds_the_units_hold_and_restores_the_parents(monkeypatch):
    """The attribution property the context manager exists for.

    The only test that reached `per_unit` stubbed `hold` to None and `settle` to a no-op, so bind
    and reset ran in their inert form and nothing pinned where spend actually lands.
    """
    from app import spend_ceiling

    parent = spend_ceiling._Held(
        reservation_id="r-parent", user_id="u", attempt_id="a", operation="lab_research",
        job_id="j",
    )
    unit = spend_ceiling._Held(
        reservation_id="r-unit", user_id="u", attempt_id="a2", operation="lab_research",
        job_id="j",
    )
    monkeypatch.setattr(spend_ceiling, "hold", lambda *a, **k: unit)
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    token = spend_ceiling.bind(parent)
    try:
        with spend_ceiling.per_unit("lab_research", "j"):
            spend_ceiling.note_spend(500)
        spend_ceiling.note_spend(7)
    finally:
        spend_ceiling.reset(token)

    assert unit.spent_nanousd == 500, "the unit's spend must land on the unit's hold"
    assert parent.spent_nanousd == 7, "the parent's ticket must be restored on exit"


def test_per_unit_settles_the_hold_even_when_the_body_raises(monkeypatch):
    """A unit that fails has still spent whatever it spent before failing."""
    from app import spend_ceiling

    unit = spend_ceiling._Held(
        reservation_id="r", user_id="u", attempt_id="a", operation="lab_research", job_id="j",
    )
    settled: list = []
    monkeypatch.setattr(spend_ceiling, "hold", lambda *a, **k: unit)
    monkeypatch.setattr(spend_ceiling, "settle", settled.append)

    with pytest.raises(RuntimeError):
        with spend_ceiling.per_unit("lab_research", "j"):
            spend_ceiling.note_spend(42)
            raise RuntimeError("the unit failed")

    assert settled == [unit]
    assert unit.spent_nanousd == 42


def test_per_unit_binds_nothing_when_the_hold_is_refused(monkeypatch):
    """A refused unit must leave the parent's ticket exactly as it was."""
    from app import quotas, spend_ceiling

    parent = spend_ceiling._Held(
        reservation_id="r", user_id="u", attempt_id="a", operation="lab_research", job_id="j",
    )

    def refuse(*a, **k):
        raise quotas.QuotaExceeded(
            used_nanousd=10, requested_nanousd=10, limit_nanousd=10,
        )

    monkeypatch.setattr(spend_ceiling, "hold", refuse)

    token = spend_ceiling.bind(parent)
    try:
        with pytest.raises(quotas.QuotaExceeded):
            with spend_ceiling.per_unit("lab_research", "j"):
                pass
        assert spend_ceiling.active() is parent, "the parent must still be bound"
        spend_ceiling.note_spend(3)
    finally:
        spend_ceiling.reset(token)

    assert parent.spent_nanousd == 3


def test_per_unit_refuses_to_unbind_an_active_parent(monkeypatch):
    """`hold` returns None when ceilings are inert. Binding that over a live parent would send the
    unit's spend nowhere — the fail-open shape `config.bound_scope` exists to prevent, since a
    missing reservation loses money silently rather than failing loudly."""
    from app import spend_ceiling

    parent = spend_ceiling._Held(
        reservation_id="r", user_id="u", attempt_id="a", operation="lab_research", job_id="j",
    )
    monkeypatch.setattr(spend_ceiling, "hold", lambda *a, **k: None)
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    token = spend_ceiling.bind(parent)
    try:
        with spend_ceiling.per_unit("lab_research", "j"):
            spend_ceiling.note_spend(99)
    finally:
        spend_ceiling.reset(token)

    assert parent.spent_nanousd == 99, "spend vanished: the parent was unbound by an inert hold"


def test_a_billed_request_with_no_readable_cost_settles_at_the_maximum(monkeypatch):
    """Exactness is a claim, and it has to be earned.

    OpenRouter can accept a generation, return its id, and give back a usage block we cannot read
    a cost from. Analytics handles that fine — `record_pending` leaves a marker and
    `usage.reconcile()` fills the price in later. The RESERVATION cannot wait: it settles the
    moment the job ends and settling is terminal, so a run whose first generation cost $0.004 and
    whose second was unpriced used to settle at exactly $0.004, and the second left the account's
    monthly ceiling for good.

    Over-charging is recoverable; silently dropping real spend out of the ceiling is not.
    """
    from app import spend_ceiling

    settled: list[int] = []
    monkeypatch.setattr(quotas, "resolve_attempt", lambda *a, **k: None)
    monkeypatch.setattr(quotas, "mark_dispatches_complete", lambda *a, **k: None)
    monkeypatch.setattr(quotas, "settle",
                        lambda reservation_id, user_id, actual_nanousd: settled.append(
                            actual_nanousd))

    held = spend_ceiling._Held(
        reservation_id="r", user_id="u", attempt_id="a", operation="retrieval_hunt",
        maximum_nanousd=100_000_000,
    )
    token = spend_ceiling.bind(held)
    try:
        spend_ceiling.note_spend(4_000_000)      # the generation we could price
        spend_ceiling.note_uncertain_spend()     # the one we could not
    finally:
        spend_ceiling.reset(token)
    spend_ceiling.settle(held)

    assert settled == [100_000_000], (
        f"settled at {settled}; the unpriced generation escaped the ceiling permanently"
    )


def test_a_fully_priced_run_still_settles_exactly(monkeypatch):
    """The conservative path must not swallow the normal one — settling every run at its maximum
    would park most of a month in budget that was never spent."""
    from app import spend_ceiling

    settled: list[int] = []
    monkeypatch.setattr(quotas, "resolve_attempt", lambda *a, **k: None)
    monkeypatch.setattr(quotas, "mark_dispatches_complete", lambda *a, **k: None)
    monkeypatch.setattr(quotas, "settle",
                        lambda reservation_id, user_id, actual_nanousd: settled.append(
                            actual_nanousd))

    held = spend_ceiling._Held(
        reservation_id="r", user_id="u", attempt_id="a", operation="retrieval_hunt",
        maximum_nanousd=100_000_000,
    )
    token = spend_ceiling.bind(held)
    try:
        spend_ceiling.note_spend(4_000_000)
    finally:
        spend_ceiling.reset(token)
    spend_ceiling.settle(held)

    assert settled == [4_000_000]


def test_the_recorder_flags_uncertainty_on_the_active_hold(monkeypatch):
    """End to end from the recorder, since that is where the fact originates."""
    from app import agent_harness, spend_ceiling, usage
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.usage import RequestUsage

    monkeypatch.setattr(usage, "record", lambda *a, **k: None)
    monkeypatch.setattr(usage, "record_pending", lambda *a, **k: None)

    def response(cost, gen_id):
        return ModelResponse(
            parts=[TextPart("x")], usage=RequestUsage(input_tokens=10, output_tokens=5),
            model_name="m", provider_name="openrouter",
            provider_details=({"cost": cost} if cost is not None else {}),
            provider_response_id=gen_id,
        )

    held = spend_ceiling._Held(
        reservation_id="r", user_id="u", attempt_id="a", operation="retrieval_hunt",
        maximum_nanousd=100_000_000,
    )
    token = spend_ceiling.bind(held)
    try:
        agent_harness.record_agent_run(
            None, None, "retrieval_hunt", [response(0.004, "g1"), response(None, "g2")],
        )
    finally:
        spend_ceiling.reset(token)

    assert held.uncertain, "an accepted generation with no readable cost left the hold exact"


def _openrouter_model_with_transport(handler, monkeypatch, operation="analysis"):
    """A real `_LedgerOpenRouterModel` whose socket is replaced, so the request/response hooks
    that do the dispatch accounting run exactly as they do in production."""
    import httpx
    from app import agent_harness, config, spend_control

    monkeypatch.setattr(spend_control, "require_enabled", lambda: None)
    monkeypatch.setattr(config, "load_settings",
                        lambda: {"openrouter_api_key": "sk-test", "model": "test/model"})
    model = agent_harness._openrouter_model(operation=operation)
    model._provider._own_http_client._transport = httpx.MockTransport(handler)
    return model


def _settle_capturing(monkeypatch) -> list[int]:
    charged: list[int] = []
    monkeypatch.setattr(quotas, "resolve_attempt", lambda *a, **k: None)
    monkeypatch.setattr(quotas, "mark_dispatches_complete", lambda *a, **k: None)
    monkeypatch.setattr(quotas, "settle",
                        lambda reservation_id, user_id, actual_nanousd: charged.append(
                            actual_nanousd))
    return charged


def test_a_request_billed_then_lost_in_transit_does_not_settle_as_free(monkeypatch):
    """The last hole, and the one invisible from above the socket.

    pydantic-ai counts a request only once a response returns or a stream opens. If OpenRouter
    processes and BILLS a request whose response is then lost, there is no captured `ModelResponse`
    and `RunUsage.requests` is 0 — so the run looks identical to one that never happened, and the
    reservation settled at $0. Counting at the transport seam is the only place that knows.
    """
    import asyncio

    import httpx
    from app import spend_ceiling
    from pydantic_ai import Agent

    charged = _settle_capturing(monkeypatch)
    attempts = {"n": 0}

    async def lost(request):
        attempts["n"] += 1
        raise httpx.ReadError("billed, then the response was lost")

    from pydantic_ai.exceptions import ModelAPIError

    model = _openrouter_model_with_transport(lost, monkeypatch)
    held = spend_ceiling._Held(reservation_id="r", user_id="u", attempt_id="a",
                               operation="analysis", maximum_nanousd=150_000_000)
    token = spend_ceiling.bind(held)
    try:
        with pytest.raises(ModelAPIError):
            asyncio.run(Agent(model, output_type=str).run("hello"))
    finally:
        spend_ceiling.reset(token)
    spend_ceiling.settle(held)

    assert attempts["n"] >= 1, "the request must actually reach the transport"
    assert held.dispatched == attempts["n"], "every wire attempt must be counted"
    assert held.priced == 0
    assert charged == [150_000_000], (
        f"a possibly-billed request settled at {charged}; it escaped the ceiling"
    )


def test_a_refused_request_is_not_turned_into_a_charge(monkeypatch):
    """The other direction, and the reason this is an allowlist rather than "not 2xx".

    A 429 is refused before anything is generated, so it costs nothing. Counting it as an
    unaccounted dispatch would settle the whole reservation at its maximum — converting a rejected
    request into a charge, which is worse than the gap the counter closes.
    """
    import asyncio

    import httpx
    from app import spend_ceiling
    from pydantic_ai import Agent

    charged = _settle_capturing(monkeypatch)

    async def rate_limited(request):
        return httpx.Response(429, json={"error": {"message": "slow down"}})

    from pydantic_ai.exceptions import ModelHTTPError

    model = _openrouter_model_with_transport(rate_limited, monkeypatch)
    held = spend_ceiling._Held(reservation_id="r", user_id="u", attempt_id="a",
                               operation="analysis", maximum_nanousd=150_000_000)
    token = spend_ceiling.bind(held)
    try:
        with pytest.raises(ModelHTTPError):
            asyncio.run(Agent(model, output_type=str).run("hello"))
    finally:
        spend_ceiling.reset(token)
    spend_ceiling.settle(held)

    assert held.dispatched == 0, "a refused request must not stay counted as possibly billed"
    assert charged == [0], f"a rate-limited request was charged {charged}"


def test_an_ordinary_priced_run_still_settles_exactly_through_the_real_transport(monkeypatch):
    """The counter must not turn every successful run into a maximum charge.

    `note_dispatch` fires for every request on the wire, so without the balancing `note_priced`
    a perfectly normal run finishes with `dispatched=1, priced=0`, reads as unaccounted, and
    settles at its full maximum. That would park most of a month in budget nobody spent — a far
    more damaging bug than the transport gap this machinery exists to close, and it survived the
    first revert-verify pass because no test drove a SUCCESSFUL run through the real hooks.
    """
    import asyncio

    import httpx
    from app import spend_ceiling
    from pydantic_ai import Agent

    charged = _settle_capturing(monkeypatch)

    async def priced(request):
        return httpx.Response(200, json={
            "id": "gen-abc",
            "model": "test/model",
            "object": "chat.completion",
            "created": 0,
            "provider": "DeepSeek",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": "hi"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                      "cost": 0.004},
        })

    model = _openrouter_model_with_transport(priced, monkeypatch)
    held = spend_ceiling._Held(reservation_id="r", user_id="u", attempt_id="a",
                               operation="analysis", maximum_nanousd=150_000_000)
    token = spend_ceiling.bind(held)
    try:
        result = asyncio.run(Agent(model, output_type=str).run("hello"))
        from app import agent_harness
        agent_harness.record_agent_run(result.usage, model, "analysis", result.all_messages())
    finally:
        spend_ceiling.reset(token)
    spend_ceiling.settle(held)

    assert held.dispatched == held.priced == 1, (
        f"dispatched={held.dispatched} priced={held.priced}: the counter is unbalanced, so a "
        "normal run will settle at its maximum"
    )
    assert not held.uncertain
    assert charged == [4_000_000], f"an ordinary $0.004 run settled at {charged}"
