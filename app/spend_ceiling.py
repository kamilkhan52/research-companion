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

import contextlib
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
    operation: str = ""
    job_id: str = ""
    #: What this reservation held. Needed because settling EXACTLY is only honest when every
    #: billed request's cost was actually observed; when one was not, this is what we fall back to.
    maximum_nanousd: int = 0
    #: Set when a request was billed but its cost could not be read — OpenRouter accepted the
    #: generation and returned an id, but the usage block was missing or malformed. Analytics can
    #: reconcile that later from the generation id; the RESERVATION cannot, because settling is
    #: terminal. So an uncertain hold settles at its maximum instead of at the subset it happened
    #: to see, which over-charges rather than letting real spend escape the ceiling entirely.
    uncertain: bool = False
    #: HTTP requests actually put on the wire to a billing provider under this reservation, and
    #: how many of them we managed to price. Counted at the transport seam rather than inferred
    #: from the agent's own result, because a request that OpenRouter processes and BILLS but whose
    #: response is lost in transit produces neither a captured `ModelResponse` nor a `requests`
    #: increment — pydantic-ai counts a request only once a response returns or a stream opens. So
    #: the run looked, from every signal above the socket, exactly like a run that never happened.
    dispatched: int = 0
    priced: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, nanousd: int) -> None:
        if nanousd <= 0:
            return
        with self.lock:
            self.spent_nanousd += nanousd

    def mark_uncertain(self) -> None:
        with self.lock:
            self.uncertain = True

    def note_dispatch(self) -> None:
        with self.lock:
            self.dispatched += 1

    def note_not_billed(self) -> None:
        """A dispatch that provably cost nothing — the provider refused it before generating."""
        with self.lock:
            self.dispatched = max(0, self.dispatched - 1)

    def note_priced(self) -> None:
        with self.lock:
            self.priced += 1



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


def note_uncertain_spend() -> None:
    """Record that a request was billed under this thread's reservation at an unknown price.

    The gap this closes: `usage.record_pending` writes a reconcilable analytics marker, which is
    the right answer for the ledger a human reads — the cost turns up later from the generation id.
    But the RESERVATION is settled terminally the moment the job ends, and `usage.reconcile()`
    cannot reopen it. So a run whose first generation cost $0.004 and whose second returned an id
    with no usable cost used to settle at exactly $0.004, and the second generation left the
    account's monthly ceiling permanently. Never raises: same rule as `note_spend`.
    """
    try:
        held = _active.get()
        if held is not None:
            held.mark_uncertain()
    except Exception as e:  # noqa: BLE001 — see the module docstring on rule 5
        log.warning("uncertainty flag skipped (error=%s)", type(e).__name__)


def note_dispatch() -> None:
    """One HTTP request is going to a billing provider under this thread's reservation.

    Paired with `note_priced` when its cost is successfully read. Anything left over at settle time
    was put on the wire and never accounted for, which is the only honest description of a request
    whose response never came back. Never raises.
    """
    try:
        held = _active.get()
        if held is not None:
            held.note_dispatch()
    except Exception as e:  # noqa: BLE001 — see the module docstring on rule 5
        log.warning("dispatch count skipped (error=%s)", type(e).__name__)


def note_not_billed() -> None:
    """The provider refused a dispatch before generating anything, so it cost nothing.

    Without this every auth failure and rate-limit rejection would look like an unaccounted
    dispatch and settle the whole reservation at its maximum — turning a refused request into a
    charge, which is worse than the gap it is here to close.
    """
    try:
        held = _active.get()
        if held is not None:
            held.note_not_billed()
    except Exception as e:  # noqa: BLE001
        log.warning("non-billable dispatch not discounted (error=%s)", type(e).__name__)


def note_priced_dispatch() -> None:
    """A dispatch whose actual cost was read and recorded. Balances `note_dispatch`."""
    try:
        held = _active.get()
        if held is not None:
            held.note_priced()
    except Exception as e:  # noqa: BLE001
        log.warning("priced dispatch not counted (error=%s)", type(e).__name__)


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


#: Which provider each operation actually bills. `quota_reconciler` branches on this — it looks up
#: OpenRouter generation stats to recover an orphan's cost — so labelling a TTS reservation
#: "openrouter" would send it hunting for a generation id that never existed.
_PROVIDER = {"speech_synthesis": "openai"}


