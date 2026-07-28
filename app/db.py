"""Postgres: the connection pool and the migration runner.

**What lives in Postgres, and what does not.** Ownership and index rows only. The content — papers,
notes, transcripts — stays in each project's git repository, because the git history *is* the
record (invariant 4: the agent proposes, a human approves, and only then does anything commit).
Putting content here as well would create a second source of truth that can disagree with the
record, so the schema deliberately stores no reading material.

**The database is optional.** With `RC_DATABASE_URL` unset there is no pool, `enabled()` is False,
and every caller falls back to the single-tenant behaviour the app has today. That is what lets a
local `./run.sh` and the whole test suite work with no server running, and it is why M2 can land in
reviewable slices instead of one commit that flips everything at once.
"""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from urllib.parse import urlsplit

from . import logging_config

log = logging_config.get("db")

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "supabase" / "migrations"

#: Supavisor's TRANSACTION pooler. Rejected rather than supported — see `assert_usable_url`.
_TRANSACTION_POOLER_PORT = 6543

#: Arbitrary but FIXED — every process must pick the same number for the lock to mean anything.
_MIGRATION_LOCK_KEY = 4_337_100_201

_pool = None
_pool_lock = threading.Lock()


class DatabaseError(Exception):
    """Something is wrong with the database or its configuration — maps to 500."""


def url() -> str:
    """The configured connection string, or "" when there is none.

    Read live rather than captured at import so a test can set it per-case, and so a restart with
    a new Fly secret picks it up without a code change.
    """
    return os.environ.get("RC_DATABASE_URL", "").strip()


def enabled() -> bool:
    return bool(url())


def _effective_params(raw: str) -> dict | None:
    """What libpq will ACTUALLY connect to, or None if it will not parse.

    psycopg's reading is the authority, because it is the one that connects. `urlsplit` below is a
    second opinion used only to detect disagreement.
    """
    try:
        from psycopg import conninfo

        return conninfo.conninfo_to_dict(raw)
    except Exception:
        return None


def _url_params(raw: str) -> dict | None:
    """The same three fields as `urlsplit` reads them, or None if it will not parse."""
    try:
        parts = urlsplit(raw)
        return {"host": parts.hostname, "port": parts.port,
                "dbname": parts.path.lstrip("/") or None}
    except ValueError:
        # Raises on some inputs (NFKC normalization) with the WHOLE netloc — credentials included —
        # in the message. Swallowed here; never re-raised or chained.
        return None


def _scheme_of(raw: str) -> str:
    """The URL scheme, or "" if it cannot be read.

    `urlsplit` raises `ValueError` on NFKC-sensitive input — a password containing a fullwidth `＠`,
    `／`, `？` or `：` — and the message embeds the WHOLE netloc, password included. Returning a
    sentinel keeps that exception inside this function, so the caller's `DatabaseError` is raised
    outside any `except` and never carries it as `__cause__` or `__context__`.
    """
    try:
        return urlsplit(raw).scheme
    except ValueError:
        return ""


def _parses_agree(raw: str) -> bool:
    """Whether both parsers see the same host, port and database.

    Validating with one parser while CONNECTING with another is how a check gets quietly bypassed.
    Three divergences, all verified against the installed psycopg:

    * `postgresql://u:123?secret@host:6543/db` — `urlsplit` treats `?` as the start of the query,
      so it reports host `u`, port `123`; psycopg reads the password as `123?secret` and connects
      to `host:6543`. The pooler refusal would test the wrong number, and `safe_target` would print
      `u:123` — the first half of the password.
    * `postgresql://u:p@host:5432/db?port=6543` — libpq honours query parameters, so the effective
      port is 6543 while `urlsplit` says 5432. The refusal is defeated by a query string.
    * `postgresql://u:p@host/db?host=other` — likewise for the host, so an error would name a
      database that was never contacted.

    Disagreement means the string cannot be reasoned about, so everything downstream fails closed.
    """
    # Agreement alone is NOT sufficient: `postgresql://u:12/34@h:5432/db` fools both parsers the
    # same way (host `u`, port 12, database `34@h:5432/db`), so they agree on an answer that is
    # entirely password. The structural check catches that — in a well-formed URL the credential
    # `@` precedes the first `/` after `//`, so an `@` after it means a delimiter escaped.
    after_scheme = raw.partition("://")[2]
    if not after_scheme:
        return False
    _authority, sep, rest = after_scheme.partition("/")
    if sep and "@" in rest:
        return False

    effective, plain = _effective_params(raw), _url_params(raw)
    if effective is None or plain is None:
        return False
    for key in ("host", "port", "dbname"):
        left, right = effective.get(key), plain.get(key)
        # libpq omits a key it was never given; urlsplit reports None. Compare as strings so that
        # 5432 and "5432" are the same answer.
        if (str(left) if left is not None else None) != (str(right) if right is not None else None):
            return False
    return True


