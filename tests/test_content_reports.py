"""Google Play's AI-Generated Content policy (verified 2026-07-28) requires an app whose content is
AI-generated to let users "report or flag offensive content to developers without needing to exit
the app", and to use those reports for moderation. Everything this app shows is model output, so
the requirement applies to all of it. These pin the parts a silent regression would break."""
from __future__ import annotations

import os
import threading

import pytest
from app import content_reports, db
from starlette.testclient import TestClient

USER_ID = "a3f0c8de-4b21-4d77-9f0e-2b6c5d1a7e44"
OTHER_ID = "b71e2c94-8d3a-4e15-bb27-5c9f0a2d6e83"

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run this")


@pytest.fixture
def database(monkeypatch):
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    with db.pool().connection() as conn:
        conn.execute(
            "drop table if exists rc_content_reports, rc_account_deletions, rc_project_trash, "
            "rc_user_settings, rc_projects, rc_users, rc_schema_migrations cascade",
        )
    db.migrate()
    yield
    db.close()


def _authenticated(monkeypatch, user_id=USER_ID):
    from app import auth
    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "check", lambda _t: {"user_id": user_id, "email": "r@example.com"})
    monkeypatch.setattr(auth, "allowed_users", frozenset)


def test_reporting_is_unavailable_without_a_database():
    """It must refuse loudly rather than accept and drop. A report that vanishes is worse than one
    refused: the reader believes they were heard and the moderation signal never arrives."""
    assert content_reports.available() is False
    with pytest.raises(content_reports.ContentReportError):
        content_reports.submit(USER_ID, surface="discussion", reason="offensive")


@needs_pg
def test_a_report_records_where_the_content_was_not_what_it_said(database):
    """Turns live in the git transcript, which is the record. A copy here could disagree with it,
    and would put reading content into a database that holds ownership and index rows only."""
    content_reports.submit(
        USER_ID,
        surface="discussion",
        reason="harmful",
        project_id="quantum",
        paper_slug="attention-is-all-you-need",
        reference="msg-42",
        reporter_note="Suggested an unsafe procedure.",
    )
    with db.pool().connection() as conn:
        row = conn.execute(
            "select project_id, paper_slug, reference, surface, reason, reporter_note, reviewed_at "
            "from rc_content_reports",
        ).fetchone()
    assert row[:5] == ("quantum", "attention-is-all-you-need", "msg-42", "discussion", "harmful")
    assert row[5] == "Suggested an unsafe procedure."   # the reporter's own words are kept
    assert row[6] is None                               # waiting on an operator
    assert content_reports.pending_count() == 1


@needs_pg
def test_a_long_but_legitimate_project_id_is_refused_clearly_not_as_a_server_error(database):
    """`_PID_MAX_LENGTH` is 255 and `slugify` does not truncate, so a project id far longer than a
    tidy one is entirely legitimate. A ceiling here that disagreed with that made a real project
    unreportable: the insert raised, the route returned 503 "please try again", and retrying could
    never succeed — the exact "a report that vanishes" failure this module exists to avoid."""
    at_the_limit = "p" * content_reports.PROJECT_ID_MAX
    content_reports.submit(
        USER_ID, surface="discussion", reason="offensive", project_id=at_the_limit)
    assert content_reports.pending_count() == 1

    with pytest.raises(content_reports.ContentReportError, match="too long"):
        content_reports.submit(
            USER_ID, surface="discussion", reason="offensive", project_id=at_the_limit + "p")
    assert content_reports.pending_count() == 1   # refused, not stored


@needs_pg
def test_the_schema_refuses_a_bad_surface_even_if_python_does_not(database):
    """The Python guard returns before the database sees anything, so the CHECKs had NO coverage —
    deleting `rc_content_reports_surface_allowed` left the suite green. Inserted directly, which is
    the only way to reach the constraint the schema claims to enforce."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        with db.pool().connection() as conn:
            conn.execute(
                "insert into rc_content_reports (reporter_id, surface, reason) "
                "values (%s, 'telepathy', 'offensive')",
                (USER_ID,),
            )


def test_a_forged_log_line_cannot_be_smuggled_through_a_project_id():
    """`project_id` is free text that never passes `_safe_pid`, and it lands LAST on a
    line-oriented formatter — so an embedded newline makes everything after it operator-visible
    output. stderr is the only place some signals exist at all (the stalled-deletion alert says so),
    which makes a convincing forged line an attack on the operator's view of the system."""
    forged = "ok\n19:00:00 ERROR rc.account-deletion [-] account deletion completed subject=fake"
    safe = content_reports._log_safe(forged)
    assert "\n" not in safe and "\r" not in safe
    assert content_reports._log_safe(None) == "-"
    assert content_reports._log_safe("") == "-"
    # Bounded too: an operator's line must not be pushed off screen by a 255-character pointer.
    assert len(content_reports._log_safe("p" * 255)) <= 64


@needs_pg
def test_an_unknown_surface_or_reason_is_refused(database):
    """Refused at the Python boundary. The schema CHECK is covered separately, above — this one
    cannot reach it, which is what an earlier version of this docstring got wrong."""
    for kwargs in ({"surface": "telepathy"}, {"reason": "vibes"}):
        call = {"surface": "discussion", "reason": "offensive", **kwargs}
        with pytest.raises(content_reports.ContentReportError):
            content_reports.submit(USER_ID, **call)
    assert content_reports.pending_count() == 0


