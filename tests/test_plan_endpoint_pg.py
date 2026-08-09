"""`GET /api/plan` and the ledger read behind it, against a real database.

The whole surface shipped with no test, which is how it came to report a limit that was not the
enforced one. The two properties that matter here cannot be checked without Postgres: that the
query is scoped to the caller, and that its numbers agree with the refusal a reader gets at the
same instant. A display that contradicts the refusal beside it is worse than no display.
"""
from __future__ import annotations

import os
import uuid

import pytest
from app import config, db, plans, quotas, spend_ceiling, spend_limits, tenancy

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run this")

ALICE = ""
BOB = ""
PID = ""
BOB_PID = ""


@pytest.fixture
def database(monkeypatch):
    """A fresh account per test — the ledger is append-like by design (migration 0008's triggers
    refuse row deletion), so isolation comes from never reusing an identity."""
    global ALICE, BOB, PID, BOB_PID
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    db.migrate()
    ALICE, BOB = str(uuid.uuid4()), str(uuid.uuid4())
    PID = f"proj-plan-{uuid.uuid4().hex[:8]}"
    BOB_PID = f"proj-bob-{uuid.uuid4().hex[:8]}"
    for uid in (ALICE, BOB):
        tenancy.ensure_user(uid, f"{uid}@example.com")
    # Each owns their own: `quotas.reserve` locks the project row as ownership proof, so Bob
    # reserving against Alice's project is refused before it can prove anything about scoping.
    tenancy.record_project(PID, ALICE)
    tenancy.record_project(BOB_PID, BOB)
    token_u = config.set_active_user(ALICE)
    token_p = config.set_active_project(PID)
    yield
    config.reset_active_project(token_p)
    config.reset_active_user(token_u)
    db.close()


@needs_pg
def test_period_usage_is_scoped_to_the_caller(database):
    """`app/tenancy.py`'s rule — a route naming a user outside the URL path gets nothing for free —
    applies to this QUERY. One careless `where` clause turns a usage display into a leak."""
    held = spend_ceiling.hold("analysis", "alice-job")
    held.add(30_000_000)
    spend_ceiling.settle(held)

    bob_token = config.set_active_user(BOB)
    bob_project = config.set_active_project(BOB_PID)
    try:
        bob_held = spend_ceiling.hold("analysis", "bob-job")
        bob_held.add(999_000_000)
        spend_ceiling.settle(bob_held)
    finally:
        config.reset_active_project(bob_project)
        config.reset_active_user(bob_token)

    spent, _held = quotas.period_usage(ALICE)
    assert spent == 30_000_000, "another account's spend must not appear in this one's total"


@needs_pg
def test_the_reported_usage_agrees_with_the_refusal_a_reader_gets(database, monkeypatch):
    """Asserted as a PROPERTY rather than two literals: the endpoint's numbers and the exception's
    must be the same numbers, whatever they happen to be. This is the check that fails if either
    side's period boundary, state filter or override handling drifts."""
    monkeypatch.setattr(spend_limits, "monthly_limit_nanousd", lambda: 400_000_000)
    held = spend_ceiling.hold("analysis", "job-1")
    held.add(150_000_000)
    spend_ceiling.settle(held)

    live = spend_ceiling.hold("analysis", "job-2")   # outstanding, not yet settled
    spent, outstanding = quotas.period_usage(ALICE)

    with pytest.raises(quotas.QuotaExceeded) as err:
        spend_ceiling.hold("analysis", "job-3")
    assert err.value.used_nanousd == spent + outstanding, (
        "the display and the refusal must be computed from the same ledger state"
    )
    assert err.value.settled_nanousd == spent
    spend_ceiling.settle(live)


@needs_pg
def test_a_failed_ledger_read_reports_unknown_rather_than_zero(database, monkeypatch):
    """Zero would tell a reader their whole allowance is intact at the exact moment every job is
    failing closed — the most misleading pair the endpoint could send."""
    def boom():
        raise RuntimeError("database is unhappy")

    monkeypatch.setattr(db, "pool", boom)
    assert quotas.period_usage(ALICE) is None


def test_the_endpoint_reports_the_limit_that_is_actually_enforced(monkeypatch):
    """The P1 this file exists for.

    Enforcement applies the `RC_MONTHLY_CREDITS` override; the endpoint originally read the plan's
    headline number instead. Production has that override set, so production was exactly the
    deployment where the screen and the refusal would disagree.
    """
    from app.routers import usage as usage_routes

    monkeypatch.setenv("RC_MONTHLY_CREDITS", "750")

    class _Req:
        state = type("S", (), {"user": {"user_id": None}})()

    body = usage_routes.get_plan(_Req())
    assert body["limit_nanousd"] == spend_limits.monthly_limit_nanousd()
    assert body["limit_nanousd"] == 750 * spend_limits.NANOUSD_PER_CREDIT, (
        "the override must win in the display exactly as it wins in admission"
    )
    assert body["limit_nanousd"] != (
        plans.for_user(None).monthly_credits * spend_limits.NANOUSD_PER_CREDIT
    ), "this is the divergence the test exists to catch"


def test_the_warning_can_actually_precede_a_refusal(monkeypatch):
    """Computed from spend alone it could not fire in the case that matters: a reader at 76% spend
    with one listening flow in flight is refused, while a spend-only warning stays silent."""
    from app.routers import usage as usage_routes

    monkeypatch.setenv("RC_MONTHLY_CREDITS", "2500")
    monkeypatch.setattr(usage_routes.quotas, "period_usage",
                        lambda _uid: (1_900_000_000, 810_000_000))
    monkeypatch.setattr(usage_routes.spend_limits, "enabled", lambda: True)

    class _Req:
        state = type("S", (), {"user": {"user_id": "u1"}})()

    body = usage_routes.get_plan(_Req())
    assert body["spent_fraction"] < spend_limits.SOFT_WARNING_AT, "spend alone is still under 80%"
    assert body["warn"] is True, "but holds put the account past the line, so it must warn"
    assert body["at_capacity"] is True


def test_a_real_charge_never_arrives_as_exactly_zero_or_exactly_one(monkeypatch):
    """Rounding `spent_fraction` to four places erased the two cases the client works hardest to
    render honestly: a small real charge became 0.0 and a hair under the limit became 1.0, so the
    screen said "0%" or "100%" — the exact false claims its `<1%`/`>99%` labels exist to avoid."""
    from app.routers import usage as usage_routes

    monkeypatch.setenv("RC_MONTHLY_CREDITS", "2500")
    monkeypatch.setattr(usage_routes.spend_limits, "enabled", lambda: True)

    class _Req:
        state = type("S", (), {"user": {"user_id": "u1"}})()

    limit = spend_limits.monthly_limit_nanousd()
    for spent in (1, 37, limit - 1):
        monkeypatch.setattr(usage_routes.quotas, "period_usage", lambda _uid, s=spent: (s, 0))
        fraction = usage_routes.get_plan(_Req())["spent_fraction"]
        assert 0 < fraction < 1, (
            f"{spent} nano-USD of {limit} must not collapse to a boundary, got {fraction}"
        )