def safe_target(raw: str = "") -> str:
    """`host:port/database` — never the credentials, and `?` whenever that cannot be guaranteed.

    Exists so errors and logs can say *which* database failed without the password travelling with
    them. A connection string is a Fly secret; the moment one reaches a log line it is in whatever
    ships those logs, and it stops being revocable by rotating one place. So this fails closed: an
    input the two parsers disagree about renders as `?` rather than a best guess, because a best
    guess is exactly how a fragment of a password gets printed.
    """
    raw = raw or url()
    if not raw or not _parses_agree(raw):
        return "?"

    # No credential `@`, but a `:` in the authority — `postgresql://postgres:1234/postgres`. Both
    # parsers read that as host `postgres`, port 1234, and they are RIGHT to: it is exactly what a
    # docker-compose DSN looks like. It is also exactly what a Supabase URL looks like with the
    # `@host` part accidentally dropped, in which case "port 1234" is the operator's password and
    # printing it puts the secret in the log. Nothing can tell those two apart, so this declines to
    # name the target rather than guess. The URL is still ACCEPTED and still connects — refusing it
    # would break the credential-less DSN that local development legitimately uses — and the cost
    # of `?` lands on local dev, where logs are not shipped anywhere. A deployed Supabase URL always
    # has an `@`, so production diagnosability is unaffected.
    authority = raw.partition("://")[2].partition("/")[0]
    if "@" not in authority and ":" in authority:
        return "?"

    effective = _effective_params(raw) or {}
    host = effective.get("host")
    if not host:
        return "?"
    port = f":{effective['port']}" if effective.get("port") else ""
    return f"{host}{port}/{effective.get('dbname') or '?'}"


