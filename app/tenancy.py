"""Ownership: who owns which project, and the enforcement of it.

`may_access` is the gate. With no database it is single-tenant and everything is reachable; with
one, a project nobody owns is reachable by **nobody**. That is the correct failure and it looks
exactly like data loss, which is why `RC_ADOPT_OWNER` exists for projects that predate ownership.

`use_project` checks access BEFORE existence, so a project belonging to someone else and a project
that was never created answer identically — otherwise the 404/403 split enumerates other people's
project ids.

**A route that names a project anywhere other than the URL path does not get this for free.** A
request body, a `?project=` query, a cross-project scan: each must call `may_access` itself. That
was the source of every miss found while enforcement was being rolled out, and it is the thing to
check when adding a route that touches more than one project.

With no database configured every function here returns the single-tenant answer, so a local
`./run.sh` and the whole test suite behave exactly as before.
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
        row = conn.execute(
            "insert into rc_projects (id, owner_id) values (%s, %s) "
            "on conflict (id) do nothing returning owner_id::text", (pid, owner_id)).fetchone()
        if row is None:
            # The insert did nothing, so a row already existed. Confirm it is THIS owner's, rather
            # than reporting success: a conflict with someone else means the caller believes they
            # own a project they cannot open, and the actual owner silently gains their content.
            existing = conn.execute(
                "select owner_id::text, deleted_at is not null "
                "from rc_projects where id = %s", (pid,)).fetchone()
            if existing and existing[1]:
                raise TenancyError(f"Project id {pid!r} has been retired.")
            if not existing or existing[0] != owner_id:
                raise TenancyError(f"Project {pid!r} is already owned by someone else.")


def owner_of(pid: str) -> str | None:
    """Who owns `pid`, or None when it is unowned or there is no database."""
    if not enabled():
        return None
    with db.pool().connection() as conn:
        row = conn.execute(
            "select owner_id::text from rc_projects where id = %s and deleted_at is null",
            (pid,)).fetchone()
    return row[0] if row else None


def projects_owned_by(owner_id: str) -> set[str]:
    """The project ids `owner_id` owns."""
    if not enabled() or not db.is_uuid(owner_id):
        return set()
    with db.pool().connection() as conn:
        rows = conn.execute(
            "select id from rc_projects where owner_id = %s and deleted_at is null",
            (owner_id,)).fetchall()
    return {row[0] for row in rows}


def trash_entries_owned_by(owner_id: str) -> set[str]:
    """Concrete `.trash` directory names formerly belonging to `owner_id`.

    This is not an authorization surface. It is a separate incarnation index for account deletion:
    before permanent tombstones, one project id could be deleted, reused, and deleted again.
    """
    if not enabled() or not db.is_uuid(owner_id):
        return set()
    with db.pool().connection() as conn:
        rows = conn.execute(
            "select trash_name from rc_project_trash where owner_id = %s",
            (owner_id,)).fetchall()
    return {row[0] for row in rows}


def transition_projects_owned_by(owner_id: str) -> set[str]:
    """Retired project ids whose old-worker transition owner is ``owner_id``.

    The concrete trash index is authoritative when present. This is the rolling-migration safety
    net for a pre-0004 worker that cleared ``owner_id`` before it knew how to write
    ``rc_project_trash``; account deletion must reconcile it against the filesystem before clearing
    the link.
    """
    if not enabled() or not db.is_uuid(owner_id):
        return set()
    with db.pool().connection() as conn:
        rows = conn.execute(
            "select id from rc_projects "
            "where deleted_owner_id = %s and deleted_at is not null",
            (owner_id,),
        ).fetchall()
    return {row[0] for row in rows}


def trash_owner_of(trash_name: str) -> str | None:
    """The non-authorizing owner of one concrete recoverable trash entry."""
    if not enabled():
        return None
    with db.pool().connection() as conn:
        row = conn.execute(
            "select owner_id::text from rc_project_trash where trash_name = %s",
            (trash_name,)).fetchone()
    return row[0] if row else None


def deleted_owner_of(pid: str) -> str | None:
    """Transition owner retained on a retired id, if one is recorded.

    The concrete `rc_project_trash` entry is authoritative. This column exists so an old worker
    whose release statement predates that table cannot erase the owner during a rolling deploy.
    """
    if not enabled():
        return None
    with db.pool().connection() as conn:
        row = conn.execute(
            "select deleted_owner_id::text from rc_projects "
            "where id = %s and deleted_at is not null",
            (pid,)).fetchone()
    return row[0] if row else None


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


def backfill_trashed(owner_id: str, trash_names: list[str]) -> dict:
    """Attribute explicitly selected legacy `.trash` entries to `owner_id`.

    The caller must choose concrete directory names. This never infers that all legacy trash
    belongs to one instance owner: after multi-user ownership shipped, such an inference could make
    one account's deletion remove another user's repository. Existing attribution is never changed.
    """
    if not enabled():
        raise TenancyError("No database is configured (RC_DATABASE_URL is unset).")
    if not db.is_uuid(owner_id):
        raise TenancyError(f"{owner_id!r} is not a valid user id.")
    ensure_user(owner_id)

    adopted: list[str] = []
    already: list[str] = []
    attributed_elsewhere: list[str] = []
    from . import projects  # local import: projects imports tenancy

    with db.pool().connection() as conn:
        for trash_name in sorted(set(trash_names)):
            pid = projects.project_id_from_trash_name(trash_name)
            changed = conn.execute(
                "insert into rc_project_trash (trash_name, project_id, owner_id) "
                "values (%s, %s, %s) on conflict (trash_name) do nothing "
                "returning owner_id::text",
                (trash_name, pid, owner_id),
            ).fetchone()
            if changed:
                adopted.append(trash_name)
                continue
            existing = conn.execute(
                "select owner_id::text from rc_project_trash where trash_name = %s",
                (trash_name,)).fetchone()
            if existing and existing[0] == owner_id:
                already.append(trash_name)
            else:
                attributed_elsewhere.append(trash_name)

    log.info(
        "tenancy: trash backfill attributed %d, already %d, conflicts %d",
        len(adopted), len(already), len(attributed_elsewhere),
    )
    return {
        "owner": owner_id,
        "adopted": adopted,
        "already_attributed": already,
        "attributed_elsewhere": attributed_elsewhere,
    }


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


def claim(pid: str, user: dict | None) -> None:
    """Record `user` as the owner of a project they just created. Safe to call unconditionally.

    Does `ensure_user` first, and that is the whole point: nothing else on the request path creates
    an `rc_users` row. A newly allowlisted Supabase user therefore has no row at all, and
    `record_project` alone would fail the owner foreign key AFTER the directory was already on
    disk — leaving them a project nobody owns, which is a project nobody can open. So every path
    that creates a project (direct, import, split) goes through here rather than calling
    `record_project` on its own.
    """
    if not enabled():
        return
    user_id = (user or {}).get("user_id")
    if not user_id:
        return
    ensure_user(user_id, (user or {}).get("email"))
    record_project(pid, user_id)


def id_is_recorded(pid: str) -> bool:
    """Whether this id appears in the ownership index AT ALL — live or retired.

    Used for id allocation, where the question is "has this id ever been taken", not "who owns it".
    A retired id must never be handed out again: a request that passed the ownership check for the
    previous incarnation carries only the id string, so reusing it would let that request act on a
    different user's project.
    """
    if not enabled():
        return False
    with db.pool().connection() as conn:
        return conn.execute(
            "select 1 from rc_projects where id = %s", (pid,)).fetchone() is not None


def restore(pid: str, owner_id: str, trash_name: str) -> None:
    """Un-retire a project — for when deletion failed after the row was already retired."""
    if not enabled():
        return
    with db.pool().connection() as conn:
        with conn.transaction():
            restored = conn.execute(
                "update rc_projects "
                "set owner_id = %s, deleted_owner_id = null, deleted_at = null "
                "where id = %s and deleted_owner_id = %s and deleted_at is not null",
                (owner_id, pid, owner_id),
            ).rowcount
            if restored:
                conn.execute(
                    "delete from rc_project_trash where trash_name = %s and owner_id = %s",
                    (trash_name, owner_id))


def release(pid: str, trash_name: str) -> str | None:
    """Retire `pid` when the project is gone. Returns the former owner, if any.

    The row SURVIVES as a tombstone — live owner cleared so nobody can reach it, former owner
    copied to the transition column, and `deleted_at` set so the id is never handed out again. The
    exact destination name is recorded separately in `rc_project_trash`; account deletion must act
    on that concrete incarnation rather than a reusable historical id.

    Deletion moves the directory into `.trash`, but the surviving row permanently reserves the id.
    `record_project` refuses that retired row even if the same user later creates a project with
    the same display name.

    The former owner comes back so the caller can restore the live row if the filesystem move then
    fails. Otherwise a recoverable project would still be in its live path while its owner could
    no longer open it.
    """
    if not enabled():
        return None
    from . import projects  # local import: projects imports tenancy
    trash_pid = projects.project_id_from_trash_name(trash_name)
    if trash_pid != pid:
        raise TenancyError("Trash entry does not belong to the project being retired.")
    with db.pool().connection() as conn:
        with conn.transaction():
            row = conn.execute(
                "update rc_projects "
                "set deleted_owner_id = owner_id, owner_id = null, deleted_at = now() "
                "where id = %s and owner_id is not null and deleted_at is null "
                "returning deleted_owner_id::text",
                (pid,)).fetchone()
            if row:
                conn.execute(
                    "insert into rc_project_trash (trash_name, project_id, owner_id) "
                    "values (%s, %s, %s)",
                    (trash_name, pid, row[0]))
    return row[0] if row else None