def hold(operation: str, job_id: str, *, model: str | None = None,
         provider: str | None = None, lease_seconds_override: int | None = None,
         maximum_nanousd: int | None = None) -> _Held | None:
    """Reserve this account's pessimistic maximum for one job, or raise if it cannot be afforded.

    Returns None when ceilings are inert (no database, or nobody signed in). Raises
    `quotas.QuotaExceeded` when the account is out of budget and `quotas.QuotaUnavailable` when the
    ledger cannot be reached — both fail closed by design, because a ceiling that opens when its
    store is unreachable is not a ceiling.
    """
    if not spend_limits.enabled():
        return None
    user_id = config.active_user_id()
    # An explicit maximum is for work whose size is known at admission and varies hugely — a
    # graph build extracts only its UNCACHED papers, so a flat corpus-sized hold would refuse
    # every rebuild of a large project while a flat small one would let the first build overshoot.
    maximum = maximum_nanousd or spend_limits.max_cost_nanousd(operation)
    reservation = quotas.reserve(
        user_id=user_id,
        project_id=config.active_project_id(),
        # Unique per admission. The key is an idempotency handle, and `reserve` refuses to reuse
        # one whose reservation is no longer `reserved` — so a key derived from the job id alone
        # breaks permanently for any job whose id is stable across runs. `graph_jobs` uses the
        # project id AS the job id, so every build after the first raised ReservationConflict.
        reservation_key=f"{operation}:{job_id}:{uuid.uuid4().hex}",
        job_id=job_id,
        provider=provider or _PROVIDER.get(operation, "openrouter"),
        operation=operation,
        model=model,
        maximum_cost_nanousd=maximum,
        limit_nanousd=spend_limits.monthly_limit_nanousd(),
        lease_seconds=lease_seconds_override or spend_limits.lease_seconds(operation),
    )
    # Mark the dispatch immediately, not lazily at first spend. Two reasons, both from the ledger's
    # own design: `settle` REFUSES a reservation that was never dispatched (so settling without
    # this is structurally impossible, which is what made the first version of this a no-op), and
    # a process death after this point leaves a *dispatched* row that the reconciler settles
    # conservatively — over-charging a possibly-billed attempt rather than silently losing spend,
    # which is the trade `04-ai-costs-quotas-and-abuse.md` states explicitly.
    try:
        attempt, _created = quotas.begin_attempt(
            reservation.id,
            user_id=user_id,
            attempt_key=f"{job_id}:work",
            maximum_cost_nanousd=maximum,
        )
    except BaseException:
        # The reservation exists but nothing points at it: `owns_hold` is only set once `hold`
        # RETURNS, so the registry's rollback would not release it either. Left alone it sits at
        # full maximum against the month for the whole lease — six hours for a graph build — for
        # work that never started. Releasing is legal precisely here: it is not yet dispatched,
        # which is the one case `release` below cannot handle.
        _discard_undispatched(reservation.id, user_id)
        raise
    return _Held(reservation_id=reservation.id, user_id=user_id, attempt_id=attempt.id,
                 operation=operation, job_id=job_id, maximum_nanousd=maximum)


def _discard_undispatched(reservation_id: str, user_id: str) -> None:
    """Give back a reservation that was never marked dispatched. Best-effort."""
    try:
        quotas.release(reservation_id, user_id=user_id)
    except Exception as e:  # noqa: BLE001 — must not replace the failure that brought us here
        log.warning("could not release an undispatched reservation (id=%s error=%s)",
                    reservation_id[:8], type(e).__name__)


