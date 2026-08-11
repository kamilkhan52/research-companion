"""Durable, fail-closed provider-spend reservations.

This module is intentionally separate from :mod:`app.usage_events`. Events are observational and
best-effort; reservations authorize spend and therefore raise when Postgres is unavailable. The
state machine is append-like at the accounting boundary: a reservation moves once from
``reserved`` to ``settled`` / ``released`` / ``expired`` and is never deleted before its account.

This module knows nothing about what anything costs. Prices, per-operation maximums and leases
live in :mod:`app.spend_limits`; the in-process binding that holds a reservation for the duration
of a job lives in :mod:`app.spend_ceiling`. Keeping the ledger free of product decisions is what
stopped the ceiling growing a second source of truth about who may spend what.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from psycopg import errors

from . import db, logging_config

log = logging_config.get("quotas")

_PG_BIGINT_MAX = 9_223_372_036_854_775_807
_MAX_LEASE_SECONDS = 24 * 60 * 60
_PROVIDERS = {"openrouter", "openai", "firecrawl", "openalex", "semantic_scholar"}


class QuotaError(RuntimeError):
    """A safe, user-displayable admission failure."""

    def refusal_payload(self) -> dict:
        """The structured, client-safe description of this refusal (DR-049).

        One derivation for both delivery paths: the HTTP handler in `main` answers admission
        refusals with it directly, and `JobRegistry` stamps it onto a job whose WORKER was
        refused mid-flight — so the mobile client classifies a code instead of matching exact
        server prose (which pinned a copy edit to a client release). Everything here is the
        account's own message and figures; provider bodies and arbitrary exception text never
        enter it.
        """
        return {"code": "quota_unavailable", "detail": str(self)}


class QuotaUnavailable(QuotaError):
    """The authoritative store could not prove that spend is allowed."""


class QuotaExceeded(QuotaError):
    """The account's configured hard ceiling cannot fit the requested reservation."""

    def __init__(self, *, used_nanousd: int, requested_nanousd: int, limit_nanousd: int,
                 settled_nanousd: int | None = None):
        # The message is derived here, not in the HTTP handler, because most refusals never reach
        # one: a paper's own hold raises mid-graph-build, the analysis continuation raises
        # inside the retrieval worker, and the narration continuation raises inside the chat
        # worker. Each of those turns the exception into an error STRING on a job, so a split that
        # lived only in `main` told a reader whose own in-flight holds collided — and who may have
        # spent almost nothing — to wait until the period rolls over. Same lesson as the hook's
        # admission stamp: put the fact on the thing, not at every call site.
        spent = used_nanousd if settled_nanousd is None else settled_nanousd
        if requested_nanousd > limit_nanousd:
            # Waiting cannot help: the work costs more than the whole allowance. Unreachable at
            # the default ceiling, but the pricing doc's Free tier is $0.20 a month, against which
            # a narration hold alone is $0.60 — every one of those refusals would otherwise advise
            # waiting for a reset that changes nothing.
            super().__init__(
                "This task needs more than your whole monthly allowance.",
            )
        elif spent + requested_nanousd <= limit_nanousd:
            super().__init__(
                "Your other tasks are still running. Give them a moment and try again.",
            )
        else:
            super().__init__("Your usage limit has been reached. Try again after it resets.")
        self.used_nanousd = used_nanousd
        self.requested_nanousd = requested_nanousd
        self.limit_nanousd = limit_nanousd
        #: Of `used_nanousd`, how much is money actually SPENT rather than held against work still
        #: running. The two mean opposite things to a reader: spend does not come back until the
        #: period rolls over, while a hold clears in seconds when its job finishes. Reporting a
        #: transient collision of pessimistic holds as "your monthly limit is reached" tells
        #: someone who has spent nothing to wait a month.
        self.settled_nanousd = used_nanousd if settled_nanousd is None else settled_nanousd

    @property
    def is_transient(self) -> bool:
        """Whether outstanding holds — not real spend — are what leaves no room."""
        return self.settled_nanousd + self.requested_nanousd <= self.limit_nanousd

    def refusal_payload(self) -> dict:
        if self.is_transient:
            return {
                "code": "holds_outstanding",
                "detail": str(self),
                "used_nanousd": self.used_nanousd,
                "settled_nanousd": self.settled_nanousd,
                "limit_nanousd": self.limit_nanousd,
                "retry_after_seconds": 15,
            }
        return {
            "code": "quota_exceeded",
            "detail": str(self),
            "used_nanousd": self.used_nanousd,
            "settled_nanousd": self.settled_nanousd,
            "requested_nanousd": self.requested_nanousd,
            "limit_nanousd": self.limit_nanousd,
        }


