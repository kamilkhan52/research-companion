"""SCRATCH — review-only probes. Deleted after the pass."""
from __future__ import annotations

import logging
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


def _totals():
    with db.pool().connection() as conn:
        rows = conn.execute(
            "select id::text, state, reserved_nanousd, actual_nanousd, operation "
            "from rc_usage_reservations where user_id = %s order by created_at",
            (ALICE,),
        ).fetchall()
    return rows


@needs_pg
def test_A_worker_settle_after_a_refused_checkpoint(database, monkeypatch, caplog):
    """checkpoint's reserve raises -> old tranche settled, held still points at it.
    What does _run's finally-settle then do?"""
    monkeypatch.setattr(spend_limits, "monthly_limit_nanousd", lambda: 600_000_000)
    held = spend_ceiling.hold(
        "graph_build", PID, maximum_nanousd=spend_limits.graph_tranche_nanousd())
    token = spend_ceiling.bind(held)
    try:
        held.add(550_000_000)
        with pytest.raises(quotas.QuotaExceeded):
            spend_ceiling.checkpoint(spend_limits.graph_tranche_nanousd())
        # STRAGGLER: a pool thread that was still running finishes and records spend.
        held.add(7_000_000)
    finally:
        spend_ceiling.reset(token)

    with caplog.at_level(logging.DEBUG):
        spend_ceiling.settle(held)          # exactly what JobRegistry._run's finally does
    print("\n--- A: rows after refused checkpoint + worker settle ---")
    for r in _totals():
        print("   ", r)
    print("--- A: log records ---")
    for rec in caplog.records:
        print("   ", rec.levelname, rec.name, rec.getMessage())
    rows = _totals()
    assert len(rows) == 1
    assert rows[0][1] == "settled"
    print("A: total charged =", rows[0][3], "of real spend", 550_000_000 + 7_000_000)


@needs_pg
def test_B_begin_attempt_fails_after_reserve_succeeds(database, monkeypatch):
    """What state is left when the SECOND half of the rotation fails?"""
    held = spend_ceiling.hold(
        "graph_build", PID, maximum_nanousd=spend_limits.graph_tranche_nanousd())
    first = held.reservation_id
    real_begin = quotas.begin_attempt
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        raise quotas.QuotaUnavailable("simulated ledger blip")

    token = spend_ceiling.bind(held)
    try:
        held.add(100_000_000)
        monkeypatch.setattr(quotas, "begin_attempt", flaky)
        with pytest.raises(quotas.QuotaUnavailable):
            spend_ceiling.checkpoint(spend_limits.graph_tranche_nanousd())
        monkeypatch.setattr(quotas, "begin_attempt", real_begin)
    finally:
        spend_ceiling.reset(token)
    print("\n--- B: rows after begin_attempt failure ---")
    for r in _totals():
        print("   ", r)
    print("B: held.reservation_id ==", "OLD" if held.reservation_id == first else "NEW")
    spend_ceiling.settle(held)
    print("--- B: rows after the worker's settle ---")
    for r in _totals():
        print("   ", r)


@needs_pg
def test_C_straggler_spend_across_a_clean_rotation(database):
    """note_spend on a pool thread landing DURING the rotation: lost or double-charged?"""
    held = spend_ceiling.hold(
        "graph_build", PID, maximum_nanousd=spend_limits.graph_tranche_nanousd())
    token = spend_ceiling.bind(held)
    real_reserve = quotas.reserve

    def reserve_with_concurrent_spend(*a, **k):
        held.add(3_000_000)      # a pool thread finishes mid-rotation
        return real_reserve(*a, **k)

    try:
        held.add(100_000_000)
        import unittest.mock as m
        with m.patch.object(quotas, "reserve", reserve_with_concurrent_spend):
            spend_ceiling.checkpoint(spend_limits.graph_tranche_nanousd())
        held.add(5_000_000)
        spend_ceiling.settle(held)
    finally:
        spend_ceiling.reset(token)
    rows = _totals()
    print("\n--- C: rows ---")
    for r in rows:
        print("   ", r)
    total = sum(int(r[3] or 0) for r in rows)
    print("C: charged", total, "real spend", 108_000_000)
    assert total == 108_000_000, f"straggler lost/doubled: {total}"


@needs_pg
def test_D_is_transient_for_a_midbuild_refusal(database, monkeypatch):
    """Does a mid-build checkpoint refusal caused purely by OTHER live holds read as transient,
    and does anything downstream act on that?"""
    monkeypatch.setattr(spend_limits, "monthly_limit_nanousd", lambda: 1_500_000_000)
    other = spend_ceiling.hold("speech_synthesis", "job-audio")   # $0.60 hold, $0 spent
    held = spend_ceiling.hold(
        "graph_build", PID, maximum_nanousd=spend_limits.graph_tranche_nanousd())
    token = spend_ceiling.bind(held)
    try:
        held.add(450_000_000)
        with pytest.raises(quotas.QuotaExceeded) as err:
            spend_ceiling.checkpoint(spend_limits.graph_tranche_nanousd())
    finally:
        spend_ceiling.reset(token)
    print("\n--- D ---")
    print("   is_transient =", err.value.is_transient)
    print("   message the reader sees =", str(err.value))
    print("   settled =", err.value.settled_nanousd, "used =", err.value.used_nanousd)
    spend_ceiling.settle(other)
