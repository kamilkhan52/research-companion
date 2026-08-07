"""The spend ceiling against a REAL ledger.

`tests/test_spend_ceiling.py` stubs `quotas.reserve/settle/release`, so it asserts what the
registry asks the ledger to do and never whether the ledger would accept it. That gap shipped a
version in which settlement could not land at all: `quotas.settle` refuses a reservation that was
never marked dispatched, every settle raised `ReservationConflict`, the error was swallowed as a
warning, and holds simply expired — contributing nothing to the monthly total the ceiling is
supposed to bound. Every test was green.

These run only with `RC_TEST_DATABASE_URL` set (CI always sets it).
"""
from __future__ import annotations

import os
import uuid

import pytest
from app import config, db, quotas, spend_ceiling, spend_limits, tenancy

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run this")

#: A fresh account and project per test. The reservation ledger is deliberately append-like —
#: migration 0008's triggers refuse to delete attempt rows except through an account cascade — so
#: isolation comes from never reusing an identity rather than from cleaning up after one. That
#: also means this file never drops tables: doing so mid-suite pulled the schema out from under
#: other database-backed tests ("relation rc_users does not exist").
ALICE = ""
PID = ""


@pytest.fixture
def database(monkeypatch):
    global ALICE, PID
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    db.migrate()
    ALICE = str(uuid.uuid4())
    PID = f"proj-ceiling-{uuid.uuid4().hex[:8]}"
    tenancy.ensure_user(ALICE, f"{ALICE}@example.com")
    tenancy.record_project(PID, ALICE)
    token_u = config.set_active_user(ALICE)
    token_p = config.set_active_project(PID)
    yield
    config.reset_active_project(token_p)
    config.reset_active_user(token_u)
    db.close()


@needs_pg
def test_settlement_actually_lands_and_charges_the_real_amount(database):
    """The one the stubbed suite could not see."""
    held = spend_ceiling.hold("analysis", "job-1")
    assert held is not None
    held.add(2_000_000)  # $0.002
    spend_ceiling.settle(held)

    row = quotas.get(held.reservation_id, user_id=ALICE)
    assert row.state == "settled", f"settle did not land: {row.state}"
    assert row.actual_nanousd == 2_000_000
    assert row.actual_nanousd < row.reserved_nanousd, "the unspent remainder must go back"


@needs_pg
def test_settled_spend_counts_toward_the_monthly_ceiling(database, monkeypatch):
    """What makes it a MONTHLY ceiling rather than an hourly one.

    An unsettled hold expires and contributes zero to the month's total, so an account could
    spend without limit as long as no single hour exceeded the hold budget.
    """
    monkeypatch.setattr(spend_limits, "monthly_limit_nanousd", lambda: 200_000_000)
    first = spend_ceiling.hold("analysis", "job-1")
    first.add(190_000_000)
    spend_ceiling.settle(first)

    # 90,000 of a 100,000 ceiling is now spent, so an 80,000 hold cannot fit.
    with pytest.raises(quotas.QuotaExceeded) as err:
        spend_ceiling.hold("analysis", "job-2")
    assert err.value.used_nanousd >= 190_000_000, "settled spend was not counted against the month"


@needs_pg
def test_a_second_job_with_the_same_id_can_still_reserve(database):
    """Graph builds reuse the project id as the job id, forever.

    A reservation key derived from the job id alone is finalized after the first build, and every
    later build raised ReservationConflict — which no handler maps, so it surfaced as a 500.
    """
    first = spend_ceiling.hold("analysis", PID)
    spend_ceiling.settle(first)
    second = spend_ceiling.hold("analysis", PID)   # must not raise
    assert second.reservation_id != first.reservation_id
    spend_ceiling.settle(second)


@needs_pg
def test_a_job_that_spends_nothing_settles_at_zero(database):
    held = spend_ceiling.hold("analysis", "job-quiet")
    spend_ceiling.settle(held)
    row = quotas.get(held.reservation_id, user_id=ALICE)
    assert row.state == "settled" and row.actual_nanousd == 0


@needs_pg
def test_being_out_of_budget_refuses_the_next_admission(database, monkeypatch):
    monkeypatch.setattr(spend_limits, "monthly_limit_nanousd", lambda: 200_000_000)
    held = spend_ceiling.hold("analysis", "job-1")
    held.add(200_000_000)
    spend_ceiling.settle(held)
    with pytest.raises(quotas.QuotaExceeded):
        spend_ceiling.hold("analysis", "job-2")


@needs_pg
def test_a_burst_of_holds_reports_as_transient_not_as_monthly_exhaustion(database, monkeypatch):
    """The overcorrection: pessimistic holds are several times the measured cost, so ordinary
    concurrent reading collides long before real spend does. Reporting that as "your monthly limit
    is reached, try again after it resets" points someone who has spent nothing a month away from
    a wait of seconds.
    """
    # $1.00 ceiling: the blocked request ($0.60 of speech) fits on its own, so what refuses it is
    # purely this account's own outstanding holds. A request that could NEVER fit is a different
    # thing and is correctly not transient.
    monkeypatch.setattr(spend_limits, "monthly_limit_nanousd", lambda: 1_000_000_000)
    live = [spend_ceiling.hold("analysis", f"job-{i}") for i in range(3)]  # $0.45 held, $0 spent
    with pytest.raises(quotas.QuotaExceeded) as err:
        spend_ceiling.hold("speech_synthesis", "job-audio")
    assert err.value.settled_nanousd == 0, "nothing has actually been spent"
    assert err.value.is_transient, "a hold collision must not read as exhaustion"
    for held in live:
        spend_ceiling.settle(held)