@needs_pg
def test_one_account_cannot_bury_the_queue(database, monkeypatch):
    monkeypatch.setattr(content_reports, "DAILY_LIMIT", 3)
    for _ in range(3):
        content_reports.submit(USER_ID, surface="discussion", reason="offensive")
    with pytest.raises(content_reports.ContentReportError, match="Too many reports"):
        content_reports.submit(USER_ID, surface="discussion", reason="offensive")
    # The cap is per reporter, not global — one abuser must not silence everyone else.
    content_reports.submit(OTHER_ID, surface="notes", reason="other")
    assert content_reports.pending_count() == 4


@needs_pg
def test_a_concurrent_burst_cannot_exceed_the_cap(database, monkeypatch):
    """The cap is the only thing between one account and the whole moderation queue, so it has to
    hold under simultaneous requests, not merely sequential ones.

    Folding the count into the insert is NOT sufficient and this test is what proved it: under READ
    COMMITTED the sub-select reads a snapshot from statement start, so a burst landed 3 rows under a
    cap of 2. `submit` now takes a per-reporter advisory lock for the transaction.

    Keep this test even though it is a WEAK check of that fix: the overshoot is timing-dependent and
    does not reproduce on a fast local Postgres (the unfixed code passes here 3/3, and failed in
    CI). It is a canary, not a proof — `test_the_cap_is_serialized_per_reporter` below is the
    deterministic one.

    Six threads, not eight: the pool's `max_size` is 8, and a burst that needs every connection at
    once times out acquiring one — which fails the test without ever exercising the cap.
    """
    monkeypatch.setattr(content_reports, "DAILY_LIMIT", 2)
    threads_n = 6
    barrier = threading.Barrier(threads_n)
    accepted = []
    unexpected = []

    def fire():
        barrier.wait(timeout=10)
        try:
            content_reports.submit(USER_ID, surface="discussion", reason="offensive")
            accepted.append(1)
        except content_reports.ContentReportError:
            pass
        except Exception as e:  # noqa: BLE001 — a pool timeout must not read as "the cap held"
            unexpected.append(repr(e))

    threads = [threading.Thread(target=fire) for _ in range(threads_n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)

    assert not unexpected, f"submit failed for a reason other than the cap: {unexpected}"
    # Both halves matter: the second alone would pass if every request had been refused, and the
    # first alone would pass if the cap had let all six through.
    assert sum(accepted) == 2, f"expected exactly the cap to be accepted, got {sum(accepted)}"
    assert content_reports.pending_count() == 2


@needs_pg
def test_the_cap_is_serialized_per_reporter_and_only_per_reporter(database):
    """The deterministic half of the burst test above, which only reproduces under CI's timing.

    Holds the reporter's advisory lock from OUTSIDE and asserts that `submit` for that reporter
    blocks on it, while `submit` for a different reporter sails past. That is the whole property:
    the cap check and the insert are one critical section per account, and accounts do not contend
    with each other. Remove the `pg_advisory_xact_lock` line from `submit` and the first assertion
    fails immediately — which the burst test cannot promise on this machine.
    """
    finished = threading.Event()

    with db.pool().connection() as holder:
        # Session-scoped, so it outlives the statement and blocks the transaction-scoped lock
        # `submit` takes. Same key derivation, computed by the database exactly as `submit` does.
        holder.execute("select pg_advisory_lock(%s, hashtext(%s))",
                       (content_reports._LOCK_CLASS, USER_ID))

        def blocked_submit():
            content_reports.submit(USER_ID, surface="discussion", reason="offensive")
            finished.set()

        worker = threading.Thread(target=blocked_submit, daemon=True)
        worker.start()

        assert not finished.wait(timeout=2.0), (
            "submit did not wait on the reporter's lock, so the cap check and the insert are not "
            "one critical section")

        # A different reporter must not be stuck behind the first — one abuser cannot stall
        # everyone else's reports.
        content_reports.submit(OTHER_ID, surface="notes", reason="other")

        holder.execute("select pg_advisory_unlock(%s, hashtext(%s))",
                       (content_reports._LOCK_CLASS, USER_ID))
        assert finished.wait(timeout=10.0), "submit never completed after the lock was released"
        worker.join(timeout=10)

    assert content_reports.pending_count() == 2


@needs_pg
def test_deleting_an_account_takes_its_reports_with_it(database):
    """The same promise account deletion makes everywhere else. Asserted because the alternative —
    `on delete set null` — would silently leave the reporter's free-text note behind."""
    content_reports.submit(USER_ID, surface="discussion", reason="offensive",
                           reporter_note="my own words")
    assert content_reports.pending_count() == 1
    with db.pool().connection() as conn:
        conn.execute("delete from rc_users where id = %s", (USER_ID,))
    assert content_reports.pending_count() == 0


@needs_pg
def test_the_route_records_a_report_for_the_authenticated_reporter(database, monkeypatch):
    """In-app and without leaving the app is the policy requirement, so this is a plain POST that
    answers immediately rather than a job to poll."""
    _authenticated(monkeypatch)
    from app.main import app

    response = TestClient(app).post(
        "/api/reports/content",
        json={"surface": "discussion", "reason": "offensive", "reference": "msg-7"},
        headers={"Authorization": "Bearer valid"},
    )
    assert response.status_code == 201
    assert response.json()["report"]["id"]

    with db.pool().connection() as conn:
        reporter = conn.execute("select reporter_id::text from rc_content_reports").fetchone()[0]
    assert reporter == USER_ID   # taken from the verified JWT, never from the request body


@needs_pg
def test_the_route_refuses_an_unauthenticated_reporter(database, monkeypatch):
    from app import auth
    monkeypatch.setattr(auth, "enabled", lambda: False)
    from app.main import app

    response = TestClient(app).post(
        "/api/reports/content", json={"surface": "discussion", "reason": "offensive"})
    assert response.status_code == 401
    assert content_reports.pending_count() == 0