class ReservationConflict(QuotaError):
    """An idempotency key or state transition does not describe the same reservation."""

    def refusal_payload(self) -> dict:
        # Mirror `main`'s HTTP handler exactly: same code, same generic copy. A conflict is a
        # server-side accounting fault, and its internal message describes ledger state — the
        # payload deliberately does not carry it.
        return {
            "code": "reservation_conflict",
            "detail": "Usage accounting is temporarily inconsistent. Please try again.",
        }


@dataclass(frozen=True)
class Reservation:
    id: str
    user_id: str
    project_id: str | None
    reservation_key: str
    job_id: str
    provider: str
    operation: str
    model: str
    state: str
    reserved_nanousd: int
    actual_nanousd: int | None
    settlement_kind: str | None
    period_start: datetime
    period_end: datetime
    lease_expires_at: datetime
    dispatched_at: datetime | None
    dispatches_complete_at: datetime | None
    created_at: datetime
    updated_at: datetime
    finalized_at: datetime | None


@dataclass(frozen=True)
class DispatchAttempt:
    id: str
    reservation_id: str
    attempt_key: str
    provider: str
    maximum_nanousd: int
    state: str
    actual_nanousd: int | None
    settlement_kind: str | None
    generation_id: str | None
    dispatched_at: datetime
    resolved_at: datetime | None


_COLUMNS = (
    "id::text, user_id::text, project_id, reservation_key, job_id, provider, operation, "
    "model, state, reserved_nanousd, actual_nanousd, settlement_kind, period_start, "
    "period_end, lease_expires_at, dispatched_at, dispatches_complete_at, created_at, "
    "updated_at, finalized_at"
)
_ATTEMPT_COLUMNS = (
    "id::text, reservation_id::text, attempt_key, provider, maximum_nanousd, state, "
    "actual_nanousd, settlement_kind, generation_id, dispatched_at, resolved_at"
)
_ATTEMPT_COLUMNS_QUALIFIED = (
    "attempt.id::text, attempt.reservation_id::text, attempt.attempt_key, attempt.provider, "
    "attempt.maximum_nanousd, attempt.state, attempt.actual_nanousd, "
    "attempt.settlement_kind, attempt.generation_id, attempt.dispatched_at, attempt.resolved_at"
)