def release(held: _Held | None) -> None:
    """Give back a reservation whose work never ran — settled at zero, not released.

    `quotas.release` is unreachable from here and must not be called: `hold` marks the reservation
    dispatched (it has to — `settle` refuses one that was not), and the ledger refuses to release
    anything dispatched, on the principle that possibly-billed work is settled rather than
    discarded. Calling it made both rollback paths in `start_or_join` silent no-ops, so an
    admission that aborted before its worker started left a full-maximum hold counting against the
    month for the whole lease — up to six hours for a graph build — and the reconciler then charged
    it at that maximum.

    Settling at zero is the honest equivalent: nothing was spent, and the ledger records the
    admission as finished rather than leaving an orphan for the reconciler to over-charge.

    Best-effort, like the old path: a failure here must not replace the original admission error,
    which is what a caller actually needs to see (same reasoning as
    `JobRegistry._rollback_preparation`).
    """
    if held is None:
        return
    try:
        quotas.resolve_attempt(held.attempt_id, user_id=held.user_id, actual_nanousd=0)
        quotas.mark_dispatches_complete(held.reservation_id, user_id=held.user_id)
        quotas.settle(held.reservation_id, user_id=held.user_id, actual_nanousd=0)
    except Exception as e:  # noqa: BLE001
        log.warning("reservation rollback failed (id=%s error=%s) — the lease will expire",
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
        # Conservative when a billed request's cost was never observed. Exactness is a claim we
        # have to earn: "this run cost $X" asserts that the requests we could not price were free.
        # Over-charging is recoverable — a reader sees a high number and the reconciled analytics
        # can correct it — whereas under-settling removes real spend from the ceiling for good.
        #
        # Two ways to be uncertain. The provider returned a response we could not read a cost from
        # (`uncertain`, set by the recorder), or a request went out and nothing came back at all
        # (`dispatched > priced`). The second is invisible to every signal above the socket:
        # pydantic-ai counts a request only once a response returns or a stream opens, so a
        # dispatch that OpenRouter billed and then lost in transit looks exactly like a run that
        # never happened.
        unaccounted = max(0, held.dispatched - held.priced)
        if unaccounted and not held.uncertain:
            log.warning(
                "reservation %s has %d dispatch(es) put on the wire with no cost read back "
                "(operation=%s)", held.reservation_id[:8], unaccounted, held.operation,
            )
            held.uncertain = True
        if held.uncertain and held.maximum_nanousd > spent:
            log.warning(
                "reservation %s settling at its maximum: a billed request under it had no "
                "readable cost (operation=%s observed=%d maximum=%d)",
                held.reservation_id[:8], held.operation, spent, held.maximum_nanousd,
            )
            spent = held.maximum_nanousd
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


@contextlib.contextmanager
def per_unit(operation: str, job_id: str, *, model: str | None = None):
    """Hold, bind and settle ONE unit of repeated paid work inside a job that does many.

    A job that loops — ten authors, N papers — cannot be gated by its admission ticket alone. One
    hold sized for one unit under-reserves by the loop count; one sized for the whole loop refuses
    readers who could comfortably afford part of it, and parks a large slice of the month in budget
    that mostly never becomes spend. Neither is what a ceiling is for.

    Gating per unit gives the honest answer to both: the account is checked against what the next
    unit costs, and a reader with room for three authors gets three rather than nothing. It is the
    same shape `paper-references` gives a graph build, where the build's own hold is nominal and
    each paper holds for itself.

    Rebinding is deliberate: `usage.record` credits whatever reservation is bound on this thread,
    so the unit's spend lands on the unit's hold, and the job's ticket is restored on exit. Raises
    `quotas.QuotaError` when the account cannot afford this unit or the ledger is unreachable —
    the caller decides whether that ends the job or just this unit. Nothing is bound and nothing
    settled when it raises, so a refused unit leaves the parent's ticket exactly as it was.

    **It will not unbind an active parent.** `hold` returns None when ceilings are inert, and
    binding that None over a live parent reservation would silently send the unit's spend nowhere
    — the fail-open shape `config.bound_scope` exists to prevent, since a missing project corrupts
    files loudly but a missing reservation just loses money. Inside a job the registry has already
    bound a hold, so a None here means the precondition changed underneath us; the parent keeps the
    spend rather than the ceiling quietly switching off.
    """
    held = hold(operation, job_id, model=model)
    # See above: only rebind when we actually got a hold, or when there is nothing to displace.
    token = bind(held) if (held is not None or _active.get() is None) else None
    try:
        yield held
    finally:
        # Nested, not sequential: sharing one `finally` meant a failed `reset` skipped `settle`,
        # leaking the hold until its lease expired — at which point the reconciler charges the
        # FULL maximum rather than what was spent.
        try:
            if token is not None:
                reset(token)
        finally:
            settle(held)