def assert_usable_url(raw: str = "") -> None:
    """Refuse a connection string this backend cannot use correctly. Raises `DatabaseError`.

    The one that matters is Supabase's **transaction pooler on port 6543**, which does not support
    prepared statements. psycopg prepares automatically once a query repeats, so the failure would
    not appear at startup or on the first request — it would appear later, under load, on whichever
    query crossed the threshold first. Supabase's own guidance is that a persistent server (their
    docs name Fly.io explicitly) should use the DIRECT connection, with the SESSION pooler on 5432
    as the IPv4-only fallback. So this is refused loudly now rather than debugged mysteriously
    later.
    """
    raw = raw or url()
    if not raw:
        return
    # Ordered so each refusal names its own cause. All three end in "we will not connect", but they
    # send the operator to three different places, and a wrong pointer costs more than no pointer.

    # (a) The URL parser cannot read it at all — NFKC-sensitive characters in the password, such as
    # a fullwidth ＠ or ／. Distinguished from a wrong scheme because the scheme here is usually
    # perfectly good and the password is the thing to fix.
    if _url_params(raw) is None:
        raise DatabaseError(
            f"RC_DATABASE_URL could not be parsed (target {safe_target(raw)}). This usually means "
            "an unusual character in the password — percent-encode it, including full-width or "
            "other non-ASCII forms of '@', '/', ':', '?' and '#'.")

    # (b) Not a URL. libpq also accepts the key=value form (`host=… port=…`) and `service=…`, which
    # `urlsplit` cannot read; without this they would fall through to the agreement check below and
    # be reported as "the parsers disagree", sending the operator hunting an escaping problem that
    # does not exist. Supabase hands out URLs, so requiring one is fine — saying so plainly is the
    # point.
    if _scheme_of(raw) not in {"postgres", "postgresql"}:
        raise DatabaseError(
            "RC_DATABASE_URL must be a postgres:// URL. Supabase gives you one under Settings → "
            "Database; the libpq key=value and service= forms are not supported here.")
    # (c) Both parsers read it, but differently — so we cannot say where it points.
    if not _parses_agree(raw):
        raise DatabaseError(
            "RC_DATABASE_URL is ambiguous: the URL parser and libpq read a different host, port or "
            "database from it. That happens when a credential delimiter escapes the authority — an "
            "unescaped '/', '?', '#' or '@' in the password — or when a query parameter overrides "
            "the connection target. Percent-encode those characters in the password, and put the "
            "host, port and database in the URL itself rather than the query string.")
    # `_parses_agree` has already parsed this with both parsers and found them identical, so read
    # the host from that result instead of calling `urlsplit` a third time — which is the call that
    # can raise with the password in the message.
    effective = _effective_params(raw) or {}
    if not effective.get("host"):
        raise DatabaseError("RC_DATABASE_URL has no host.")
    # libpq's port, not the URL's. `_parses_agree` above has already established that the two are
    # identical — a `?port=6543` override makes them differ and is refused there, which is what
    # actually closes that bypass. This uses the effective value anyway because it is the one that
    # decides where the connection goes, so the check cannot drift if that guarantee is ever
    # loosened. It is defensive, not load-bearing; no test distinguishes it today, and pretending
    # otherwise would misdescribe where the protection lives.
    effective_port = effective.get("port")
    if str(effective_port) == str(_TRANSACTION_POOLER_PORT):
        raise DatabaseError(
            "RC_DATABASE_URL points at Supabase's transaction pooler (port 6543), which does not "
            "support prepared statements — psycopg uses them automatically once a query repeats, "
            "so this would fail later under load rather than now. Use the direct connection "
            "(db.<ref>.supabase.co:5432), or the session pooler "
            "(aws-<region>.pooler.supabase.com:5432) if the host has no IPv6.")


def pool():
    """The process-wide connection pool, opened on first use.

    One pool for one uvicorn worker (invariant 6). `check=` makes the pool test a connection before
    handing it out: Supabase closes idle connections, and without the check the first request after
    a quiet period fails on a dead socket rather than transparently reconnecting.
    """
    global _pool
    if not enabled():
        raise DatabaseError("No database is configured (RC_DATABASE_URL is unset).")
    with _pool_lock:
        if _pool is None:
            assert_usable_url()
            from psycopg_pool import ConnectionPool

            _pool = ConnectionPool(
                url(), min_size=1, max_size=8, open=True, timeout=10,
                check=ConnectionPool.check_connection,
                kwargs={"autocommit": True, "connect_timeout": 10},
            )
            log.info("db: pool opened on %s", safe_target())
    return _pool


def close() -> None:
    """Release the pool. For tests, and for a clean shutdown."""
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


def _migration_files() -> list[Path]:
    """Migrations in filename order.

    Sorted by name, and the names are numbered, because order is the entire correctness property
    of a migration set. `Path.glob` does not promise an order, so relying on it would make the
    schema depend on filesystem enumeration.
    """
    if not MIGRATIONS_DIR.is_dir():
        return []
    return sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)


