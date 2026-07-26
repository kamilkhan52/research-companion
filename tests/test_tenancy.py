"""Ownership: recording who owns what, and refusing a connection string we cannot use correctly.

Two kinds of test here. The URL and migration-ordering checks are pure and always run. The rest
need a real Postgres and are skipped without `RC_TEST_DATABASE_URL` — CI provides one as a service
container, so they run there on every push. They are not mocked: the properties worth asserting are
the CHECK constraint, the foreign key, `on conflict do nothing`, and idempotent re-runs, and a fake
would be asserting my own idea of what Postgres does rather than what it does.
"""
from __future__ import annotations

import os

import pytest
from app import db, tenancy

OWNER = "f4a33e1b-b3c4-4eb2-a0ea-d110b36a072e"
OTHER = "c3fa116b-f010-4d95-8aae-6dc13e1292a4"


# --- always run: configuration, which is where a mistake is silent and expensive ---------------

def test_the_transaction_pooler_is_refused_with_its_reason():
    """Port 6543 does not support prepared statements, and psycopg prepares automatically once a
    query repeats — so accepting it would fail LATER, under load, on whichever query crossed the
    threshold first. That is the failure this refusal exists to convert into a startup error."""
    with pytest.raises(db.DatabaseError, match="transaction pooler"):
        db.assert_usable_url("postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres")


def test_the_direct_connection_and_session_pooler_are_accepted():
    """Both of Supabase's recommendations for a persistent server. The session pooler shares port
    5432 with the direct connection, so a port check alone must not reject it."""
    db.assert_usable_url("postgresql://u:p@db.abcdefghij.supabase.co:5432/postgres")
    db.assert_usable_url("postgresql://postgres.abc:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres")


@pytest.mark.parametrize("bad", [
    "mysql://u:p@host/db",
    "not a url at all",
    "postgresql:///onlyapath",
])
def test_unusable_urls_are_refused(bad):
    with pytest.raises(db.DatabaseError):
        db.assert_usable_url(bad)


def test_an_unset_url_is_not_an_error():
    """No database configured is a supported state, not a misconfiguration — it is how local dev
    and the rest of this suite run."""
    db.assert_usable_url("")


def test_the_connection_string_never_appears_in_what_we_print():
    """RC_DATABASE_URL is a Fly secret. `safe_target` is what error messages and log lines use, so
    a password reaching it would reach wherever those are shipped — and stop being revocable by
    rotating one place."""
    secret = "postgresql://postgres:sup3r-s3cret@db.abc.supabase.co:5432/postgres"
    shown = db.safe_target(secret)
    assert "sup3r-s3cret" not in shown
    assert "postgres:" not in shown
    assert shown == "db.abc.supabase.co:5432/postgres"


def test_migrations_are_applied_in_filename_order():
    """Order is the entire correctness property of a migration set, and `Path.glob` does not
    promise one — so this asserts the sort, not the enumeration."""
    names = [p.name for p in db._migration_files()]
    assert names == sorted(names)
    assert names and names[0].startswith("0001_")


def test_uuid_validation_rejects_what_would_become_a_cast_error():
    assert db.is_uuid(OWNER)
    assert not db.is_uuid("")
    assert not db.is_uuid("../../etc/passwd")
    assert not db.is_uuid("f4a33e1b-b3c4-4eb2-a0ea")


def test_everything_is_a_no_op_without_a_database(monkeypatch):
    """The fallback that keeps this slice safe to merge: with no database the app behaves exactly
    as it does today, so nothing can start refusing requests because a secret is missing."""
    monkeypatch.delenv("RC_DATABASE_URL", raising=False)
    assert not tenancy.enabled()
    tenancy.ensure_user(OWNER)          # no error, no connection attempted
    tenancy.record_project("x", OWNER)
    assert tenancy.owner_of("x") is None
    assert tenancy.projects_owned_by(OWNER) == set()
    with pytest.raises(tenancy.TenancyError):
        tenancy.backfill(OWNER, ["x"])  # backfill is explicit, so silence would be wrong here


# --- need a real Postgres ----------------------------------------------------------------------

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run these")


