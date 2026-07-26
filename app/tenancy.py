"""Ownership: who owns which project.

**This slice records ownership; it does not enforce it.** Nothing here refuses a request, and no
route calls it to gate anything yet — enforcement lands in the next slice, together with the
per-user `PROJECTS_ROOT` namespacing and the cross-user isolation tests. Splitting it that way is
deliberate: `projects.project_path` / `_safe_pid` is the trust boundary that turns an untrusted id
into a filesystem path, and changing what that boundary *does* in the same change that introduces
the tables it reads from would leave no working state to compare against if something is wrong.

With no database configured every function here is a no-op returning the single-tenant answer, so
a local `./run.sh` and the whole test suite behave exactly as before.
"""
from __future__ import annotations

import os

from . import db, logging_config

log = logging_config.get("tenancy")


class TenancyError(Exception):
    """An ownership operation could not be completed — maps to 500."""


def enabled() -> bool:
    """Whether ownership is being recorded at all."""
    return db.enabled()


def adopt_owner() -> str:
    """The user id that pre-existing projects belong to (`RC_ADOPT_OWNER`).

    Every project that exists today was created before ownership existed, so somebody has to own
    them. That is the operator running the migration, named explicitly rather than guessed: picking
    "the first user in the table" would silently hand one person's reading to whoever happened to
    sign up first.
    """
    return os.environ.get("RC_ADOPT_OWNER", "").strip()


def ensure_user(user_id: str, email: str | None = None) -> None:
    """Record a signed-in user, if the database is configured.

    Called from the auth path with a **verified** JWT `sub`. The email is stored for the operator's
    benefit (knowing who a uuid is) and is refreshed on later sign-ins, since a user can change it
    with the identity provider and a stale copy is worse than none.
    """
    if not enabled():
        return
    if not db.is_uuid(user_id):
        raise TenancyError("Not a valid user id.")
    with db.pool().connection() as conn:
        conn.execute(
            "insert into rc_users (id, email) values (%s, %s) "
            "on conflict (id) do update set email = coalesce(excluded.email, rc_users.email)",
            (user_id, email))


def record_project(pid: str, owner_id: str) -> None:
    """Record that `owner_id` owns `pid`. Idempotent; never changes an existing owner.

    `do nothing` rather than `do update`: this is called when a project is created and from the
    backfill, and in neither case is "the owner changed" a thing that should happen silently. A
    transfer, if it is ever wanted, should be an explicit operation that says so.
    """
    if not enabled():
        return
    if not db.is_uuid(owner_id):
        raise TenancyError("Not a valid user id.")
    with db.pool().connection() as conn:
        conn.execute(
            "insert into rc_projects (id, owner_id) values (%s, %s) on conflict (id) do nothing",
            (pid, owner_id))


def owner_of(pid: str) -> str | None:
    """Who owns `pid`, or None when it is unowned or there is no database."""
    if not enabled():
        return None
    with db.pool().connection() as conn:
        row = conn.execute("select owner_id::text from rc_projects where id = %s", (pid,)).fetchone()
    return row[0] if row else None


def projects_owned_by(owner_id: str) -> set[str]:
    """The project ids `owner_id` owns."""
    if not enabled() or not db.is_uuid(owner_id):
        return set()
    with db.pool().connection() as conn:
        rows = conn.execute("select id from rc_projects where owner_id = %s", (owner_id,)).fetchall()
    return {row[0] for row in rows}


def backfill(owner_id: str, pids: list[str]) -> dict:
    """Adopt existing projects under `owner_id`. Idempotent — re-running adopts only what is new.

    Returns `{"owner": ..., "adopted": [...], "already_owned": [...]}` so a re-run is visibly a
    no-op rather than looking like it did the work twice.
    """
    if not enabled():
        raise TenancyError("No database is configured (RC_DATABASE_URL is unset).")
    if not db.is_uuid(owner_id):
        raise TenancyError(f"{owner_id!r} is not a valid user id.")

    ensure_user(owner_id)
    already = projects_owned_by(owner_id)
    existing_owners = {pid: owner_of(pid) for pid in pids}

    adopted, skipped = [], []
    for pid in pids:
        current = existing_owners.get(pid)
        if current is not None:
            skipped.append(pid)
            continue
        record_project(pid, owner_id)
        adopted.append(pid)

    log.info("tenancy: backfill adopted %d project(s), %d already owned",
             len(adopted), len(skipped))
    return {"owner": owner_id, "adopted": adopted, "already_owned": sorted(set(skipped) | already & set(pids))}


def may_access(pid: str, user: dict | None) -> bool:
    """Whether `user` may reach project `pid`.

    Three states, and the distinction between them is what keeps this safe to deploy:

    * **No database** — ownership is not being recorded at all, so there is nothing to enforce and
      every project is reachable, exactly as before M2. This is how `./run.sh` and the test suite
      work, and enforcement that failed CLOSED on a missing secret would take the app down rather
      than protect it.
    * **No signed-in user** — the instance is running in `open` auth mode, which staging and prod
      refuse to boot in (`auth.assert_environment_safe`). There is no identity to compare against,
      so this is single-tenant by configuration.
    * **A signed-in user and a database** — the project must be owned BY THEM. An unowned project is
      reachable by nobody: a directory with no ownership row is either an import that predates
      adoption or something dropped in by hand, and defaulting it to visible is how a migration gap
      becomes a data leak.
    """
    if not enabled():
        return True
    user_id = (user or {}).get("user_id")
    if not user_id:
        return True
    return owner_of(pid) == user_id


def visible_projects(pids: list[str], user: dict | None) -> list[str]:
    """`pids` filtered to what `user` may see, preserving order."""
    if not enabled():
        return pids
    user_id = (user or {}).get("user_id")
    if not user_id:
        return pids
    owned = projects_owned_by(user_id)
    return [pid for pid in pids if pid in owned]
