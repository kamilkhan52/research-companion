"""Durable quota reservations: concurrency, ownership, idempotency, and crash states."""
from __future__ import annotations

import os
import threading
from datetime import UTC, datetime

import psycopg
import pytest
from app import db, quotas, tenancy

ALICE = "a3f0c8de-4b21-4d77-9f0e-2b6c5d1a7e44"
BOB = "b71e2c94-8d3a-4e15-bb27-5c9f0a2d6e83"
TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run this")


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
    yield
    db.close()


def _own(pid: str, user_id: str = ALICE) -> None:
    tenancy.ensure_user(user_id)
    tenancy.record_project(pid, user_id)


def _args(
    pid: str | None,
    *,
    user_id: str = ALICE,
    key: str = "job-1:openrouter",
    job_id: str = "job-1",
    maximum: int = 60,
    limit: int = 100,
) -> dict:
    return {
        "user_id": user_id,
        "project_id": pid,
        "reservation_key": key,
        "job_id": job_id,
        "provider": "openrouter",
        "operation": "analysis",
        "model": "anthropic/claude-test",
        "maximum_cost_nanousd": maximum,
        "limit_nanousd": limit,
        "lease_seconds": 60,
    }


def _make_lease_stale(reservation_id: str) -> None:
    """Age a row without sleeping while preserving the schema's lease-after-create invariant."""
    with db.pool().connection() as conn:
        conn.execute(
            "update rc_usage_reservations "
            "set created_at = created_at - interval '2 minutes', "
            "lease_expires_at = now() - interval '1 second' where id = %s",
            (reservation_id,),
        )


def test_reservations_fail_closed_without_postgres(monkeypatch):
    monkeypatch.delenv("RC_DATABASE_URL", raising=False)
    db.close()
    with pytest.raises(quotas.QuotaUnavailable, match="temporarily unavailable"):
        quotas.reserve(**_args("project"))


