"""Crash reconciliation for durable provider-spend reservations.

The in-memory job registry disappears on process death; its Postgres reservation does not. A
never-dispatched expired lease is safe to release. A possibly-dispatched lease is different: it
must either be reconstructed from durable provider evidence or charged conservatively to its full
maximum. This module performs that work in a small daemon monitor after migrations succeed.

OpenRouter exposes generation metadata by id. We fetch only cost metadata, never stored prompt or
completion content. Other providers have no equivalent per-request recovery contract here, so an
ambiguous orphan is conservatively settled.
"""
from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

import httpx

from . import config, db, logging_config, quotas

log = logging_config.get("quota_reconciler")

_NANO_USD = Decimal(1_000_000_000)
_PG_BIGINT_MAX = 9_223_372_036_854_775_807
_LOOKUP_TIMEOUT_S = 20.0
_BATCH_SIZE = 50
_MONITOR_INTERVAL_S = 300.0

GenerationFetcher = Callable[[str], int]


class GenerationLookupError(RuntimeError):
    """OpenRouter metadata could not establish one authoritative generation cost."""


@dataclass(frozen=True)
class ReconciliationResult:
    expired: int = 0
    exact: int = 0
    conservative: int = 0
    failed: int = 0


def fetch_openrouter_cost_nanousd(generation_id: str) -> int:
    """Return authoritative OpenRouter generation cost without fetching its content."""
    key = config.load_settings().get("openrouter_api_key")
    if not key:
        raise GenerationLookupError("OpenRouter usage metadata is unavailable.")
    try:
        response = httpx.get(
            f"{config.OPENROUTER_BASE}/generation",
            headers={"Authorization": f"Bearer {key}"},
            params={"id": generation_id},
            timeout=_LOOKUP_TIMEOUT_S,
        )
    except httpx.HTTPError:
        raise GenerationLookupError("OpenRouter usage metadata is unavailable.") from None
    if response.status_code != 200:
        raise GenerationLookupError("OpenRouter usage metadata is unavailable.")
    try:
        data = response.json()["data"]
        raw_cost = data.get("total_cost")
        if raw_cost is None:
            raw_cost = data.get("usage")
        cost = Decimal(str(raw_cost))
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise GenerationLookupError("OpenRouter returned invalid usage metadata.") from None
    if not cost.is_finite() or cost < 0:
        raise GenerationLookupError("OpenRouter returned invalid usage metadata.")
    nanousd = int((cost * _NANO_USD).to_integral_value(rounding=ROUND_HALF_UP))
    if nanousd > _PG_BIGINT_MAX:
        raise GenerationLookupError("OpenRouter returned invalid usage metadata.")
    return nanousd


def reconcile_reservation(
    reservation: quotas.Reservation,
    *,
    generation_fetcher: GenerationFetcher = fetch_openrouter_cost_nanousd,
) -> str:
    """Settle one stale dispatched reservation, returning its outcome.

    Exact settlement needs two independent proofs: every attempt has authoritative exact cost,
    and the worker durably marked that no further dispatch could exist. If either proof is absent,
    charging the parent maximum is the only ceiling-safe terminal state.
    """
    claimed = quotas.claim_stale_dispatched(reservation.id, user_id=reservation.user_id)
    if claimed is None:
        return "skipped"
    reservation = claimed
    attempts = quotas.attempts_for(reservation.id, user_id=reservation.user_id)

    if reservation.provider == "openrouter" and reservation.dispatches_complete_at is not None:
        for attempt in attempts:
            if attempt.state == "resolved":
                continue
            if not attempt.generation_id:
                return _conservative(reservation)
            # An unavailable metadata service is not evidence that exact recovery is impossible.
            # Leave the maximum reserved and let the monitor retry; turning a transient outage
            # into a permanent full-price charge would be safe for the ceiling but unfair to the
            # reader. Missing durable evidence above is different and cannot improve on retry.
            actual = generation_fetcher(attempt.generation_id)
            quotas.resolve_attempt(
                attempt.id,
                user_id=reservation.user_id,
                actual_nanousd=actual,
                generation_id=attempt.generation_id,
            )
        attempts = quotas.attempts_for(reservation.id, user_id=reservation.user_id)

    if (
        reservation.dispatches_complete_at is not None
        and attempts
        and all(
            attempt.state == "resolved" and attempt.settlement_kind == "exact"
            for attempt in attempts
        )
    ):
        actual = sum(int(attempt.actual_nanousd or 0) for attempt in attempts)
        quotas.settle(
            reservation.id,
            user_id=reservation.user_id,
            actual_nanousd=actual,
        )
        return "exact"

    return _conservative(reservation)


def _conservative(reservation: quotas.Reservation) -> str:
    quotas.settle_conservatively(reservation.id, user_id=reservation.user_id)
    return "conservative"


def reconcile_once(
    *,
    limit: int = _BATCH_SIZE,
    generation_fetcher: GenerationFetcher = fetch_openrouter_cost_nanousd,
) -> ReconciliationResult:
    """Expire safe orphans and settle possibly-spent ones without aborting the whole batch."""
    expired = quotas.expire_undispatched(limit=limit)
    exact = conservative = failed = 0
    for reservation in quotas.stale_dispatched(limit=limit):
        try:
            outcome = reconcile_reservation(
                reservation,
                generation_fetcher=generation_fetcher,
            )
        except Exception as exc:  # noqa: BLE001 — another pass can retry a DB-side failure
            failed += 1
            log.warning(
                "usage reservation reconciliation failed (provider=%s, error=%s)",
                reservation.provider,
                type(exc).__name__,
            )
            continue
        if outcome == "exact":
            exact += 1
        elif outcome == "conservative":
            conservative += 1
    return ReconciliationResult(
        expired=expired,
        exact=exact,
        conservative=conservative,
        failed=failed,
    )


_monitor_lock = threading.Lock()
_monitor_started = False


def start_monitor() -> bool:
    """Start the one per-process reconciliation monitor after migrations are available."""
    global _monitor_started
    if not db.enabled():
        return False
    with _monitor_lock:
        if _monitor_started:
            return False
        _monitor_started = True

    def monitor() -> None:
        while True:
            try:
                result = reconcile_once()
            except Exception as exc:  # noqa: BLE001 — boot stays alive and the monitor retries
                log.warning("usage reconciliation pass failed (error=%s)", type(exc).__name__)
            else:
                if result.expired or result.exact or result.conservative or result.failed:
                    log.info(
                        "usage reconciliation expired=%d exact=%d conservative=%d failed=%d",
                        result.expired,
                        result.exact,
                        result.conservative,
                        result.failed,
                    )
            threading.Event().wait(_MONITOR_INTERVAL_S)

    threading.Thread(target=monitor, daemon=True, name="quota-reconciler").start()
    return True