def migrate() -> list[str]:
    """Apply any migrations this database has not seen. Returns the names applied.

    Idempotent, and safe to call on every boot: each file is recorded in `rc_schema_migrations`
    once it succeeds, and each runs inside its own transaction so a failure leaves the database at
    the last complete migration rather than half-way through a broken one.

    **The ledger is a record, not a source of truth.** It lives in the schema Supabase exposes, so
    a row in it is not evidence that anything ran — an anon-key caller could once insert a
    migration's filename and that migration would be skipped forever, silently. Nothing skips on it
    now: every file runs on every call. That is affordable only because every migration is required
    to be idempotent (`supabase/migrations/README.md`), and it is why that requirement is written
    down rather than assumed.

    **The lockout runs before the loop and again in a `finally`.** The `finally` is the guarantee:
    it is what stops a migration that raises from leaving `rc_projects` writable through the Data
    API, which is what happened when enforcement sat at the end of the happy path. The call ahead of
    the loop is not redundant but its benefit is narrower and worth stating precisely — it secures
    tables that already exist *before* a long migration run rather than after it, closing a window
    measured in however long the DDL takes. Both calls are cheap and idempotent.
    """
    applied: list[str] = []
    files = _migration_files()
    if not files:
        return applied

    # Everything below happens under one advisory lock on ONE connection. A Fly deploy overlaps the
    # old and new machines, so two processes can call this at the same moment even though each is a
    # single worker (invariant 6). Without the lock both read the same "unseen" set, both run the
    # DDL, and the loser dies on the duplicate primary key — a deployment that fails at startup
    # even though the schema is correct. `create table if not exists` is not enough on its own:
    # concurrent creates race in the catalog and raise a duplicate-object error.
    with pool().connection() as conn:
        conn.execute("select pg_advisory_lock(%s)", (_MIGRATION_LOCK_KEY,))
        try:
            conn.execute(
                "create table if not exists rc_schema_migrations ("
                " name text primary key, applied_at timestamptz not null default now())")
            _enforce_data_api_lockout(conn)   # secure what already exists, before anything can fail

            applied.extend(_apply_all(conn, files))
            missing = _missing_tables(conn)
            if missing:
                # Cannot happen via the ledger any more; this catches a table dropped by hand, and
                # converts it into an error naming the table instead of a 500 on the next request.
                raise DatabaseError(f"schema incomplete after migrating: {', '.join(missing)}")
        finally:
            # In a `finally` for the same reason the first call is before the loop: a migration that
            # raises must not be able to leave the tables reachable from the Data API.
            try:
                _enforce_data_api_lockout(conn)
            except Exception as e:  # noqa: BLE001 — never mask the original failure with this one
                log.error("db: could not assert the data-api lockout: %s", str(e)[:200])
            # Released explicitly rather than left to the session ending: this connection goes back
            # to the pool alive, and a session-scoped lock left held would block every later boot.
            conn.execute("select pg_advisory_unlock(%s)", (_MIGRATION_LOCK_KEY,))
    return applied


#: The tables the application code requires. Verified against the schema after migrating, because
#: the migration ledger lives in the schema Supabase exposes and therefore cannot be trusted to say
#: what actually ran. `tests/test_tenancy.py` asserts this matches what a fresh migrate produces, so
#: adding a table without adding it here fails in CI rather than in production.
_REQUIRED_TABLES = (
    "rc_account_deletions",
    "rc_project_trash",
    "rc_projects",
    "rc_user_settings",
    "rc_users",
)


def _apply_all(conn, files) -> list[str]:
    """Run EVERY migration, every time. Returns the names recorded for the first time.

    The ledger is never consulted to decide what to skip. It lives in the schema Supabase exposes
    over its Data API, so a row in it is not evidence that anything ran — an anon-key caller could
    once insert a filename and that migration would be skipped forever, silently. The previous
    attempt at this verified afterwards that the required TABLES existed, which caught a poisoned
    `0003` (it creates a table) and missed a poisoned `0002` (it only adds a column). Verifying
    every column, index and constraint a migration might touch is a schema-diffing tool, and one
    written under time pressure would keep missing a category — the same shape of defect the last
    three rounds have been.

    So the ledger stops being load-bearing instead. Re-running is safe because every migration is
    required to be idempotent (`supabase/migrations/README.md`), which is exactly what makes this
    the cheap answer rather than the thorough one. What remains in the table is a record of when
    each file was FIRST seen, which is useful to an operator and trusted by nothing.
    """
    newly_recorded: list[str] = []
    for path in files:
        body = path.read_text(encoding="utf-8")
        # Explicit transaction: autocommit is on for ordinary queries, but a migration must be
        # all-or-nothing or a partial DDL apply leaves a schema no file describes.
        with conn.transaction():
            conn.execute(body)
            first_time = conn.execute(
                "insert into rc_schema_migrations (name) values (%s) "
                "on conflict (name) do nothing returning name", (path.name,)).fetchone()
        if first_time:
            newly_recorded.append(path.name)
            log.info("db: applied migration %s", path.name)
    return newly_recorded


