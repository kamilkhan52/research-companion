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


def test_a_malformed_connection_string_never_leaks_the_password(caplog):
    """psycopg quotes the offending token verbatim — a mistyped password yields
    `invalid percent-encoded token: "p%zzword"` — and psycopg_pool logs connection failures at
    WARNING. So the parse has to happen here, where the error can be sanitized, or the secret ends
    up in the Fly logs in plaintext and rotating it is the only remedy."""
    secret = "postgresql://postgres:p%zzword with space@db.abc.supabase.co:5432/postgres"
    with caplog.at_level("DEBUG"):
        with pytest.raises(db.DatabaseError) as excinfo:
            db.assert_usable_url(secret)

    rendered = f"{excinfo.value}{excinfo.value.__cause__}{excinfo.value.__context__}{caplog.text}"
    assert "zzword" not in rendered
    assert "db.abc.supabase.co:5432/postgres" in str(excinfo.value)  # still says WHICH database


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
    for hostile in ["../escape", "/abs", "has space", "with/slash", "", "dot.dot"]:
        with pytest.raises(psycopg.errors.CheckViolation):
            tenancy.record_project(hostile, OWNER)


@needs_pg
def test_the_constraint_accepts_everything_the_trust_boundary_does(database):
    """The constraint must RESTATE `_safe_pid`, not tighten it.

    A stricter database rule creates a class of project the app can create on disk and then cannot
    record — and since the backfill walks every existing project, one such id aborts it part-way
    with a raw constraint violation.

    Generated rather than listed. The fixed list this replaced looked thorough and still missed the
    real divergence: Python's `$` matches before a trailing newline, so `_safe_pid("project\n")`
    was accepted while Postgres — which has no such rule — rejected it. A sample only ever tests
    the cases you already thought of, so this drives the boundary itself and asserts the property.
    """
    from app import projects as projects_module

    tenancy.ensure_user(OWNER)
    candidates = [
        "llm-basics", "My_Project", "Vaccines", "x_y", "default", "3d-dram", "a",
        "a" * 255,                      # the longest a path segment can be
        "a" * 256, "project\n", "pro\nject", "", "-lead", "_lead", "has space",
        "../escape", "/abs", "dot.dot", "with/slash", "tab\there", "ünicode", "a\r",
    ]
    for pid in candidates:
        try:
            projects_module._safe_pid(pid)
        except projects_module.ProjectError:
            continue  # the boundary rejects it; the database's opinion does not matter
        # The boundary accepted it, so the database MUST be able to store it.
        tenancy.record_project(pid, OWNER)
        assert tenancy.owner_of(pid) == OWNER, f"{pid!r} passed _safe_pid but was not recorded"


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


@needs_pg
def test_two_processes_migrating_at_once_do_not_fight(database):
    """A Fly deploy overlaps the old and new machines, so two processes can call `migrate()` at the
    same moment even though each is a single worker. Without the advisory lock both read the same
    "unseen" set, both run the DDL, and the loser dies on the duplicate primary key — a deployment
    that fails at startup even though the schema is correct."""
    import concurrent.futures

    with db.pool().connection() as conn:
        conn.execute("drop table if exists rc_projects, rc_users, rc_schema_migrations cascade")

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool_:
        results = [f.result() for f in [pool_.submit(db.migrate) for _ in range(4)]]

    # Exactly one caller should have applied it; the rest see it already done. What must NOT happen
    # is an exception, which is what `.result()` above would have raised.
    assert sum(1 for r in results if r) == 1
    with db.pool().connection() as conn:
        assert conn.execute("select count(*) from rc_schema_migrations").fetchone()[0] == \
            len(db._migration_files())


@needs_pg
def test_deleting_a_user_cannot_silently_orphan_their_projects(database):
    """RESTRICT, not CASCADE. A project is a directory with a git history in it and no foreign key
    can delete that — so cascading would drop the ownership row while leaving the reading on disk,
    and the next backfill would adopt one person's papers under whoever RC_ADOPT_OWNER names."""
    import psycopg

    tenancy.ensure_user(OWNER)
    tenancy.record_project("theirs", OWNER)

    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        with db.pool().connection() as conn:
            conn.execute("delete from rc_users where id = %s", (OWNER,))

    assert tenancy.owner_of("theirs") == OWNER


def test_an_ambiguous_connection_string_is_refused_rather_than_guessed():
    """An unescaped `/` in a password silently redraws the URL: in
    `postgresql://user:12/34@db.example.com:5432/postgres` the authority ends at that slash, so the
    parse reports host `user`, port `12` and a database name containing the rest — and rendering
    "host:port/database" from that prints part of the PASSWORD."""
    leaky = "postgresql://postgres:123/rest@db.abc.supabase.co:5432/postgres"
    assert db.safe_target(leaky) == "?"
    assert "123" not in db.safe_target(leaky)
    with pytest.raises(db.DatabaseError, match="ambiguous"):
        db.assert_usable_url(leaky)


def test_a_percent_encoded_password_still_identifies_the_database():
    """The fail-closed rule must not swallow a correctly-escaped password — otherwise every error
    message says `?` and the operator cannot tell which database failed."""
    fine = "postgresql://postgres:p%2Fw%40x@db.abc.supabase.co:5432/postgres"
    assert db.safe_target(fine) == "db.abc.supabase.co:5432/postgres"
    db.assert_usable_url(fine)


def test_a_trailing_newline_is_not_a_project_id():
    """Python's `$` matches immediately before a final newline, so `_PID_RE.match("project\n")`
    succeeded and the id was accepted — as a directory name, a log line, and a database value that
    Postgres would reject, since its regexes have no such rule."""
    from app import projects as projects_module

    with pytest.raises(projects_module.ProjectError):
        projects_module._safe_pid("project\n")