@needs_pg
def test_real_exhaustion_is_not_reported_as_transient(database, monkeypatch):
    """And the opposite: money genuinely spent does NOT come back until the period rolls over."""
    monkeypatch.setattr(spend_limits, "monthly_limit_nanousd", lambda: 200_000_000)
    held = spend_ceiling.hold("analysis", "job-1")
    held.add(195_000_000)
    spend_ceiling.settle(held)
    with pytest.raises(quotas.QuotaExceeded) as err:
        spend_ceiling.hold("analysis", "job-2")
    assert err.value.settled_nanousd >= 195_000_000
    assert not err.value.is_transient


@needs_pg
def test_a_build_is_admitted_on_a_nominal_ticket_and_gated_paper_by_paper(database):
    """The build's own hold is only an admission ticket now.

    A corpus-sized hold refused every build past a couple of dozen papers; a capped one let an
    unbounded over-run through. Neither is needed: every paper takes its own `graph_extraction`
    hold through `paper-references`, so the build is gated where the money is actually spent and
    stops at a paper boundary with everything so far cached.
    """
    held = spend_ceiling.hold("graph_build", PID)
    assert held is not None, "a build of any size must be admitted"
    assert quotas.get(held.reservation_id, user_id=ALICE).reserved_nanousd < 100_000_000, (
        "the build's own ticket must stay nominal — it spends nothing on its own thread"
    )
    spend_ceiling.settle(held)

@needs_pg
def test_an_aborted_admission_gives_its_hold_back(database):
    """`quotas.release` refuses a dispatched reservation, and `hold` always dispatches — so the
    rollback path was a silent no-op and an aborted admission held its full maximum for the whole
    lease, then was charged at that maximum by the reconciler."""
    held = spend_ceiling.hold("analysis", "job-aborted")
    spend_ceiling.release(held)
    row = quotas.get(held.reservation_id, user_id=ALICE)
    assert row.state == "settled" and row.actual_nanousd == 0, (
        f"rollback left the hold outstanding: state={row.state}"
    )




@needs_pg
def test_a_pool_thread_without_the_user_bound_still_holds_budget(database):
    """The P0 the mocked suite structurally could not see.

    `spend_limits.enabled()` requires BOTH a database and a signed-in user. A graph build's
    fan-out pool inherits no contextvars, and `run_one` bound the project and the reservation but
    not the user — so on that thread `enabled()` read False, `hold()` returned None, and because
    the registry now takes the `reserves` branch it did not inherit the parent's hold either.
    Every paper's extraction spend landed nowhere and a whole build settled at $0.

    The mocked suite patches `spend_limits.enabled` to True outright, which is exactly why it
    could not express this. This drives the real gate.
    """
    import threading

    from app import config, spend_limits

    seen: list[bool] = []

    def on_pool_thread():
        # Precisely what `config.bound_scope(pid, uid, held)` must restore, and what binding a
        # subset silently loses.
        with config.bound_scope(PID, ALICE, None):
            seen.append(spend_limits.enabled())

    thread = threading.Thread(target=on_pool_thread)
    thread.start()
    thread.join(5)
    assert seen == [True], "a worker that rebinds project+user must be able to take a hold"

    # And the failure mode itself: user missing -> the ceiling silently goes inert.
    inert: list[bool] = []

    def without_user():
        with config.bound_scope(PID, None, None):
            inert.append(spend_limits.enabled())

    thread = threading.Thread(target=without_user)
    thread.start()
    thread.join(5)
    assert inert == [False], (
        "this is the trap: no user means no ceiling, so a worker binding a subset of the "
        "contextvars disables the ceiling rather than failing loudly"
    )


@needs_pg
def test_the_graph_fan_out_binds_all_three_contextvars(database):
    """Pin the call site, not just the helper.

    `graph.run_one` and `extract_references_for_paper._do_extract` must go through
    `config.bound_scope`, which takes project, user and reservation together. Rebinding a subset
    by hand is what broke this twice.
    """
    import ast
    import inspect

    from app import graph

    tree = ast.parse(inspect.getsource(graph))
    bound_scope_calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "bound_scope"
    ]
    assert len(bound_scope_calls) >= 2, (
        "both graph pools must rebind through bound_scope; found "
        f"{len(bound_scope_calls)}"
    )
    for call in bound_scope_calls:
        assert len(call.args) == 3, (
            "bound_scope must be given project, user AND reservation — passing a subset is how "
            "the ceiling went inert on the fan-out thread"
        )
        # Each must be a captured variable, not a literal. Counting arguments alone passed when
        # the user slot was `None`, which is precisely the bug: a hard-coded None there disables
        # the ceiling on that thread just as effectively as omitting the argument.
        assert all(isinstance(arg, ast.Name) for arg in call.args), (
            "every argument must be a value captured on the calling thread; a literal (usually "
            f"None) in one of these slots silently disables the ceiling: {ast.dump(call)[:200]}"
        )