def _missing_tables(conn) -> list[str]:
    """Which required tables are absent — i.e. where the ledger and the schema disagree."""
    present = {row[0] for row in conn.execute(
        "select tablename from pg_tables where schemaname = 'public' "
        "and tablename = any(%s)", (list(_REQUIRED_TABLES),))}
    return [name for name in _REQUIRED_TABLES if name not in present]


def _enforce_data_api_lockout(conn) -> None:
    """Take every `rc_*` table off Supabase's Data API. Runs on EVERY migrate, not as a migration.

    Supabase serves the `public` schema over PostgREST and its default privileges grant `anon` and
    `authenticated` full DML on tables created there. The anon key is *published* — it ships inside
    the mobile app by design — so without this, `rc_users` is every user's email and
    `rc_projects.owner_id` is **writable**: set it to your own id and `tenancy.may_access` hands you
    another person's reading list, which the backend then serves correctly, having been told the
    truth by a table the attacker controls.

    **Why this is not a migration file.** It was one, and that was wrong. `migrate()` skips any file
    already named in `rc_schema_migrations` — and that ledger is itself in the exposed schema. So an
    anon-key caller could insert the lockout migration's own filename before the deploy that
    introduces it, and the one statement that would have closed the hole is the one silently
    skipped, with startup cheerfully reporting nothing pending. A lockout that consults the ledger
    it exists to secure is not a lockout. Applied unconditionally instead: every statement here is
    idempotent, so re-running it each boot costs nothing and cannot be suppressed by anything an
    attacker can write.

    The table list is enumerated from the catalog rather than hard-coded, so a table added later is
    covered without anyone remembering to add it — the same "two places to keep in sync" trap in a
    different costume.

    Two independent locks per table: RLS with no policies (Supabase's own requirement for anything
    in an exposed schema), and the grants revoked outright. Not `force` — the backend owns these
    tables and an owner is exempt from its own table's RLS unless forced, so forcing would lock out
    the application instead of the attacker.

    **Per table, in its own transaction.** `ALTER TABLE` requires ownership, so one `public.rc_*`
    table owned by a different role — a leftover, or something an operator created by hand — would
    otherwise roll the whole statement back and leave EVERY table exposed. One table failing must
    cost only that table. The failure is logged at ERROR because nothing else will notice it.

    Schema-qualified, because the enumeration is specifically of `public` while a bare
    `alter table rc_projects` resolves through `search_path` — which a DSN option can set. Without
    the qualification the two could name different tables and this would log success over an
    untouched `public.rc_projects`.
    """
    from psycopg import sql  # function-local, matching `conninfo` above

    tables = [row[0] for row in conn.execute(
        r"select tablename from pg_tables where schemaname = 'public' and tablename like 'rc\_%'")]
    if not tables:
        return
    roles = [row[0] for row in conn.execute(
        "select rolname from pg_roles where rolname in ('anon', 'authenticated')")]
    locked = 0
    for table in tables:
        try:
            with conn.transaction():
                conn.execute(sql.SQL("alter table public.{} enable row level security").format(
                    sql.Identifier(table)))
                for role in roles:   # absent on a plain Postgres (CI, local) — nothing to revoke
                    conn.execute(sql.SQL("revoke all on public.{} from {}").format(
                        sql.Identifier(table), sql.Identifier(role)))
            locked += 1
        except Exception as e:  # noqa: BLE001 — one table must not decide the fate of the others
            log.error("db: could NOT lock public.%s out of the data api: %s", table, str(e)[:200])
    log.info("db: data-api lockout asserted on %d/%d table(s)", locked, len(tables))


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def is_uuid(value: str) -> bool:
    """Whether `value` is a Supabase user id.

    Checked before a value reaches a query because a non-uuid would otherwise surface as a Postgres
    cast error at an arbitrary depth — and because "is this a user id" is a question the callers
    genuinely need answered, not just a formatting concern.
    """
    return bool(_UUID.match(value or ""))
