"""Where a reader's report of offensive AI-generated content lands.

Google Play's AI-Generated Content policy (verified 2026-07-28) requires an app whose content is
AI-generated to "contain in-app user reporting or flagging features that allow users to report or
flag offensive content to developers without needing to exit the app", and to use those reports to
inform moderation. Everything this app shows a reader is model output, so the requirement applies
squarely.

**A report records a pointer, not the content.** The offending text is an assistant turn, and turns
live in the project's git transcript — the record (invariant 4). Copying it into Postgres would be a
second copy able to disagree with the first, and would put reading content into a database that
holds ownership and index rows only. What is stored is where to look, plus the reporter's own note,
which exists nowhere else.

Deliberately NOT gated on `tenancy.may_access`. A reader can be shown AI output about a project they
do not own — a shared or transferred project, or content generated before ownership moved — and the
one moment to capture a report is when someone is looking at something objectionable. The
`project_id` is a free-text pointer for an operator, never used to reach a file, so accepting one
the reporter does not own grants nothing; refusing it would lose the report.
"""
from __future__ import annotations

from . import db, logging_config, tenancy

log = logging_config.get("content-reports")

SURFACES = frozenset({"discussion", "narration", "discovery", "notes"})
REASONS = frozenset({
    "offensive", "harmful", "sexual", "violent", "harassment", "misinformation", "other",
})
NOTE_MAX = 2000
# Mirrors the column CHECKs exactly. Enforced here so an over-length value is a 422 the caller can
# act on, rather than a CheckViolation the route can only report as a 503 "please try again" that
# will never succeed. `PROJECT_ID_MAX` is `projects._PID_MAX_LENGTH`; a project id really can be
# that long, and an earlier, tighter ceiling made legitimate projects unreportable.
PROJECT_ID_MAX = 255
PAPER_SLUG_MAX = 256
REFERENCE_MAX = 256
# One reader cannot bury the queue. Deliberately generous — the cost of losing a real report is
# higher than the cost of storing a few duplicates — and counted over a rolling day rather than
# reset at midnight, so it cannot be gamed by waiting for a boundary.
DAILY_LIMIT = 50
# Advisory-lock namespace for the per-reporter cap. Distinct from `deploy_guard._LOCK_CLASS`
# (1_009_207) on purpose: advisory locks share one global space per database, so two features
# picking the same class would block each other for no reason anybody could later explain.
_LOCK_CLASS = 1_009_211


class ContentReportError(RuntimeError):
    """The report could not be accepted."""


def available() -> bool:
    """Reports need somewhere durable to land; without a database there is nowhere."""
    return db.enabled()


def submit(
    user_id: str,
    *,
    surface: str,
    reason: str,
    project_id: str | None = None,
    paper_slug: str | None = None,
    reference: str | None = None,
    reporter_note: str | None = None,
    email: str | None = None,
) -> dict:
    """Record one report. Raises `ContentReportError` rather than failing silently.

    A report that vanishes is worse than one refused: the reader believes they have been heard, and
    the moderation signal the policy asks for never arrives.
    """
    if not available():
        raise ContentReportError("Reporting is not configured on this server.")
    if surface not in SURFACES:
        raise ContentReportError("Unknown content surface.")
    if reason not in REASONS:
        raise ContentReportError("Unknown report reason.")
    note = (reporter_note or "").strip() or None
    if note is not None and len(note) > NOTE_MAX:
        raise ContentReportError(f"A note may be at most {NOTE_MAX} characters.")
    for label, value, ceiling in (
        ("project id", project_id, PROJECT_ID_MAX),
        ("paper slug", paper_slug, PAPER_SLUG_MAX),
        ("reference", reference, REFERENCE_MAX),
    ):
        if value is not None and len(value) > ceiling:
            raise ContentReportError(f"The {label} is too long to record.")

    # The row references rc_users, so the reporter must exist there. A reader who has never tripped
    # any other database path would otherwise have a valid JWT and a foreign-key violation.
    tenancy.ensure_user(user_id, email)

    with db.pool().connection() as conn, conn.transaction():
        # Serialized per reporter, and this took three attempts to get right.
        #
        # Two statements on an autocommit pool obviously race. Folding the count INTO the insert
        # looked like the fix and is not: under READ COMMITTED the sub-select still reads a snapshot
        # taken when the statement began, so concurrent inserts each count the rows that existed
        # before any of them committed and all of them pass a cap that only one should. That is not
        # a theory — `test_a_concurrent_burst_cannot_exceed_the_cap` failed on CI against a real
        # Postgres at 3 rows under a cap of 2, while passing locally because it SKIPPED with no
        # database configured. The narrower window read as a fix for exactly as long as nothing
        # measured it.
        #
        # So take a transaction-scoped advisory lock keyed on the reporter. It serializes only
        # concurrent reports BY THE SAME ACCOUNT — different reporters hash to different keys and
        # never wait on each other — and it is released by commit or rollback, so a failed insert
        # cannot strand it. `hashtext` keys in SQL rather than Python so the two can never disagree
        # about the hash.
        conn.execute("select pg_advisory_xact_lock(%s, hashtext(%s))", (_LOCK_CLASS, user_id))
        row = conn.execute(
            "insert into rc_content_reports "
            "(reporter_id, project_id, paper_slug, reference, surface, reason, reporter_note) "
            "select %s, %s, %s, %s, %s, %s, %s "
            "where (select count(*) from rc_content_reports "
            "       where reporter_id = %s and created_at > now() - interval '1 day') < %s "
            "returning id::text, created_at",
            (user_id, project_id, paper_slug, reference, surface, reason, note,
             user_id, DAILY_LIMIT),
        ).fetchone()
        if row is None:
            raise ContentReportError(
                "Too many reports from this account today. Try again tomorrow.")

    # Logged so an operator sees the queue growing without polling the database, and at INFO because
    # a report is a normal event. The note is NOT logged: it is the reporter's free text and can
    # contain anything, including quoted content and personal detail.
    log.info(
        "content report received surface=%s reason=%s project=%s",
        surface, reason, _log_safe(project_id),
    )
    return {"id": row[0], "created_at": row[1].isoformat()}


def _log_safe(value: str | None) -> str:
    """A caller-supplied value that cannot forge a log line.

    `surface` and `reason` are checked against fixed sets, but `project_id` is free text that never
    passes `_safe_pid`, and it lands LAST on a line-oriented plain-text formatter — so an embedded
    newline makes everything after it attacker-controlled output. That matters more here than it
    usually would: stderr is the only place several operator signals exist at all, including the
    stalled-deletion alert, so a convincing forged line is a real attack on the operator's view.
    """
    if not value:
        return "-"
    cleaned = "".join(ch for ch in value if ch.isprintable())
    return cleaned[:64] or "-"


def pending_count() -> int:
    """How many reports are waiting on an operator. The review workflow itself is M7."""
    if not available():
        return 0
    with db.pool().connection() as conn:
        return conn.execute(
            "select count(*) from rc_content_reports where reviewed_at is null",
        ).fetchone()[0]