def calendar_month(when: datetime | None = None) -> tuple[datetime, datetime]:
    """The UTC calendar-month window containing ``when`` (a provisional pre-subscription tier)."""
    current = _aware(when or datetime.now(UTC), "when")
    start = current.astimezone(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start, end


def reserve(
    *,
    user_id: str,
    project_id: str | None,
    reservation_key: str,
    job_id: str,
    provider: str,
    operation: str,
    model: str | None,
    maximum_cost_nanousd: int,
    limit_nanousd: int,
    lease_seconds: int,
) -> Reservation:
    """Atomically reserve a pessimistic maximum inside one account's hard ceiling.

    Locking the ``rc_users`` row serializes every admission for that user, so simultaneous jobs
    cannot each observe the same remaining balance. A project row is also locked and checked as
    the composite ownership proof; project retirement therefore cannot race this insert.
    """
    if not db.enabled():
        raise QuotaUnavailable("Usage limits are temporarily unavailable. Please try again.")
    maximum = _positive_nanousd(maximum_cost_nanousd, "maximum_cost_nanousd")
    limit = _positive_nanousd(limit_nanousd, "limit_nanousd")
    if not isinstance(lease_seconds, int) or isinstance(lease_seconds, bool):
        raise ReservationConflict("The reservation lease is invalid.")
    if lease_seconds < 1 or lease_seconds > _MAX_LEASE_SECONDS:
        raise ReservationConflict("The reservation lease is invalid.")
    provider = _bounded(provider, "provider", 1, 64)
    if provider not in _PROVIDERS:
        raise ReservationConflict("The provider is not reservable.")
    key = _bounded(reservation_key, "reservation key", 1, 192)
    jid = _bounded(job_id, "job id", 1, 128)
    op = _bounded(operation, "operation", 1, 64)
    chosen_model = _bounded(model or "unknown", "model", 1, 256)
    now = datetime.now(UTC)
    # The authoritative period is derived here rather than accepted from a caller. Otherwise one
    # integration bug could choose a fresh arbitrary window for every job and bypass the ceiling.
    # M5 may replace this with a server-derived subscription window, never a request field.
    start, end = calendar_month(now)
    lease_until = now + timedelta(seconds=lease_seconds)

    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                # This row is the per-account admission mutex. It also proves the verified subject
                # still exists and serializes against its eventual account deletion.
                if conn.execute(
                    "select 1 from rc_users where id = %s for update", (user_id,),
                ).fetchone() is None:
                    raise QuotaUnavailable(
                        "Usage limits are temporarily unavailable. Please sign in again."
                    )

                if project_id is not None:
                    owner = conn.execute(
                        "select owner_id::text, deleted_at is null "
                        "from rc_projects where id = %s for update",
                        (project_id,),
                    ).fetchone()
                    if owner is None or owner != (user_id, True):
                        raise ReservationConflict("The project is no longer available.")

                existing = conn.execute(
                    f"select {_COLUMNS} from rc_usage_reservations "
                    "where user_id = %s and reservation_key = %s",
                    (user_id, key),
                ).fetchone()
                if existing is not None:
                    reservation = _from_row(existing)
                    if reservation.state != "reserved":
                        raise ReservationConflict("The reservation key was already finalized.")
                    intended = (
                        project_id, jid, provider, op, chosen_model, maximum, start, end,
                    )
                    actual = (
                        reservation.project_id, reservation.job_id, reservation.provider,
                        reservation.operation, reservation.model, reservation.reserved_nanousd,
                        reservation.period_start, reservation.period_end,
                    )
                    if actual != intended:
                        raise ReservationConflict(
                            "The reservation retry does not match the original request."
                        )
                    return reservation

                # Both halves in one pass: what is HELD against running work, and what has been
                # SPENT. Admission is refused on the total, but the caller needs the split to say
                # whether waiting seconds or waiting a month is the honest advice.
                totals = conn.execute(
                    "select coalesce(sum(case "
                    "  when state = 'reserved' then reserved_nanousd "
                    "  when state = 'settled' then actual_nanousd "
                    "  else 0 end), 0), "
                    "coalesce(sum(case when state = 'settled' then actual_nanousd else 0 end), 0) "
                    "from rc_usage_reservations "
                    "where user_id = %s and period_start = %s and period_end = %s "
                    "and state in ('reserved', 'settled')",
                    (user_id, start, end),
                ).fetchone()
                used = int(totals[0])
                settled = int(totals[1])
                if used > limit - maximum:
                    raise QuotaExceeded(
                        used_nanousd=used,
                        requested_nanousd=maximum,
                        limit_nanousd=limit,
                        settled_nanousd=settled,
                    )

                row = conn.execute(
                    "insert into rc_usage_reservations "
                    "(user_id, project_id, reservation_key, job_id, provider, operation, model, "
                    " reserved_nanousd, period_start, period_end, lease_expires_at, created_at, "
                    " updated_at) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                    f"returning {_COLUMNS}",
                    (
                        user_id, project_id, key, jid, provider, op, chosen_model, maximum,
                        start, end, lease_until, now, now,
                    ),
                ).fetchone()
                return _from_row(row)
    except (QuotaExceeded, ReservationConflict, QuotaUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001 — admission fails closed on every store failure
        log.warning("usage reservation failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def period_usage(user_id: str) -> tuple[int, int] | None:
    """What this account has SPENT and what it currently HOLDS in the live period, in nano-USD.

    Two numbers rather than one because they mean opposite things to a reader: spend does not come
    back until the period rolls over, while a hold clears in seconds when its job settles. A
    surface that adds them together tells someone with four jobs running that they are nearly out
    of budget when they have barely spent anything — the same confusion the transient/exhausted
    split in `QuotaExceeded` exists to remove.

    Read-only: this feeds a display, so it never raises. But it distinguishes "no database" —
    where zero is the honest answer, because the ceiling is inert too — from "the query failed",
    where the answer is unknown. Returning zero for the second would tell a reader their whole
    allowance is intact at the exact moment every job is failing closed.
    """
    if not db.enabled():
        return (0, 0)
    start, end = calendar_month()
    try:
        with db.pool().connection() as conn:
            row = conn.execute(
                "select "
                "coalesce(sum(case when state = 'settled' then actual_nanousd else 0 end), 0), "
                "coalesce(sum(case when state = 'reserved' then reserved_nanousd else 0 end), 0) "
                "from rc_usage_reservations "
                "where user_id = %s and period_start = %s and period_end = %s "
                "and state in ('reserved', 'settled')",
                (user_id, start, end),
            ).fetchone()
        return (int(row[0]), int(row[1]))
    except Exception as e:  # noqa: BLE001 — a usage display must not fail the request
        log.warning("period usage unavailable (error=%s)", type(e).__name__)
        return None


def get(reservation_id: str, *, user_id: str) -> Reservation | None:
    """Fetch one reservation only within its verified owner scope."""
    if not db.enabled():
        raise QuotaUnavailable("Usage limits are temporarily unavailable. Please try again.")
    try:
        with db.pool().connection() as conn:
            row = conn.execute(
                f"select {_COLUMNS} from rc_usage_reservations where id = %s and user_id = %s",
                (reservation_id, user_id),
            ).fetchone()
        return _from_row(row) if row else None
    except Exception as exc:  # noqa: BLE001
        log.warning("usage reservation read failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def begin_attempt(
    reservation_id: str,
    *,
    user_id: str,
    attempt_key: str,
    maximum_cost_nanousd: int,
    extend_lease_seconds: int | None = None,
) -> tuple[DispatchAttempt, bool]:
    """Allocate and persist one provider attempt immediately before network dispatch.

    The boolean is ``True`` only for a newly inserted attempt. If a database response was lost,
    retrying the same key returns the existing row and ``False``; the caller must not send the
    provider request a second time. Distinct provider retries use distinct attempt keys.
    """
    key = _bounded(attempt_key, "attempt key", 1, 128)
    maximum = _positive_nanousd(maximum_cost_nanousd, "maximum_cost_nanousd")
    extension = _lease_extension(extend_lease_seconds)
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                reservation = _locked(conn, reservation_id, user_id)
                if reservation.state != "reserved":
                    raise ReservationConflict("The reservation is no longer active.")
                if reservation.lease_expires_at <= now:
                    raise ReservationConflict("The reservation lease has expired.")
                if reservation.dispatches_complete_at is not None:
                    raise ReservationConflict("Provider dispatches are already complete.")
                existing = conn.execute(
                    f"select {_ATTEMPT_COLUMNS} from rc_usage_reservation_attempts "
                    "where reservation_id = %s and attempt_key = %s",
                    (reservation_id, key),
                ).fetchone()
                if existing is not None:
                    attempt = _attempt_from_row(existing)
                    if attempt.maximum_nanousd != maximum:
                        raise ReservationConflict(
                            "The attempt retry does not match the original request."
                        )
                    return attempt, False
                allocated = int(conn.execute(
                    "select coalesce(sum(maximum_nanousd), 0) "
                    "from rc_usage_reservation_attempts where reservation_id = %s",
                    (reservation_id,),
                ).fetchone()[0])
                if allocated > reservation.reserved_nanousd - maximum:
                    raise ReservationConflict(
                        "The provider attempts exceed the reservation maximum."
                    )
                lease = max(reservation.lease_expires_at, now + extension) if extension else None
                attempt_row = conn.execute(
                    "insert into rc_usage_reservation_attempts "
                    "(reservation_id, attempt_key, provider, maximum_nanousd, dispatched_at) "
                    "values (%s, %s, %s, %s, %s) "
                    f"returning {_ATTEMPT_COLUMNS}",
                    (reservation_id, key, reservation.provider, maximum, now),
                ).fetchone()
                conn.execute(
                    "update rc_usage_reservations set dispatched_at = coalesce(dispatched_at, %s), "
                    "lease_expires_at = coalesce(%s, lease_expires_at), updated_at = %s "
                    "where id = %s and user_id = %s",
                    (now, lease, now, reservation_id, user_id),
                )
                return _attempt_from_row(attempt_row), True
    except ReservationConflict:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("usage dispatch marker failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def resolve_attempt(
    attempt_id: str,
    *,
    user_id: str,
    actual_nanousd: int,
    generation_id: str | None = None,
    kind: str = "exact",
) -> DispatchAttempt:
    """Resolve one dispatch to exact or conservatively charged cost, idempotently."""
    actual = _nonnegative_nanousd(actual_nanousd, "actual_nanousd")
    gid = _bounded(generation_id, "generation id", 1, 256) if generation_id else None
    if kind not in {"exact", "conservative"}:
        raise ReservationConflict("The settlement kind is invalid.")
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                row = conn.execute(
                    f"select {_ATTEMPT_COLUMNS_QUALIFIED}, reservation.state "
                    "from rc_usage_reservation_attempts attempt "
                    "join rc_usage_reservations reservation on reservation.id = attempt.reservation_id "
                    "where attempt.id = %s and reservation.user_id = %s "
                    "for update of attempt, reservation",
                    (attempt_id, user_id),
                ).fetchone()
                if row is None:
                    raise ReservationConflict("The provider attempt does not exist.")
                attempt = _attempt_from_row(row[:-1])
                reservation_state = row[-1]
                if attempt.generation_id is not None and gid not in {None, attempt.generation_id}:
                    raise ReservationConflict(
                        "The provider attempt has a different generation id."
                    )
                effective_gid = gid or attempt.generation_id
                if attempt.state == "resolved":
                    intended = (actual, kind, effective_gid)
                    recorded = (
                        attempt.actual_nanousd, attempt.settlement_kind, attempt.generation_id,
                    )
                    if recorded == intended:
                        return attempt
                    raise ReservationConflict("The provider attempt was already resolved differently.")
                if reservation_state != "reserved":
                    raise ReservationConflict("The reservation is no longer active.")
                if kind == "conservative" and actual != attempt.maximum_nanousd:
                    raise ReservationConflict(
                        "Conservative attempt resolution must charge its maximum."
                    )
                resolved = conn.execute(
                    "update rc_usage_reservation_attempts "
                    "set state = 'resolved', actual_nanousd = %s, settlement_kind = %s, "
                    "generation_id = %s, resolved_at = %s where id = %s "
                    f"returning {_ATTEMPT_COLUMNS}",
                    (actual, kind, effective_gid, now, attempt_id),
                ).fetchone()
                return _attempt_from_row(resolved)
    except ReservationConflict:
        raise
    except errors.UniqueViolation:
        raise ReservationConflict("The provider generation is already accounted for.") from None
    except Exception as exc:  # noqa: BLE001
        log.warning("usage attempt resolution failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def link_attempt_generation(attempt_id: str, *, user_id: str, generation_id: str) -> bool:
    """Persist an OpenRouter id even when authoritative cost has not arrived yet."""
    gid = _bounded(generation_id, "generation id", 1, 256)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                row = conn.execute(
                    f"select {_ATTEMPT_COLUMNS_QUALIFIED}, reservation.state, "
                    "reservation.dispatches_complete_at "
                    "from rc_usage_reservation_attempts attempt "
                    "join rc_usage_reservations reservation on reservation.id = attempt.reservation_id "
                    "where attempt.id = %s and reservation.user_id = %s "
                    "for update of attempt, reservation",
                    (attempt_id, user_id),
                ).fetchone()
                if row is None:
                    raise ReservationConflict("The provider attempt does not exist.")
                attempt = _attempt_from_row(row[:-2])
                if attempt.provider != "openrouter":
                    raise ReservationConflict("This provider has no generation reconciliation.")
                if row[-2] != "reserved" or row[-1] is not None:
                    raise ReservationConflict("The reservation cannot accept generations.")
                if attempt.generation_id == gid:
                    return False
                if attempt.generation_id is not None:
                    raise ReservationConflict(
                        "The provider attempt has a different generation id."
                    )
                conn.execute(
                    "update rc_usage_reservation_attempts set generation_id = %s where id = %s",
                    (gid, attempt_id),
                )
                return True
    except ReservationConflict:
        raise
    except errors.UniqueViolation:
        raise ReservationConflict("The provider generation is already accounted for.") from None
    except Exception as exc:  # noqa: BLE001
        log.warning("usage generation link failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def generation_ids(reservation_id: str, *, user_id: str) -> list[str]:
    """The linked OpenRouter generations for one reservation, scoped through its owner."""
    if not db.enabled():
        raise QuotaUnavailable("Usage limits are temporarily unavailable. Please try again.")
    try:
        with db.pool().connection() as conn:
            rows = conn.execute(
                "select attempt.generation_id "
                "from rc_usage_reservation_attempts attempt "
                "join rc_usage_reservations reservation "
                "  on reservation.id = attempt.reservation_id "
                "where reservation.id = %s and reservation.user_id = %s "
                "and attempt.generation_id is not null "
                "order by attempt.dispatched_at, attempt.generation_id",
                (reservation_id, user_id),
            ).fetchall()
        return [row[0] for row in rows]
    except Exception as exc:  # noqa: BLE001
        log.warning("usage generation read failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def attempts_for(reservation_id: str, *, user_id: str) -> list[DispatchAttempt]:
    """All durable provider attempts for one owner-scoped reservation, in dispatch order."""
    if not db.enabled():
        raise QuotaUnavailable("Usage limits are temporarily unavailable. Please try again.")
    try:
        with db.pool().connection() as conn:
            rows = conn.execute(
                f"select {_ATTEMPT_COLUMNS_QUALIFIED} "
                "from rc_usage_reservation_attempts attempt "
                "join rc_usage_reservations reservation "
                "  on reservation.id = attempt.reservation_id "
                "where reservation.id = %s and reservation.user_id = %s "
                "order by attempt.dispatched_at, attempt.id",
                (reservation_id, user_id),
            ).fetchall()
        return [_attempt_from_row(row) for row in rows]
    except Exception as exc:  # noqa: BLE001
        log.warning("usage attempt read failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def mark_dispatches_complete(reservation_id: str, *, user_id: str) -> Reservation:
    """Durably assert that no further provider request can be in flight for this reservation.

    Call only after the worker knows it will initiate no more requests and every accepted response
    has at least had its generation id linked when one exists. Cost resolution is deliberately
    independent: a completed OpenRouter generation can still be pending when this marker lands,
    then startup reconciliation can resolve it exactly. Exact settlement remains forbidden until
    every attempt is resolved.
    """
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                reservation = _locked(conn, reservation_id, user_id)
                if reservation.state != "reserved":
                    raise ReservationConflict("The reservation is no longer active.")
                if reservation.dispatched_at is None:
                    raise ReservationConflict("Provider dispatch was not durably marked.")
                attempt_count = conn.execute(
                    "select count(*) "
                    "from rc_usage_reservation_attempts where reservation_id = %s",
                    (reservation_id,),
                ).fetchone()[0]
                if attempt_count < 1:
                    raise ReservationConflict("Provider dispatch was not durably marked.")
                row = conn.execute(
                    "update rc_usage_reservations "
                    "set dispatches_complete_at = coalesce(dispatches_complete_at, %s), "
                    "updated_at = %s where id = %s and user_id = %s "
                    f"returning {_COLUMNS}",
                    (now, now, reservation_id, user_id),
                ).fetchone()
                return _from_row(row)
    except ReservationConflict:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("usage dispatch completion failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def renew(
    reservation_id: str,
    *,
    user_id: str,
    lease_seconds: int,
) -> Reservation:
    """Extend (never shorten) one active reservation lease."""
    extension = _lease_extension(lease_seconds)
    assert extension is not None
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                reservation = _locked(conn, reservation_id, user_id)
                if reservation.state != "reserved":
                    raise ReservationConflict("The reservation is no longer active.")
                if reservation.lease_expires_at <= now:
                    raise ReservationConflict("The reservation lease has expired.")
                row = conn.execute(
                    "update rc_usage_reservations "
                    "set lease_expires_at = greatest(lease_expires_at, %s), updated_at = %s "
                    "where id = %s and user_id = %s "
                    f"returning {_COLUMNS}",
                    (now + extension, now, reservation_id, user_id),
                ).fetchone()
                return _from_row(row)
    except ReservationConflict:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("usage lease renewal failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def settle(
    reservation_id: str,
    *,
    user_id: str,
    actual_nanousd: int,
    kind: str = "exact",
) -> Reservation:
    """Settle once to authoritative actual cost or a conservative crash-safe amount."""
    actual = _nonnegative_nanousd(actual_nanousd, "actual_nanousd")
    if kind not in {"exact", "conservative"}:
        raise ReservationConflict("The settlement kind is invalid.")
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                reservation = _locked(conn, reservation_id, user_id)
                if reservation.state == "settled":
                    if reservation.actual_nanousd == actual and reservation.settlement_kind == kind:
                        return reservation
                    raise ReservationConflict("The reservation was already settled differently.")
                if reservation.state != "reserved":
                    raise ReservationConflict("The reservation is no longer active.")
                if reservation.dispatched_at is None:
                    raise ReservationConflict("Provider dispatch was not durably marked.")
                if kind == "exact" and reservation.dispatches_complete_at is None:
                    raise ReservationConflict(
                        "Exact settlement requires a complete provider-dispatch record."
                    )
                if kind == "conservative" and actual != reservation.reserved_nanousd:
                    raise ReservationConflict(
                        "Conservative settlement must charge the reservation maximum."
                    )
                if kind == "exact":
                    attempt_totals = conn.execute(
                        "select coalesce(sum(actual_nanousd), 0), "
                        "count(*) filter (where state <> 'resolved'), "
                        "count(*) filter (where settlement_kind <> 'exact') "
                        "from rc_usage_reservation_attempts "
                        "where reservation_id = %s",
                        (reservation_id,),
                    ).fetchone()
                    attempt_total = int(attempt_totals[0])
                    if attempt_totals[1] != 0:
                        raise ReservationConflict(
                            "Exact settlement requires every provider attempt to be resolved."
                        )
                    if attempt_totals[2] != 0:
                        raise ReservationConflict(
                            "Exact settlement requires exact provider attempts."
                        )
                    if actual != attempt_total:
                        raise ReservationConflict(
                            "Exact settlement does not match the resolved provider attempts."
                        )
                row = conn.execute(
                    "update rc_usage_reservations "
                    "set state = 'settled', actual_nanousd = %s, settlement_kind = %s, "
                    "updated_at = %s, finalized_at = %s "
                    "where id = %s and user_id = %s "
                    f"returning {_COLUMNS}",
                    (actual, kind, now, now, reservation_id, user_id),
                ).fetchone()
                return _from_row(row)
    except ReservationConflict:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("usage settlement failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def release(reservation_id: str, *, user_id: str) -> Reservation:
    """Release an undispatched reservation; possibly-billed work can never take this path."""
    return _finish_without_spend(reservation_id, user_id=user_id, state="released")


def expire_undispatched(*, limit: int = 100) -> int:
    """Expire stale leases only when no provider dispatch was durably marked.

    ``SKIP LOCKED`` lets a startup/background reconciler coexist with live renew/dispatch calls.
    Dispatched rows remain reserved for provider-specific reconciliation or conservative settle.
    """
    if not db.enabled():
        raise QuotaUnavailable("Usage limits are temporarily unavailable. Please try again.")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 1000:
        raise ReservationConflict("The reconciliation batch size is invalid.")
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                rows = conn.execute(
                    "with stale as ("
                    "  select id from rc_usage_reservations "
                    "  where state = 'reserved' and dispatched_at is null and lease_expires_at < %s "
                    "  order by lease_expires_at for update skip locked limit %s"
                    ") update rc_usage_reservations reservation "
                    "set state = 'expired', updated_at = %s, finalized_at = %s "
                    "from stale where reservation.id = stale.id returning reservation.id",
                    (now, limit, now, now),
                ).fetchall()
        return len(rows)
    except Exception as exc:  # noqa: BLE001
        log.warning("usage lease expiry failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def stale_dispatched(*, limit: int = 100) -> list[Reservation]:
    """List expired active leases that may have spent and must never be blindly released."""
    if not db.enabled():
        raise QuotaUnavailable("Usage limits are temporarily unavailable. Please try again.")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 1000:
        raise ReservationConflict("The reconciliation batch size is invalid.")
    try:
        with db.pool().connection() as conn:
            rows = conn.execute(
                f"select {_COLUMNS} from rc_usage_reservations "
                "where state = 'reserved' and dispatched_at is not null and lease_expires_at < %s "
                "order by lease_expires_at limit %s",
                (datetime.now(UTC), limit),
            ).fetchall()
        return [_from_row(row) for row in rows]
    except Exception as exc:  # noqa: BLE001
        log.warning("usage stale-reservation scan failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def claim_stale_dispatched(reservation_id: str, *, user_id: str) -> Reservation | None:
    """Re-check one stale candidate under its row lock before reconciliation.

    ``stale_dispatched`` is intentionally a cheap snapshot scan. A worker may renew between that
    scan and reconciliation; acting on the stale snapshot would then settle a live job underneath
    it. Once this locked check observes an expired lease, normal ``renew``/``begin_attempt`` cannot
    resurrect it, so the reconciler may safely continue after releasing the lock.
    """
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                reservation = _locked(conn, reservation_id, user_id)
                if (
                    reservation.state != "reserved"
                    or reservation.dispatched_at is None
                    or reservation.lease_expires_at >= now
                ):
                    return None
                return reservation
    except ReservationConflict:
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning("usage stale-reservation claim failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def settle_conservatively(reservation_id: str, *, user_id: str) -> Reservation:
    """Charge a possibly-dispatched orphan at its reserved maximum when exact recovery is absent."""
    reservation = get(reservation_id, user_id=user_id)
    if reservation is None:
        raise ReservationConflict("The reservation does not exist.")
    if reservation.dispatched_at is None:
        raise ReservationConflict("An undispatched reservation must be released or expired.")
    return settle(
        reservation_id,
        user_id=user_id,
        actual_nanousd=reservation.reserved_nanousd,
        kind="conservative",
    )


def _finish_without_spend(
    reservation_id: str,
    *,
    user_id: str,
    state: str,
) -> Reservation:
    if state not in {"released", "expired"}:
        raise AssertionError("invalid no-spend terminal state")
    now = datetime.now(UTC)
    try:
        with db.pool().connection() as conn:
            with conn.transaction():
                reservation = _locked(conn, reservation_id, user_id)
                if reservation.state == state:
                    return reservation
                if reservation.state != "reserved":
                    raise ReservationConflict("The reservation is no longer active.")
                if reservation.dispatched_at is not None:
                    raise ReservationConflict(
                        "Possibly-billed work must be settled, not released."
                    )
                row = conn.execute(
                    "update rc_usage_reservations set state = %s, updated_at = %s, finalized_at = %s "
                    "where id = %s and user_id = %s "
                    f"returning {_COLUMNS}",
                    (state, now, now, reservation_id, user_id),
                ).fetchone()
                return _from_row(row)
    except ReservationConflict:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("usage reservation finalization failed closed (error=%s)", type(exc).__name__)
        raise QuotaUnavailable(
            "Usage limits are temporarily unavailable. Please try again."
        ) from None


def _locked(conn, reservation_id: str, user_id: str) -> Reservation:
    row = conn.execute(
        f"select {_COLUMNS} from rc_usage_reservations "
        "where id = %s and user_id = %s for update",
        (reservation_id, user_id),
    ).fetchone()
    if row is None:
        raise ReservationConflict("The reservation does not exist.")
    return _from_row(row)


def _from_row(row) -> Reservation:
    return Reservation(*row)


def _attempt_from_row(row) -> DispatchAttempt:
    return DispatchAttempt(*row)


def _aware(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ReservationConflict(f"The {name.replace('_', ' ')} is invalid.")
    return value.astimezone(UTC)


def _bounded(value: str, name: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not (minimum <= len(value) <= maximum):
        raise ReservationConflict(f"The {name} is invalid.")
    return value


def _positive_nanousd(value: int, name: str) -> int:
    parsed = _nonnegative_nanousd(value, name)
    if parsed == 0:
        raise ReservationConflict(f"The {name.replace('_', ' ')} must be positive.")
    return parsed


def _nonnegative_nanousd(value: int, name: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > _PG_BIGINT_MAX
    ):
        raise ReservationConflict(f"The {name.replace('_', ' ')} is invalid.")
    return value


def _lease_extension(seconds: int | None) -> timedelta | None:
    if seconds is None:
        return None
    if (
        not isinstance(seconds, int)
        or isinstance(seconds, bool)
        or seconds < 1
        or seconds > _MAX_LEASE_SECONDS
    ):
        raise ReservationConflict("The reservation lease is invalid.")
    return timedelta(seconds=seconds)
