"""Per-user rate ceilings on starting paid work.

The failure mode this guards is silent in both directions: a ceiling that never triggers looks
exactly like a well-behaved client, and a ceiling that triggers on a JOIN would break the ordinary
polling flow while still looking like "the limiter works". So these assert the boundary in both
directions, and assert the properties (a join is free, a bad config still limits) rather than only
the happy refusal.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

import pytest
from app import config, jobs, rate_limits
from app.jobs import Job, JobRegistry, new_id

ALICE = "11111111-1111-4111-8111-111111111111"
BOB = "22222222-2222-4222-8222-222222222222"


@dataclass
class SampleJob(Job):
    value: int = 0


@pytest.fixture(autouse=True)
def _clean_limiter(monkeypatch):
    rate_limits.reset()
    # Registries self-register in a process-global list; a stale one from another module's import
    # would otherwise contribute live jobs to this test's concurrency count.
    monkeypatch.setattr(jobs, "_ALL_REGISTRIES", [])
    yield
    rate_limits.reset()
    # Swapping the module-global list above does NOT reach the real feature registries, which were
    # created at import time and keep their own `_jobs` dict. The few tests here that drive the
    # actual retrieval registry would otherwise leave finished jobs (and their project scopes)
    # behind for whatever runs next — `_prune`'s scope-retention bound is asserted elsewhere in
    # the suite, and leaking scopes into it made that assertion fail on a full-suite run.
    from app import retrieval_jobs
    with retrieval_jobs._registry.lock:  # a worker may still be settling as this runs
        retrieval_jobs._registry.jobs.clear()


def _as(user_id):
    return config.set_active_user(user_id)


def _settle(reg, job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = reg.jobs.get(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError(f"job {job_id} did not settle")


# ---------- the pure limiter ----------

def test_the_window_refuses_the_start_after_the_limit_and_says_when_to_retry(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "3")
    for _ in range(3):
        rate_limits.check_and_record(ALICE, active_jobs=0)
    with pytest.raises(rate_limits.RateLimited) as err:
        rate_limits.check_and_record(ALICE, active_jobs=0)
    # An honest Retry-After: never zero (a client would hot-loop) and never longer than the window.
    assert 1 <= err.value.retry_after_seconds <= int(rate_limits.WINDOW_SECONDS) + 1


def test_the_window_slides_rather_than_resetting_on_a_fixed_boundary(monkeypatch):
    # A fixed bucket would let 2x the limit through across a boundary. Age the recorded starts
    # past the window instead of sleeping 60s.
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "2")
    rate_limits.check_and_record(ALICE, active_jobs=0)
    rate_limits.check_and_record(ALICE, active_jobs=0)
    with pytest.raises(rate_limits.RateLimited):
        rate_limits.check_and_record(ALICE, active_jobs=0)

    bucket = rate_limits._starts[ALICE]
    aged = [t - (rate_limits.WINDOW_SECONDS + 1) for t in bucket]
    bucket.clear()
    bucket.extend(aged)

    rate_limits.check_and_record(ALICE, active_jobs=0)  # must not raise


def test_one_account_cannot_exhaust_anothers_budget(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    rate_limits.check_and_record(ALICE, active_jobs=0)
    with pytest.raises(rate_limits.RateLimited):
        rate_limits.check_and_record(ALICE, active_jobs=0)
    rate_limits.check_and_record(BOB, active_jobs=0)  # Bob is unaffected


def test_the_concurrency_ceiling_is_independent_of_the_rate_window(monkeypatch):
    # Nothing has been recorded, so the per-minute window is empty; only in-flight work refuses.
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "2")
    rate_limits.check_and_record(ALICE, active_jobs=1)
    with pytest.raises(rate_limits.RateLimited, match="already have"):
        rate_limits.check_and_record(ALICE, active_jobs=2)


def test_a_refused_start_does_not_consume_window_budget(monkeypatch):
    """A concurrency refusal must not also spend a slot in the per-minute window.

    Otherwise a client held at the concurrency ceiling silently burns its rate budget while doing
    no work, and is then refused for a second reason once its jobs drain.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "5")
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    for _ in range(10):
        with pytest.raises(rate_limits.RateLimited):
            rate_limits.check_and_record(ALICE, active_jobs=1)
    assert len(rate_limits._starts[ALICE]) == 0
    for _ in range(5):
        rate_limits.check_and_record(ALICE, active_jobs=0)


