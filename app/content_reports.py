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
# One reader cannot bury the queue. Deliberately generous — the cost of losing a real report is
# higher than the cost of storing a few duplicates — and counted over a rolling day rather than
# reset at midnight, so it cannot be gamed by waiting for a boundary.
DAILY_LIMIT = 50


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

    # The row references rc_users, so the reporter must exist there. A reader who has never tripped
    # any other database path would otherwise have a valid JWT and a foreign-key violation.
    tenancy.ensure_user(user_id)

    with db.pool().connection() as conn:
        recent = conn.execute(
            "select count(*) from rc_content_reports "
            "where reporter_id = %s and created_at > now() - interval '1 day'",
            (user_id,),
        ).fetchone()[0]
        if recent >= DAILY_LIMIT:
            raise ContentReportError(
                "Too many reports from this account today. Try again tomorrow.")
        row = conn.execute(
            "insert into rc_content_reports "
            "(reporter_id, project_id, paper_slug, reference, surface, reason, reporter_note) "
            "values (%s, %s, %s, %s, %s, %s, %s) returning id::text, created_at",
            (user_id, project_id, paper_slug, reference, surface, reason, note),
        ).fetchone()

    # Logged so an operator sees the queue growing without polling the database, and at INFO because
    # a report is a normal event. The note is NOT logged: it is the reporter's free text and can
    # contain anything, including quoted content and personal detail.
    log.info(
        "content report received surface=%s reason=%s project=%s",
        surface, reason, project_id or "-",
    )
    return {"id": row[0], "created_at": row[1].isoformat()}


def pending_count() -> int:
    """How many reports are waiting on an operator. The review workflow itself is M7."""
    if not available():
        return 0
    with db.pool().connection() as conn:
        return conn.execute(
            "select count(*) from rc_content_reports where reviewed_at is null",
        ).fetchone()[0]
