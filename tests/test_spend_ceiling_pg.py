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

import pytest
from app import config, db, quotas, spend_ceiling, spend_limits, tenancy

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run this")

ALICE = "11111111-1111-4111-8111-111111111111"
PID = "proj-ceiling"


@pytest.fixture
def database(monkeypatch):
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    with db.pool().connection() as conn:
        conn.execute(
            "drop table if exists rc_usage_reservation_attempts, rc_usage_reservations, "
            "rc_usage_events, rc_content_reports, rc_account_deletions, rc_project_trash, "
            "rc_user_settings, rc_projects, rc_users, rc_schema_migrations cascade",
        )
    db.migrate()
    tenancy.ensure_user(ALICE, "alice@example.com")
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