def test_no_signed_in_user_is_never_limited(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    for _ in range(50):
        rate_limits.check_and_record(None, active_jobs=99)


@pytest.mark.parametrize("bad", ["treu", "", "-4", "0", "1e3", "  "])
def test_a_bad_limit_value_falls_back_to_the_default_instead_of_disabling_the_ceiling(
    monkeypatch, bad,
):
    """The dangerous configuration is absence. A typo must not read as 'unlimited'."""
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", bad)
    assert rate_limits.starts_per_minute() == rate_limits.DEFAULT_STARTS_PER_MINUTE
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", bad)
    assert rate_limits.concurrent_jobs() == rate_limits.DEFAULT_CONCURRENT_JOBS


def test_concurrent_checks_cannot_collectively_exceed_the_window(monkeypatch):
    """The race the lock exists to close: simultaneous admissions, not sequential ones."""
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "5")
    admitted, refused = [], []
    start = threading.Barrier(20)

    def attempt():
        start.wait()
        try:
            rate_limits.check_and_record(ALICE, active_jobs=0)
            admitted.append(1)
        except rate_limits.RateLimited:
            refused.append(1)

    threads = [threading.Thread(target=attempt) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(admitted) == 5, f"admitted {len(admitted)}, expected exactly the ceiling"
    assert len(refused) == 15


# ---------- the registry seam ----------

def test_a_metered_registry_refuses_past_the_ceiling(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "2")
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        for i in range(2):
            job = reg.start_or_join(f"k{i}", lambda: SampleJob(id=new_id()), lambda j: None)
            _settle(reg, job.id)
        with pytest.raises(rate_limits.RateLimited):
            reg.start_or_join("k9", lambda: SampleJob(id=new_id()), lambda j: None)
    finally:
        config.reset_active_user(token)


def test_an_unmetered_registry_is_not_rate_limited(monkeypatch):
    """Internal follow-on work was authorized when its parent was admitted."""
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    reg: JobRegistry[SampleJob] = JobRegistry("internal")  # metered defaults to False
    token = _as(ALICE)
    try:
        for i in range(6):
            job = reg.start_or_join(f"k{i}", lambda: SampleJob(id=new_id()), lambda j: None)
            _settle(reg, job.id)
    finally:
        config.reset_active_user(token)


def test_joining_a_running_job_does_not_consume_budget(monkeypatch):
    """The property that would break ordinary polling if the check sat one level higher.

    Two identical callers must produce ONE admission. If the limiter ran before dedup, a client
    retrying its own in-flight request would rate-limit itself out of its own result.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    release = threading.Event()
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        first = reg.start_or_join(
            "same", lambda: SampleJob(id=new_id()), lambda j: release.wait(5),
        )
        # Same key while the first is still running -> a join, which must not raise even though
        # the per-minute budget of 1 is already spent.
        second = reg.start_or_join(
            "same", lambda: SampleJob(id=new_id()), lambda j: release.wait(5),
        )
        assert second.id == first.id
    finally:
        release.set()
        _settle(reg, first.id)
        config.reset_active_user(token)


def test_running_jobs_count_toward_the_concurrency_ceiling_across_registries(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "2")
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "50")
    release = threading.Event()
    a: JobRegistry[SampleJob] = JobRegistry("a", metered=True)
    b: JobRegistry[SampleJob] = JobRegistry("b", metered=True)
    token = _as(ALICE)
    try:
        j1 = a.start_or_join("k1", lambda: SampleJob(id=new_id()), lambda j: release.wait(5))
        j2 = b.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: release.wait(5))
        assert jobs.active_count_for_user(ALICE) == 2
        with pytest.raises(rate_limits.RateLimited, match="already have"):
            a.start_or_join("k3", lambda: SampleJob(id=new_id()), lambda j: None)
    finally:
        release.set()
        _settle(a, j1.id)
        _settle(b, j2.id)
        config.reset_active_user(token)


def test_another_users_running_work_does_not_count_against_you(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    release = threading.Event()
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    alice_token = _as(ALICE)
    try:
        j1 = reg.start_or_join("k1", lambda: SampleJob(id=new_id()), lambda j: release.wait(5))
    finally:
        config.reset_active_user(alice_token)
    bob_token = _as(BOB)
    try:
        assert jobs.active_count_for_user(BOB) == 0
        j2 = reg.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, j2.id)
    finally:
        release.set()
        _settle(reg, j1.id)
        config.reset_active_user(bob_token)


def test_the_ceiling_releases_when_the_worker_exits_not_when_the_client_sees_done(monkeypatch):
    """The ceiling is held slightly longer than the client-visible status, on purpose.

    `status` flips to done/cancelled while the worker thread is still inside its `finally` —
    that is deliberate (cancellation is terminal to clients while the worker drains), and the
    settle callbacks that run in that window can themselves admit follow-on work. So the count
    tracks `_worker_is_active`, not `status`. Asserting `== 0` the instant `_settle` returns is
    therefore asserting something the registry never promised, and passed only because a quiet
    machine won the race — it failed under a full-suite run.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "50")
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        first = reg.start_or_join("k1", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, first.id)

        deadline = time.time() + 5.0
        while jobs.active_count_for_user(ALICE) and time.time() < deadline:
            time.sleep(0.01)
        assert jobs.active_count_for_user(ALICE) == 0, "worker never released the ceiling"

        # And the freed slot is genuinely reusable at a ceiling of one.
        second = reg.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, second.id)
    finally:
        config.reset_active_user(token)


