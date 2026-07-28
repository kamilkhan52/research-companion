"""Google Play's AI-Generated Content policy (verified 2026-07-28) requires an app whose content is
AI-generated to let users "report or flag offensive content to developers without needing to exit
the app", and to use those reports for moderation. Everything this app shows is model output, so
the requirement applies to all of it. These pin the parts a silent regression would break."""
from __future__ import annotations

import os

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
def test_an_unknown_surface_or_reason_is_refused(database):
    """Constrained in Python AND by a CHECK. A value no moderation query looks for is the same as
    a lost report, so it must fail at the boundary rather than be stored."""
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
