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


def safe_target(raw: str = "") -> str:
    """`host:port/database` — never the credentials.

    Exists so errors and logs can say *which* database failed without the password travelling with
    them. A connection string is a Fly secret; the moment one appears in a log line it is in
    whatever ships those logs, and it is no longer revocable by rotating one place.
    """
    try:
        parts = urlsplit(raw or url())
        host = parts.hostname or "?"
        port = f":{parts.port}" if parts.port else ""
        name = parts.path.lstrip("/") or "?"
        return f"{host}{port}/{name}"
    except ValueError:
        return "?"


def _dsn_parses(raw: str) -> bool:
    """Whether psycopg can parse this connection string. Returns a bool rather than re-raising, so
    the caller's `DatabaseError` is raised outside any `except` block and the psycopg exception —
    which quotes the offending credential token — never becomes its `__context__`."""
    try:
        from psycopg import conninfo

        conninfo.conninfo_to_dict(raw)
        return True
    except Exception:
        return False


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
    try:
        parts = urlsplit(raw)
    except ValueError as e:
        raise DatabaseError("RC_DATABASE_URL is not a valid URL.") from e
    if parts.scheme not in {"postgres", "postgresql"}:
        raise DatabaseError(
            f"RC_DATABASE_URL must be a postgres:// URL (got scheme {parts.scheme!r}).")
    if not parts.hostname:
        raise DatabaseError("RC_DATABASE_URL has no host.")
    # Parse it the way psycopg will, HERE, where the error can be sanitized. psycopg's own
    # exception for a malformed DSN quotes the offending token verbatim — a mistyped password
    # produces `invalid percent-encoded token: "p%zzword"` — and `psycopg_pool` logs connection
    # failures at WARNING, so without this the secret reaches the Fly logs in plaintext and
    # rotating it becomes the only remedy.
    #
    # Raised OUTSIDE the `except`, via a predicate, rather than with `raise ... from None`.
    # `from None` only sets `__suppress_context__`, which stops the DEFAULT traceback printer
    # showing the cause — the original exception object stays reachable on `__context__`, and
    # structured error reporters walk that chain regardless of the flag.
    if not _dsn_parses(raw):
        raise DatabaseError(
            f"RC_DATABASE_URL could not be parsed as a connection string (target {safe_target(raw)}). "
            "Check for an unescaped character in the password — a literal '%', space, '@' or '/' "
            "must be percent-encoded.")

    if parts.port == _TRANSACTION_POOLER_PORT:
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
            seen = {row[0] for row in conn.execute("select name from rc_schema_migrations")}

            for path in files:
                if path.name in seen:
                    continue
                sql = path.read_text(encoding="utf-8")
                # Explicit transaction: autocommit is on for ordinary queries, but a migration must
                # be all-or-nothing or a partial DDL apply leaves a schema no file describes.
                with conn.transaction():
                    conn.execute(sql)
                    conn.execute("insert into rc_schema_migrations (name) values (%s)",
                                 (path.name,))
                applied.append(path.name)
                log.info("db: applied migration %s", path.name)
        finally:
            # Released explicitly rather than left to the session ending: this connection goes back
            # to the pool alive, and a session-scoped lock left held would block every later boot.
            conn.execute("select pg_advisory_unlock(%s)", (_MIGRATION_LOCK_KEY,))
    return applied


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def is_uuid(value: str) -> bool:
    """Whether `value` is a Supabase user id.

    Checked before a value reaches a query because a non-uuid would otherwise surface as a Postgres
    cast error at an arbitrary depth — and because "is this a user id" is a question the callers
    genuinely need answered, not just a formatting concern.
    """
    return bool(_UUID.match(value or ""))