# ---------- regressions from the independent review of PR #325 ----------

def test_an_internal_continuation_does_not_consume_the_accounts_budget(monkeypatch):
    """The exemption has to hold per CALL SITE, not per registry.

    The chat and audio registries are each BOTH a direct client entry point and the target of
    internal continuation work: a listening turn starts its own narration, and auto-analyze starts
    a turn from inside the retrieval worker. Metering by registry charged those continuations to
    the user's own ceiling, so one ordinary "add paper with auto-analyze in listening mode"
    chained three admissions (retrieval -> chat -> audio) against a default ceiling of four.

    Worse, those calls happen inside a worker rather than a route, so the refusal never reached
    the 429 handler — it was swallowed into `audio_error`/`analysis_error` and the feature just
    silently did not happen.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        first = reg.start_or_join("k1", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, first.id)
        # Budget for the minute is now spent. A continuation must still be admitted.
        cont = reg.start_or_join(
            "k2", lambda: SampleJob(id=new_id()), lambda j: None, metered=False,
        )
        _settle(reg, cont.id)
        # ...while a genuine new entry point is still refused.
        with pytest.raises(rate_limits.RateLimited):
            reg.start_or_join("k3", lambda: SampleJob(id=new_id()), lambda j: None)
    finally:
        config.reset_active_user(token)


def test_every_worker_side_call_into_a_metered_entry_point_decides_metering_explicitly():
    """Sweep the whole package, not just the two sites already known to be wrong.

    The earlier version of this test parsed only `chat_jobs` and `session`, so it could not have
    caught a THIRD continuation added elsewhere — which the re-review pointed out. It also cannot
    prove reachability: a call site can pass the right keyword and still be reached from a path
    that never paid an admission, which is exactly how the already-retrieved bypass survived.
    So this checks the weaker but sweepable property: any module that is not an HTTP router and
    calls a metered entry point must state its metering intent, rather than silently inheriting
    the registry default it may not be entitled to.
    """
    import ast
    import pathlib

    entry_points = {"start_job": "audio_jobs", "start_turn": "chat_jobs"}
    app_dir = pathlib.Path(__file__).resolve().parent.parent / "app"
    offenders = []
    for path in sorted(app_dir.rglob("*.py")):
        if path.parent.name == "routers":
            continue  # a route IS the entry point; inheriting metered=True is correct there
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            owner = entry_points.get(node.func.attr)
            if not owner or not isinstance(node.func.value, ast.Name):
                continue
            if node.func.value.id != owner:
                continue
            if not any(kw.arg == "metered" for kw in node.keywords):
                offenders.append(f"{path.name}:{node.lineno} {owner}.{node.func.attr}")
    assert not offenders, (
        "these worker-side calls into a metered entry point do not state their metering "
        f"intent, so they inherit the registry default: {offenders}"
    )


def test_the_known_continuation_sites_pass_the_intended_value():
    """And the two known sites pass the RIGHT value, not merely some value."""
    import ast
    import inspect

    from app import chat_jobs
    from app.routers import session as session_routes

    def metered_kw(module, owner: str, attr: str):
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
                    if kw.arg == "metered":
                        yield kw.value

    # Narration always continues a turn that was already admitted -> a flat False.
    narration = list(metered_kw(chat_jobs, "audio_jobs", "start_job"))
    assert len(narration) == 1
    assert isinstance(narration[0], ast.Constant) and narration[0].value is False

    # Auto-analyze is admitted on the worker path but NOT on the free short-circuit/join paths,
    # so it must be conditional on the admission state rather than a flat False.
    analyze = list(metered_kw(session_routes, "chat_jobs", "start_turn"))
    assert len(analyze) == 1, "expected exactly the auto-analyze hook to state its metering"
    assert not isinstance(analyze[0], ast.Constant), (
        "a flat metered=False here is the bypass: an already-retrieved paper reaches this on the "
        "request thread with no admission, making the turn free"
    )


def test_an_in_flight_admission_counts_before_its_worker_is_published(monkeypatch):
    """The `_admitting` half of the count, which the suite previously never exercised.

    Every other test inspects the count only once a worker is running. Deleting the admission
    half of `active_count_for_user` therefore left the whole suite green — so the property that
    a burst of concurrent starts cannot each undercount the others was unverified.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "50")
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    in_prepare = threading.Event()
    hold = threading.Event()
    refused: list[BaseException] = []

    def slow_prepare(_job):
        # Inside preparation the admission marker exists but no worker is published yet.
        in_prepare.set()
        hold.wait(5)
        return None

    def first():
        token = _as(ALICE)
        try:
            reg.start_or_join(
                "k1", lambda: SampleJob(id=new_id()), lambda j: None, prepare_new=slow_prepare,
            )
        finally:
            config.reset_active_user(token)

    t = threading.Thread(target=first)
    t.start()
    try:
        assert in_prepare.wait(5), "preparation never started"
        token = _as(ALICE)
        try:
            assert jobs.active_count_for_user(ALICE) == 1, "pending admission was not counted"
            with pytest.raises(rate_limits.RateLimited) as err:
                reg.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: None)
            refused.append(err.value)
        finally:
            config.reset_active_user(token)
    finally:
        hold.set()
        t.join(5)
    assert refused, "a second start during preparation should have been refused"