@needs_pg
def test_concurrent_admission_cannot_collectively_exceed_the_ceiling(database, temp_project):
    _own(temp_project)
    barrier = threading.Barrier(2)
    admitted: list[quotas.Reservation] = []
    refused: list[Exception] = []

    def attempt(index: int) -> None:
        barrier.wait(timeout=10)
        try:
            admitted.append(quotas.reserve(**_args(
                temp_project,
                key=f"job-{index}:openrouter",
                job_id=f"job-{index}",
            )))
        except Exception as exc:  # captured for exact type assertion on the caller thread
            refused.append(exc)

    threads = [threading.Thread(target=attempt, args=(index,)) for index in (1, 2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)

    assert all(not thread.is_alive() for thread in threads)
    assert len(admitted) == 1
    assert len(refused) == 1
    assert isinstance(refused[0], quotas.QuotaExceeded)
    with db.pool().connection() as conn:
        total = conn.execute(
            "select sum(reserved_nanousd) from rc_usage_reservations where state = 'reserved'",
        ).fetchone()[0]
    assert total == 60


@needs_pg
def test_retry_key_is_idempotent_but_cannot_be_reused_for_different_work(
    database, temp_project
):
    _own(temp_project)
    first = quotas.reserve(**_args(temp_project))
    retry = quotas.reserve(**_args(temp_project))
    assert retry == first
    with pytest.raises(quotas.ReservationConflict, match="does not match"):
        quotas.reserve(**_args(temp_project, maximum=50))
    with db.pool().connection() as conn:
        assert conn.execute("select count(*) from rc_usage_reservations").fetchone()[0] == 1


@needs_pg
def test_foreign_or_retired_project_cannot_receive_a_reservation(database, temp_project):
    _own(temp_project, ALICE)
    tenancy.ensure_user(BOB)
    with pytest.raises(quotas.ReservationConflict, match="no longer available"):
        quotas.reserve(**_args(temp_project, user_id=BOB))

    historical = quotas.reserve(**_args(temp_project))
    trash_name = f"{temp_project}-20260731-230000"
    assert tenancy.release(temp_project, trash_name) == ALICE
    with db.pool().connection() as conn:
        retained = conn.execute(
            "select user_id::text, project_id from rc_usage_reservations where id = %s",
            (historical.id,),
        ).fetchone()
    assert retained == (ALICE, temp_project)
    with pytest.raises(quotas.ReservationConflict, match="no longer available"):
        quotas.reserve(**_args(
            temp_project,
            key="job-retired:openrouter",
            job_id="job-retired",
        ))


@needs_pg
def test_settlement_replaces_the_maximum_with_actual_cost_for_future_admission(
    database, temp_project
):
    _own(temp_project)
    first = quotas.reserve(**_args(temp_project, maximum=60))
    attempt, should_dispatch = quotas.begin_attempt(
        first.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    assert should_dispatch is True
    with pytest.raises(quotas.ReservationConflict, match="fully resolved"):
        quotas.mark_dispatches_complete(first.id, user_id=ALICE)
    with pytest.raises(quotas.ReservationConflict, match="complete provider-dispatch"):
        quotas.settle(first.id, user_id=ALICE, actual_nanousd=20)
    resolved_attempt = quotas.resolve_attempt(
        attempt.id,
        user_id=ALICE,
        actual_nanousd=20,
        generation_id="gen-settle",
    )
    assert resolved_attempt.state == "resolved"
    completed = quotas.mark_dispatches_complete(first.id, user_id=ALICE)
    assert completed.dispatches_complete_at is not None
    with pytest.raises(quotas.ReservationConflict, match="already complete"):
        quotas.begin_attempt(
            first.id,
            user_id=ALICE,
            attempt_key="request-2",
            maximum_cost_nanousd=1,
        )
    with pytest.raises(quotas.ReservationConflict, match="does not match"):
        quotas.settle(first.id, user_id=ALICE, actual_nanousd=19)
    settled = quotas.settle(first.id, user_id=ALICE, actual_nanousd=20)
    assert settled.state == "settled"
    assert settled.actual_nanousd == 20
    assert settled.settlement_kind == "exact"
    assert quotas.settle(first.id, user_id=ALICE, actual_nanousd=20) == settled
    with pytest.raises(quotas.ReservationConflict, match="differently"):
        quotas.settle(first.id, user_id=ALICE, actual_nanousd=21)
    with pytest.raises(quotas.ReservationConflict, match="already finalized"):
        quotas.reserve(**_args(temp_project, maximum=60))

    second = quotas.reserve(**_args(
        temp_project,
        key="job-2:openrouter",
        job_id="job-2",
        maximum=80,
    ))
    assert second.state == "reserved"
    with pytest.raises(quotas.QuotaExceeded):
        quotas.reserve(**_args(
            temp_project,
            key="job-3:openrouter",
            job_id="job-3",
            maximum=1,
        ))


@needs_pg
def test_undispatched_lease_can_expire_and_release_its_capacity(database, temp_project):
    _own(temp_project)
    reservation = quotas.reserve(**_args(temp_project))
    _make_lease_stale(reservation.id)
    with pytest.raises(quotas.ReservationConflict, match="lease has expired"):
        quotas.renew(reservation.id, user_id=ALICE, lease_seconds=60)
    with pytest.raises(quotas.ReservationConflict, match="lease has expired"):
        quotas.begin_attempt(
            reservation.id,
            user_id=ALICE,
            attempt_key="late-attempt",
            maximum_cost_nanousd=60,
        )
    assert quotas.expire_undispatched() == 1
    assert quotas.get(reservation.id, user_id=ALICE).state == "expired"

    replacement = quotas.reserve(**_args(
        temp_project,
        key="job-replacement:openrouter",
        job_id="job-replacement",
        maximum=100,
    ))
    assert replacement.state == "reserved"


@needs_pg
def test_possibly_billed_lease_never_releases_and_conservatively_settles(
    database, temp_project
):
    _own(temp_project)
    reservation = quotas.reserve(**_args(temp_project))
    attempt, should_dispatch = quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    assert should_dispatch is True
    dispatched = quotas.get(reservation.id, user_id=ALICE)
    assert dispatched.dispatched_at is not None
    with pytest.raises(quotas.ReservationConflict, match="must be settled"):
        quotas.release(reservation.id, user_id=ALICE)
    _make_lease_stale(reservation.id)

    assert quotas.expire_undispatched() == 0
    assert [row.id for row in quotas.stale_dispatched()] == [reservation.id]
    settled = quotas.settle_conservatively(reservation.id, user_id=ALICE)
    assert settled.state == "settled"
    assert settled.actual_nanousd == reservation.reserved_nanousd
    assert settled.settlement_kind == "conservative"


@needs_pg
def test_a_conservative_attempt_cannot_make_the_parent_look_exact(database, temp_project):
    _own(temp_project)
    reservation = quotas.reserve(**_args(temp_project))
    attempt, _ = quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    quotas.resolve_attempt(
        attempt.id,
        user_id=ALICE,
        actual_nanousd=60,
        kind="conservative",
    )
    quotas.mark_dispatches_complete(reservation.id, user_id=ALICE)
    with pytest.raises(quotas.ReservationConflict, match="exact provider attempts"):
        quotas.settle(reservation.id, user_id=ALICE, actual_nanousd=60)
    settled = quotas.settle_conservatively(reservation.id, user_id=ALICE)
    assert settled.settlement_kind == "conservative"


@needs_pg
def test_dispatch_attempts_are_bounded_idempotent_and_generations_globally_unique(
    database, temp_project
):
    _own(temp_project)
    first = quotas.reserve(**_args(temp_project))
    second = quotas.reserve(**_args(
        temp_project,
        key="job-2:openrouter",
        job_id="job-2",
        maximum=40,
    ))
    first_attempt, should_dispatch = quotas.begin_attempt(
        first.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    assert should_dispatch is True
    retry, should_dispatch = quotas.begin_attempt(
        first.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    assert (retry, should_dispatch) == (first_attempt, False)
    with pytest.raises(quotas.ReservationConflict, match="exceed"):
        quotas.begin_attempt(
            first.id,
            user_id=ALICE,
            attempt_key="request-2",
            maximum_cost_nanousd=1,
        )
    assert quotas.link_attempt_generation(
        first_attempt.id,
        user_id=ALICE,
        generation_id="gen-1",
    ) is True
    assert quotas.link_attempt_generation(
        first_attempt.id,
        user_id=ALICE,
        generation_id="gen-1",
    ) is False
    resolved = quotas.resolve_attempt(
        first_attempt.id,
        user_id=ALICE,
        actual_nanousd=20,
    )
    assert quotas.resolve_attempt(
        first_attempt.id,
        user_id=ALICE,
        actual_nanousd=20,
        generation_id="gen-1",
    ) == resolved
    assert quotas.generation_ids(first.id, user_id=ALICE) == ["gen-1"]
    assert quotas.generation_ids(first.id, user_id=BOB) == []
    second_attempt, _ = quotas.begin_attempt(
        second.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=40,
    )
    with pytest.raises(quotas.ReservationConflict, match="already accounted"):
        quotas.link_attempt_generation(
            second_attempt.id,
            user_id=ALICE,
            generation_id="gen-1",
        )


@needs_pg
def test_account_deletion_cascades_reservations_and_attempts(database):
    tenancy.ensure_user(ALICE)
    reservation = quotas.reserve(**_args(None))
    quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    with db.pool().connection() as conn:
        conn.execute("delete from rc_users where id = %s", (ALICE,))
        reservations = conn.execute("select count(*) from rc_usage_reservations").fetchone()[0]
        attempts = conn.execute(
            "select count(*) from rc_usage_reservation_attempts",
        ).fetchone()[0]
    assert (reservations, attempts) == (0, 0)


@needs_pg
def test_schema_refuses_to_release_a_dispatched_reservation_even_if_python_is_bypassed(
    database, temp_project
):
    _own(temp_project)
    reservation = quotas.reserve(**_args(temp_project))
    quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    with pytest.raises(psycopg.errors.CheckViolation):
        with db.pool().connection() as conn:
            conn.execute(
                "update rc_usage_reservations "
                "set state = 'released', finalized_at = %s where id = %s",
                (datetime.now(UTC), reservation.id),
            )


@needs_pg
def test_store_failure_is_a_sanitized_fail_closed_refusal(database, monkeypatch, caplog):
    def broken_pool():
        raise RuntimeError("postgresql://user:secret@example.test/private")

    monkeypatch.setattr(db, "pool", broken_pool)
    with pytest.raises(quotas.QuotaUnavailable) as raised:
        quotas.reserve(**_args(None))
    assert "secret" not in str(raised.value)
    assert "secret" not in caplog.text
