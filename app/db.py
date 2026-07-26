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