def test_a_wedged_worker_stops_holding_a_slot_so_one_hang_is_not_an_account_lockout(monkeypatch):
    """Cancellation is cooperative, so a job wedged with no checkpoint never releases.

    Without a staleness bound, one hang would consume an account-wide slot until process restart,
    locking that person out of chat, notes, retrieval, audio, discovery, graph, labs and profiles
    at once. Blocking a paying user is worse than a mild overspend, so this fails open.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "50")
    release = threading.Event()
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        wedged = reg.start_or_join(
            "k1", lambda: SampleJob(id=new_id()), lambda j: release.wait(10),
        )
        assert jobs.active_count_for_user(ALICE) == 1
        with pytest.raises(rate_limits.RateLimited):
            reg.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: None)

        # Age it past the bound. The worker is still running and still metered for spend.
        setattr(
            wedged, jobs._STARTED_MONO_ATTR,
            time.monotonic() - jobs._STUCK_AFTER_SECONDS - 1,
        )
        assert jobs.active_count_for_user(ALICE) == 0
        freed = reg.start_or_join("k3", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, freed.id)
        assert jobs._worker_is_active(wedged), "the wedged worker must still be running"
    finally:
        release.set()
        config.reset_active_user(token)


def test_a_job_without_a_monotonic_stamp_is_never_treated_as_stuck():
    """Absence of evidence must not silently free a slot."""
    job = SampleJob(id=new_id())
    assert not jobs._is_stuck(job, cutoff=time.monotonic())


def test_auto_analyze_on_an_already_retrieved_paper_is_still_metered(monkeypatch, temp_project):
    """The bypass the re-review found, pinned end to end at the real seam.

    `start_retrieval` short-circuits an already-retrieved paper through `put()` — a terminal job
    with no worker and, crucially, no admission — and then kicks the analysis hook inline on the
    request thread. The first fix passed a blanket `metered=False` there on the reasoning that the
    hook "runs inside the retrieval worker", which is only true on the other branch. The result
    was that `auto_analyze` on any already-retrieved paper bought an unmetered LLM turn, and in
    listening mode an unmetered narration with it. Already-retrieved is the common case after a
    project split or copy, since corpus files transfer but session state does not.
    """
    from app import retrieval_jobs

    from tests.conftest import add_paper

    add_paper(temp_project, "p1", "Paper One")  # corpus present -> retrieved
    seen: list[bool] = []
    retrieval_jobs.start_retrieval(
        "p1", after_retrieved=lambda _job, **kw: seen.append(kw["admitted"]),
    )
    assert seen == [False], "a free cache hit must not mark the turn it kicks as already admitted"


def test_joining_an_in_flight_retrieval_does_not_buy_a_free_analysis_turn(temp_project):
    """The third bypass, and the one that showed the whole approach was wrong.

    `_after_retrieved` is a single slot on the job. A second request can join a retrieval that is
    still running — joining is deliberately free, it never reaches the rate check — attach its own
    auto-analyze hook, and then the CREATOR's worker runs that hook when it finishes. Deciding
    metering per call site ("this fires from a worker, so a worker admitted it") reads the
    creator's payment as covering the joiner's turn. One admission bought a retrieval plus a full
    chat turn, plus narration in listening mode.

    So admission is now bound to the ATTACHMENT rather than to the thread that runs it, which
    removes the class of bug rather than this instance: there is no longer a call site that can
    forget, because no call site decides.

    Note what made this hard to see: the first repro of it put the creator in a bare thread, which
    does not inherit the active-project contextvar (invariant 2), so the "joiner" resolved a
    different scope and quietly created its own job instead of joining. Binding the project in the
    creating thread is what makes this a real join.
    """
    import threading

    from app import config, retrieval_jobs, store

    store.add_entry(title="Paper One", group="G")
    slug = store.list_papers()[0].slug
    seen: list[bool] = []
    gate = threading.Event()

    def slow_retrieve(_title, _aid, _url):
        gate.wait(5)
        return {"full_text": "text", "arxiv_id": None, "source": "s"}

    def creator():
        token = config.set_active_project(temp_project)
        try:
            retrieval_jobs.start_retrieval(slug, retrieve_fn=slow_retrieve)
        finally:
            config.reset_active_project(token)

    thread = threading.Thread(target=creator)
    thread.start()
    try:
        time.sleep(0.4)  # let the creator publish its worker and block in retrieval
        # The joiner: pays nothing, attaches auto-analyze to the in-flight job.
        retrieval_jobs.start_retrieval(
            slug,
            retrieve_fn=slow_retrieve,
            after_retrieved=lambda _job, **kw: seen.append(kw["admitted"]),
        )
    finally:
        gate.set()
        thread.join(5)
    deadline = time.time() + 5
    while not seen and time.time() < deadline:
        time.sleep(0.02)

    assert seen == [False], (
        "a request that joined an in-flight retrieval paid no admission, so the analysis turn it "
        f"attaches must be metered; got admitted={seen}"
    )


def test_an_unstamped_hook_is_treated_as_unpaid(temp_project):
    """Absence of evidence must not grant free spend.

    Nothing should reach `_run_analysis_hook` without a stamp — `_attach_hook` writes both fields
    together — but the default decides what happens if a future caller sets `_after_retrieved`
    directly. Unmetered spend cannot be recovered; a wrongly metered turn is at worst a refusal
    the reader retries.
    """
    from app import retrieval_jobs, store

    store.add_entry(title="Paper One", group="G")
    slug = store.list_papers()[0].slug
    seen: list[bool] = []
    job = retrieval_jobs.RetrievalJob(id="j1", slug=slug, status="done", retrieved=True)
    job._after_retrieved = lambda _j, **kw: seen.append(kw["admitted"])  # no stamp, on purpose
    retrieval_jobs._run_analysis_hook(job)
    assert seen == [False]
