"""Startup reconciliation: exact provider recovery versus conservative crash settlement."""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from app import config, db, quota_reconciler, quotas, tenancy

ALICE = "a3f0c8de-4b21-4d77-9f0e-2b6c5d1a7e44"
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


def _reserve(pid: str, *, provider: str = "openrouter") -> quotas.Reservation:
    tenancy.ensure_user(ALICE)
    tenancy.record_project(pid, ALICE)
    return quotas.reserve(
        user_id=ALICE,
        project_id=pid,
        reservation_key=f"job-1:{provider}",
        job_id="job-1",
        provider=provider,
        operation="analysis" if provider == "openrouter" else "speech_synthesis",
        model="deepseek/test" if provider == "openrouter" else "tts-1",
        maximum_cost_nanousd=60,
        limit_nanousd=100,
        lease_seconds=60,
    )


def _stale(reservation_id: str) -> None:
    with db.pool().connection() as conn:
        conn.execute(
            "update rc_usage_reservations set lease_expires_at = created_at where id = %s",
            (reservation_id,),
        )


@needs_pg
def test_completed_openrouter_generation_reconciles_to_exact_cost(database, temp_project):
    reservation = _reserve(temp_project)
    attempt, _ = quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    quotas.link_attempt_generation(
        attempt.id,
        user_id=ALICE,
        generation_id="gen-reconcile",
    )
    quotas.mark_dispatches_complete(reservation.id, user_id=ALICE)
    _stale(reservation.id)

    fetched: list[str] = []
    outcome = quota_reconciler.reconcile_reservation(
        quotas.get(reservation.id, user_id=ALICE),
        generation_fetcher=lambda generation_id: fetched.append(generation_id) or 20,
    )

    settled = quotas.get(reservation.id, user_id=ALICE)
    assert fetched == ["gen-reconcile"]
    assert outcome == "exact"
    assert (settled.state, settled.actual_nanousd, settled.settlement_kind) == (
        "settled", 20, "exact",
    )


@needs_pg
def test_incomplete_dispatch_record_is_charged_conservatively(database, temp_project):
    reservation = _reserve(temp_project)
    attempt, _ = quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    quotas.link_attempt_generation(
        attempt.id,
        user_id=ALICE,
        generation_id="gen-known-but-not-complete",
    )
    _stale(reservation.id)

    outcome = quota_reconciler.reconcile_reservation(
        quotas.get(reservation.id, user_id=ALICE),
        generation_fetcher=lambda _generation_id: pytest.fail(
            "an incomplete dispatch set cannot be proven exact"
        ),
    )

    settled = quotas.get(reservation.id, user_id=ALICE)
    assert outcome == "conservative"
    assert (settled.state, settled.actual_nanousd, settled.settlement_kind) == (
        "settled", 60, "conservative",
    )


@needs_pg
def test_generation_metadata_outage_stays_reserved_for_a_later_retry(database, temp_project):
    reservation = _reserve(temp_project)
    attempt, _ = quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    quotas.link_attempt_generation(
        attempt.id,
        user_id=ALICE,
        generation_id="gen-retry-later",
    )
    quotas.mark_dispatches_complete(reservation.id, user_id=ALICE)
    _stale(reservation.id)

    def unavailable(_generation_id: str) -> int:
        raise quota_reconciler.GenerationLookupError("temporarily unavailable")

    with pytest.raises(quota_reconciler.GenerationLookupError):
        quota_reconciler.reconcile_reservation(
            quotas.get(reservation.id, user_id=ALICE),
            generation_fetcher=unavailable,
        )

    retained = quotas.get(reservation.id, user_id=ALICE)
    assert retained.state == "reserved"
    assert retained.actual_nanousd is None


@needs_pg
def test_candidate_renewed_after_scan_is_not_reconciled(database, temp_project):
    reservation = _reserve(temp_project)
    attempt, _ = quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="request-1",
        maximum_cost_nanousd=60,
    )
    quotas.link_attempt_generation(
        attempt.id,
        user_id=ALICE,
        generation_id="gen-live",
    )
    _stale(reservation.id)
    stale_snapshot = quotas.stale_dispatched(limit=10)[0]

    # Simulate a renewal transaction winning immediately after the snapshot scan but before the
    # reconciler locks the row. The second, authoritative check must observe the live lease.
    with db.pool().connection() as conn:
        conn.execute(
            "update rc_usage_reservations set lease_expires_at = %s where id = %s",
            (datetime.now(UTC) + timedelta(minutes=5), reservation.id),
        )

    assert quota_reconciler.reconcile_reservation(
        stale_snapshot,
        generation_fetcher=lambda _generation_id: pytest.fail("live work must not reconcile"),
    ) == "skipped"
    assert quotas.get(reservation.id, user_id=ALICE).state == "reserved"


@needs_pg
def test_completed_exact_openai_attempt_settles_without_provider_lookup(database, temp_project):
    reservation = _reserve(temp_project, provider="openai")
    attempt, _ = quotas.begin_attempt(
        reservation.id,
        user_id=ALICE,
        attempt_key="speech-1",
        maximum_cost_nanousd=60,
    )
    quotas.resolve_attempt(attempt.id, user_id=ALICE, actual_nanousd=12)
    quotas.mark_dispatches_complete(reservation.id, user_id=ALICE)
    _stale(reservation.id)

    outcome = quota_reconciler.reconcile_reservation(
        quotas.get(reservation.id, user_id=ALICE),
        generation_fetcher=lambda _generation_id: pytest.fail("OpenAI has no generation lookup"),
    )

    assert outcome == "exact"
    assert quotas.get(reservation.id, user_id=ALICE).actual_nanousd == 12


class _Response:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


def test_generation_lookup_uses_metadata_endpoint_and_decimal_nanousd(monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "secret"})
    requests: list[dict] = []

    def get(url, **kwargs):
        requests.append({"url": url, **kwargs})
        return _Response(200, {"data": {"total_cost": "0.0000000205"}})

    monkeypatch.setattr(quota_reconciler.httpx, "get", get)
    assert quota_reconciler.fetch_openrouter_cost_nanousd("gen-1") == 21
    assert requests[0]["url"].endswith("/generation")
    assert requests[0]["params"] == {"id": "gen-1"}
    assert "content" not in requests[0]["url"]


@pytest.mark.parametrize("payload", [
    {},
    {"data": {}},
    {"data": {"total_cost": -1}},
    {"data": {"total_cost": "NaN"}},
    {"data": {"total_cost": "Infinity"}},
])
def test_generation_lookup_rejects_missing_or_invalid_cost(monkeypatch, payload):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "secret"})
    monkeypatch.setattr(
        quota_reconciler.httpx,
        "get",
        lambda *_args, **_kwargs: _Response(200, payload),
    )
    with pytest.raises(quota_reconciler.GenerationLookupError):
        quota_reconciler.fetch_openrouter_cost_nanousd("gen-1")


def test_generation_lookup_errors_are_sanitized(monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "secret"})

    def fail(*_args, **_kwargs):
        raise httpx.ConnectError(
            "postgresql://user:secret@example.test/private",
            request=httpx.Request("GET", "https://openrouter.ai/api/v1/generation"),
        )

    monkeypatch.setattr(quota_reconciler.httpx, "get", fail)
    with pytest.raises(quota_reconciler.GenerationLookupError) as raised:
        quota_reconciler.fetch_openrouter_cost_nanousd("gen-1")
    assert "secret" not in str(raised.value)
