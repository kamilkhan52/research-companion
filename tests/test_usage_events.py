"""Append-only per-user usage events: schema, idempotency, isolation, and query shape."""
from __future__ import annotations

import os
import threading

import pytest
from app import config, db, tenancy, usage, usage_events

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
            "drop table if exists rc_usage_events, rc_content_reports, rc_account_deletions, "
            "rc_project_trash, rc_user_settings, rc_projects, rc_users, "
            "rc_schema_migrations cascade",
        )
    db.migrate()
    yield
    db.close()


def _own(pid: str, user_id: str = ALICE) -> None:
    tenancy.ensure_user(user_id)
    tenancy.record_project(pid, user_id)


def test_events_are_a_noop_without_postgres(monkeypatch):
    monkeypatch.delenv("RC_DATABASE_URL", raising=False)
    db.close()
    assert usage_events.append_usage(
        user_id=ALICE,
        project_id="p",
        operation="analysis",
        model="m",
        provider_usage={"cost": 1.0},
    ) is False


@needs_pg
def test_usage_record_appends_queryable_user_project_feature_and_day(database, temp_project):
    _own(temp_project)
    with config.bound_scope(temp_project, ALICE):
        usage.record(
            "analysis",
            "anthropic/claude-test",
            {"prompt_tokens": 100, "completion_tokens": 20, "cost": 0.012},
            generation_id="gen-exact",
        )

    with db.pool().connection() as conn:
        row = conn.execute(
            "select user_id::text, project_id, event_type, operation, model, prompt_tokens, "
            "completion_tokens, total_tokens, cost_nanousd, generation_id, estimated "
            "from rc_usage_events",
        ).fetchone()
    assert row == (
        ALICE, temp_project, "usage", "analysis", "anthropic/claude-test",
        100, 20, 120, 12_000_000, "gen-exact", False,
    )
    daily = usage_events.daily_summary(ALICE)
    assert len(daily) == 1
    day = daily[0].pop("day")
    assert len(day) == 10
    assert daily == [{
        "operation": "analysis",
        "prompt_tokens": 100,
        "completion_tokens": 20,
        "total_tokens": 120,
        "cost_nanousd": 12_000_000,
        "estimated": False,
        "calls": 1,
        "pending_calls": 0,
    }]


@needs_pg
def test_generation_ids_make_each_event_kind_idempotent(database, temp_project):
    _own(temp_project)
    args = {
        "user_id": ALICE,
        "project_id": temp_project,
        "operation": "analysis",
        "model": "m",
        "generation_id": "gen-1",
    }
    assert usage_events.append_pending(**args) is True
    assert usage_events.append_pending(**args) is False
    exact = {**args, "provider_usage": {"cost": 0.004}}
    assert usage_events.append_usage(**exact) is True
    assert usage_events.append_usage(**exact) is False

    with db.pool().connection() as conn:
        rows = conn.execute(
            "select event_type, count(*) from rc_usage_events group by event_type order by 1",
        ).fetchall()
    assert rows == [("pending", 1), ("usage", 1)]


@needs_pg
def test_daily_summary_surfaces_only_unresolved_pending_calls(database, temp_project):
    _own(temp_project)
    args = {
        "user_id": ALICE,
        "project_id": temp_project,
        "operation": "analysis",
        "model": "m",
        "generation_id": "gen-pending-summary",
    }
    assert usage_events.append_pending(**args) is True
    pending = usage_events.daily_summary(ALICE)
    assert len(pending) == 1
    assert pending[0]["calls"] == 0
    assert pending[0]["pending_calls"] == 1
    assert pending[0]["estimated"] is True

    assert usage_events.append_usage(
        **{**args, "generation_id": "gen-exact-summary"},
        provider_usage={"prompt_tokens": 2, "completion_tokens": 1, "cost": 0.001},
    ) is True
    mixed = usage_events.daily_summary(ALICE)
    assert mixed[0]["calls"] == 1
    assert mixed[0]["pending_calls"] == 1
    assert mixed[0]["estimated"] is True

    assert usage_events.append_usage(
        **args,
        provider_usage={"prompt_tokens": 4, "completion_tokens": 2, "cost": 0.003},
    ) is True
    resolved = usage_events.daily_summary(ALICE)
    assert len(resolved) == 1
    assert resolved[0]["calls"] == 2
    assert resolved[0]["pending_calls"] == 0
    assert resolved[0]["estimated"] is False


@needs_pg
def test_same_project_id_cannot_be_attributed_to_the_wrong_user_concurrently(
    database, temp_project
):
    """Same pid, concurrent calls: only its real owner may acquire the accounting row."""
    _own(temp_project, ALICE)
    tenancy.ensure_user(BOB)
    barrier = threading.Barrier(2)
    results: dict[str, bool] = {}

    def append(user_id: str) -> None:
        barrier.wait(timeout=10)
        results[user_id] = usage_events.append_usage(
            user_id=user_id,
            project_id=temp_project,
            operation="analysis",
            model="m",
            provider_usage={"cost": 0.001},
        )

    threads = [threading.Thread(target=append, args=(uid,)) for uid in (ALICE, BOB)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)

    assert results == {ALICE: True, BOB: False}
    with db.pool().connection() as conn:
        owners = conn.execute("select user_id::text from rc_usage_events").fetchall()
    assert owners == [(ALICE,)]


@needs_pg
def test_reconciliation_appends_exact_usage_without_rewriting_pending(database, temp_project):
    _own(temp_project)
    with config.bound_scope(temp_project, ALICE):
        usage.record_pending("analysis", "m", "gen-later")
        assert usage.reconcile(
            "gen-later", {"prompt_tokens": 5, "completion_tokens": 2, "cost": 0.003},
        ) is True

    with db.pool().connection() as conn:
        rows = conn.execute(
            "select event_type, cost_nanousd from rc_usage_events "
            "where generation_id = 'gen-later' order by event_type",
        ).fetchall()
    assert rows == [("pending", 0), ("usage", 3_000_000)]


@needs_pg
def test_account_deletion_cascades_usage_metadata(database):
    tenancy.ensure_user(ALICE)
    assert usage_events.append_usage(
        user_id=ALICE,
        project_id=usage_events.UNATTRIBUTED_PROJECT,
        operation="narration",
        model="m",
        provider_usage={"cost": 0.002},
    ) is True
    with db.pool().connection() as conn:
        conn.execute("delete from rc_users where id = %s", (ALICE,))
        count = conn.execute("select count(*) from rc_usage_events").fetchone()[0]
    assert count == 0


@needs_pg
def test_project_retirement_keeps_historical_usage_until_account_deletion(
    database, temp_project
):
    _own(temp_project)
    assert usage_events.append_usage(
        user_id=ALICE,
        project_id=temp_project,
        operation="analysis",
        model="m",
        provider_usage={"cost": 0.002},
    ) is True

    assert tenancy.release(temp_project, f"{temp_project}-20260731-223000") == ALICE
    with db.pool().connection() as conn:
        event = conn.execute(
            "select user_id::text, project_id from rc_usage_events",
        ).fetchone()
    assert event == (ALICE, temp_project)


@needs_pg
def test_schema_rejects_negative_cost_even_if_python_is_bypassed(database):
    import psycopg

    tenancy.ensure_user(ALICE)
    with pytest.raises(psycopg.errors.CheckViolation):
        with db.pool().connection() as conn:
            conn.execute(
                "insert into rc_usage_events "
                "(user_id, event_type, operation, model, cost_nanousd) "
                "values (%s, 'usage', 'analysis', 'm', -1)",
                (ALICE,),
            )
