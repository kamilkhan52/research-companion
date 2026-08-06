"""Holding a reservation for the duration of one job, and settling it to what was actually spent.

`quotas.py` can reserve, settle and reconcile. `spend_limits.py` says what the ceiling is and what
one admission might cost at worst. This is the part that connects them to a running job:

    admit  -> reserve a pessimistic maximum against the account's monthly ceiling
    work   -> every metered call adds its real cost to a per-job accumulator
    settle -> charge the accumulated actual, releasing the unspent remainder

**Why a contextvar and not a parameter.** The spend happens far below the job — inside `llm.py`,
`tts.py`, a nested graph worker — and threading a reservation id through every one of those call
paths is exactly the "every call site must remember" design that produced three separate metering
bypasses in #325. The job binds it once; the accounting seam reads it. Same shape as the active
project and active user (invariants 2), and bound in the same place for the same reason: a thread
does not inherit it.

**Accumulation is best-effort; the reservation is not.** Architectural rule 5 keeps these apart.
`usage.record` must never fail a turn, so adding to the accumulator is wrapped and swallowed. The
reservation itself fails closed: if it cannot be taken, the work is refused. The consequence of
that asymmetry is deliberate — if accumulation silently loses a call, settlement charges less than
was spent, and the reconciler's conservative path is what catches a job that dies mid-flight.

**With no database or no signed-in user this is entirely inert**, which is what keeps `./run.sh`
and the test suite behaving exactly as before.
"""
from __future__ import annotations

import contextvars
import threading
import uuid
from dataclasses import dataclass, field

from . import config, logging_config, quotas, spend_limits

log = logging_config.get("spend_ceiling")


@dataclass
class _Held:
    """One job's reservation, its dispatch attempt, and the real cost observed under it."""

    reservation_id: str
    user_id: str
    attempt_id: str
    spent_nanousd: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, nanousd: int) -> None:
        if nanousd <= 0:
            return
        with self.lock:
            self.spent_nanousd += nanousd


#: The reservation covering work on this thread, or None. Set by the job registry around a worker.
_active: contextvars.ContextVar[_Held | None] = contextvars.ContextVar(
    "rc_active_reservation", default=None,
)


def active() -> _Held | None:
    return _active.get()


def bind(held: _Held | None):
    return _active.set(held)


def reset(token) -> None:
    _active.reset(token)


def note_spend(nanousd: int) -> None:
    """Add one call's real cost to the reservation covering this thread, if any.

    Called from `usage.record`, the single seam every metered call already passes through. Never
    raises: accounting must not break the call it is measuring.
    """
    try:
        held = _active.get()
        if held is not None:
            held.add(int(nanousd))
    except Exception as e:  # noqa: BLE001 — see the module docstring on rule 5
        log.warning("spend accumulation skipped (error=%s)", type(e).__name__)


def hold(operation: str, job_id: str, *, model: str | None = None,
         provider: str = "openrouter", lease_seconds: int = 3600) -> _Held | None:
    """Reserve this account's pessimistic maximum for one job, or raise if it cannot be afforded.

    Returns None when ceilings are inert (no database, or nobody signed in). Raises
    `quotas.QuotaExceeded` when the account is out of budget and `quotas.QuotaUnavailable` when the
    ledger cannot be reached — both fail closed by design, because a ceiling that opens when its
    store is unreachable is not a ceiling.
    """
    if not spend_limits.enabled():
        return None
    user_id = config.active_user_id()
    maximum = spend_limits.max_cost_nanousd(operation)
    reservation = quotas.reserve(
        user_id=user_id,
        project_id=config.active_project_id(),
        # Unique per admission. The key is an idempotency handle, and `reserve` refuses to reuse
        # one whose reservation is no longer `reserved` — so a key derived from the job id alone
        # breaks permanently for any job whose id is stable across runs. `graph_jobs` uses the
        # project id AS the job id, so every build after the first raised ReservationConflict.
        reservation_key=f"{operation}:{job_id}:{uuid.uuid4().hex}",
        job_id=job_id,
        provider=provider,
        operation=operation,
        model=model,
        maximum_cost_nanousd=maximum,
        limit_nanousd=spend_limits.monthly_limit_nanousd(),
        lease_seconds=lease_seconds,
    )
    # Mark the dispatch immediately, not lazily at first spend. Two reasons, both from the ledger's
    # own design: `settle` REFUSES a reservation that was never dispatched (so settling without
    # this is structurally impossible, which is what made the first version of this a no-op), and
    # a process death after this point leaves a *dispatched* row that the reconciler settles
    # conservatively — over-charging a possibly-billed attempt rather than silently losing spend,
    # which is the trade `04-ai-costs-quotas-and-abuse.md` states explicitly.
    attempt, _created = quotas.begin_attempt(
        reservation.id,
        user_id=user_id,
        attempt_key=f"{job_id}:work",
        maximum_cost_nanousd=maximum,
    )
    return _Held(reservation_id=reservation.id, user_id=user_id, attempt_id=attempt.id)


def release(held: _Held | None) -> None:
    """Give back an unused reservation — the admission failed before any work ran.

    Best-effort on purpose: a release that cannot reach the database leaves a lease the reconciler
    expires later, and raising here would replace the original admission failure with a database
    error, making the real cause impossible to diagnose (the same reasoning as
    `JobRegistry._rollback_preparation`).
    """
    if held is None:
        return
    try:
        quotas.release(held.reservation_id, user_id=held.user_id)
    except Exception as e:  # noqa: BLE001
        log.warning("reservation release failed (id=%s error=%s)",
                    held.reservation_id[:8], type(e).__name__)


def settle(held: _Held | None) -> None:
    """Charge what was actually spent and hand back the rest.

    A job that spent nothing still settles — at zero — rather than being released, so the ledger
    records that the admission was used rather than abandoned.
    """
    if held is None:
        return
    with held.lock:
        spent = held.spent_nanousd
    try:
        # The ledger's state machine, in the order it requires: resolve the dispatch to its actual
        # cost, declare dispatching finished, then settle exactly. An exact settle is rejected
        # unless the resolved attempts sum to the settled amount, so these three are one operation.
        quotas.resolve_attempt(held.attempt_id, user_id=held.user_id, actual_nanousd=spent)
        quotas.mark_dispatches_complete(held.reservation_id, user_id=held.user_id)
        quotas.settle(held.reservation_id, user_id=held.user_id, actual_nanousd=spent)
    except Exception as e:  # noqa: BLE001 — a settle failure must not turn a finished job into an
        # error the reader sees. The lease expires and the reconciler settles it conservatively,
        # which over-charges rather than losing the spend.
        #
        # Logged at ERROR, not WARNING: the first version of this swallowed a ReservationConflict
        # at warning level on EVERY job, so a ceiling that never recorded anything looked healthy.
        # A conflict here means the integration is wrong, not that the database blipped.
        log.error("reservation settle failed (id=%s error=%s) — the ceiling did not record this "
                  "job's spend", held.reservation_id[:8], type(e).__name__)