@pytest.fixture
def database(monkeypatch):
    """A migrated, empty schema per test. Drops the tables rather than the database so the fixture
    works against a shared CI service container."""
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    with db.pool().connection() as conn:
        conn.execute("drop table if exists rc_projects, rc_users, rc_schema_migrations cascade")
    db.migrate()
    yield
    db.close()


@needs_pg
def test_migrations_are_idempotent(database):
    """Applied on every boot, so a second call must do nothing rather than fail on an existing
    table."""
    assert db.migrate() == []


@needs_pg
def test_ownership_round_trips(database):
    tenancy.ensure_user(OWNER, "reader@example.com")
    tenancy.record_project("llm-basics", OWNER)
    assert tenancy.owner_of("llm-basics") == OWNER
    assert tenancy.projects_owned_by(OWNER) == {"llm-basics"}


@needs_pg
def test_recording_never_silently_changes_an_owner(database):
    """`on conflict do nothing`, not `do update`. A transfer should be an explicit operation that
    says so — not a side effect of a create or a re-run of the backfill."""
    tenancy.ensure_user(OWNER)
    tenancy.ensure_user(OTHER)
    tenancy.record_project("shared", OWNER)
    tenancy.record_project("shared", OTHER)
    assert tenancy.owner_of("shared") == OWNER


@needs_pg
def test_a_project_id_that_is_not_a_safe_path_segment_cannot_be_stored(database):
    """The id is a directory name under PROJECTS_ROOT. `projects._safe_pid` is the trust boundary;
    this constraint states the same rule independently, so a row that could not be turned back into
    a safe path cannot exist in the first place."""
    tenancy.ensure_user(OWNER)
    import psycopg
    for hostile in ["../escape", "/abs", "Upper", "has space", ""]:
        with pytest.raises(psycopg.errors.CheckViolation):
            tenancy.record_project(hostile, OWNER)


@needs_pg
def test_a_project_cannot_be_owned_by_a_user_that_does_not_exist(database):
    """The foreign key. Without it a typo'd owner id would produce a project nobody can ever reach
    and nobody can be shown to own."""
    import psycopg
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        tenancy.record_project("orphan", OTHER)


@needs_pg
def test_ensure_user_refreshes_an_email_but_does_not_erase_one(database):
    """A user can change their email with the identity provider, so a stale copy is worse than
    none — but a sign-in that carries no email must not wipe what is already known."""
    tenancy.ensure_user(OWNER, "old@example.com")
    tenancy.ensure_user(OWNER, "new@example.com")
    with db.pool().connection() as conn:
        assert conn.execute("select email from rc_users where id = %s", (OWNER,)).fetchone()[0] \
            == "new@example.com"
    tenancy.ensure_user(OWNER, None)
    with db.pool().connection() as conn:
        assert conn.execute("select email from rc_users where id = %s", (OWNER,)).fetchone()[0] \
            == "new@example.com"


@needs_pg
def test_backfill_is_idempotent_and_reports_a_re_run_as_a_no_op(database):
    """It will be run more than once — before and after the enforcement slice, and again if it is
    interrupted — so a second run must adopt nothing and say so."""
    first = tenancy.backfill(OWNER, ["a", "b"])
    assert sorted(first["adopted"]) == ["a", "b"]
    assert first["already_owned"] == []

    second = tenancy.backfill(OWNER, ["a", "b"])
    assert second["adopted"] == []
    assert sorted(second["already_owned"]) == ["a", "b"]


@needs_pg
def test_backfill_does_not_steal_a_project_that_is_already_owned(database):
    """The case that makes an idempotent backfill safe to re-run after real users exist."""
    tenancy.ensure_user(OTHER)
    tenancy.record_project("theirs", OTHER)

    result = tenancy.backfill(OWNER, ["mine", "theirs"])
    assert result["adopted"] == ["mine"]
    assert tenancy.owner_of("theirs") == OTHER


@needs_pg
def test_backfill_refuses_an_owner_that_is_not_a_user_id(database):
    with pytest.raises(tenancy.TenancyError):
        tenancy.backfill("not-a-uuid", ["a"])
