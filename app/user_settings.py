"""Per-user preferences: the half of `/api/settings` that belongs to a person rather than to the
instance.

`config.load_settings()` layers these over the instance document (see `config.USER_SETTING_KEYS`
for the split and why each key falls on the side it does). This module is only the store.

Everything here is a no-op returning "no preferences" when there is no database or no signed-in
user, which is what keeps `./run.sh` and the test suite behaving exactly as they did before the
split existed.

Import direction matters: `config` reaches this module through a *function-local* import, because
`db` -> `logging_config` -> `config` would otherwise close a cycle at import time.
"""
from __future__ import annotations

import contextvars

from . import db, logging_config, tenancy

log = logging_config.get("user_settings")

# Per-context memo of one user's rows.
#
# `load_settings()` is called from ~24 places and several times per turn; without this each one is
# a round trip to Postgres, which on Fly is a network hop rather than a local socket.
#
# Deliberately a contextvar and not a process-global dict. A context is one request or one job, so
# a stale entry cannot outlive the request that made it, and — the part that actually matters — a
# cache that is per-context cannot serve one user's preferences to another no matter what goes
# wrong with invalidation. A process-global cache would need that to be argued; this needs nothing.
_cache: contextvars.ContextVar[tuple[str, dict] | None] = contextvars.ContextVar(
    "user_settings_cache", default=None)


def available(user_id: str | None) -> bool:
    """Whether preferences can be stored for this user at all.

    False on a single-tenant instance (no database) and for an unauthenticated caller (open auth
    mode) — in both cases the instance document IS the user's document, which is today's behaviour.
    """
    return bool(user_id) and db.enabled()


def load(user_id: str | None) -> dict:
    """This user's stored preferences, or `{}`.

    Best-effort by design: a database blip must not fail a reading turn. The fallback is the
    instance defaults — the operator's own choices — so degrading this way costs a user their
    voice preference for the duration, and never exposes anyone else's.
    """
    if not available(user_id):
        return {}
    cached = _cache.get()
    if cached is not None and cached[0] == user_id:
        return cached[1]
    try:
        with db.pool().connection() as conn:
            rows = conn.execute(
                "select key, value from rc_user_settings where user_id = %s", (user_id,)).fetchall()
        prefs = dict(rows)
    except Exception as e:  # noqa: BLE001 — see the docstring: never fail a turn over a preference
        log.warning("user_settings: could not read preferences: %s", str(e)[:200])
        return {}
    _cache.set((user_id, prefs))
    return prefs


def save(user_id: str, patch: dict, allowed: frozenset[str]) -> None:
    """Store `patch` for one user, keeping only keys in `allowed`.

    Same per-key convention as `config.save_settings`, so the two halves of one settings form
    behave identically: absent or None leaves a key unchanged, `""` clears the override (falling
    back to the instance value), anything else sets it.

    `allowed` is passed in rather than imported so the filter and the caller cannot drift, and
    because `config` owns the split. It is enforced again by a CHECK constraint in
    `0003_user_settings.sql` — a user must not be able to store `openrouter_api_key` here, since
    these rows are layered over the instance document at read time.

    Raises rather than degrading: a person pressing Save has to be told when it did not save.
    """
    if not db.is_uuid(user_id):
        raise tenancy.TenancyError("Not a valid user id.")
    sets = {k: v for k, v in patch.items() if k in allowed and v is not None and v != ""}
    clears = [k for k, v in patch.items() if k in allowed and v == ""]
    if not sets and not clears:
        return

    # Nothing else on the request path creates an `rc_users` row (see `tenancy.claim`), so a user
    # who has signed in but not yet made a project has none — and the owner foreign key below would
    # fail for them. This is the same reason `claim` does it.
    tenancy.ensure_user(user_id)

    with db.pool().connection() as conn, conn.transaction():
        for key, value in sets.items():
            conn.execute(
                "insert into rc_user_settings (user_id, key, value) values (%s, %s, %s) "
                "on conflict (user_id, key) do update set value = excluded.value, "
                "updated_at = now()",
                (user_id, key, str(value)))
        if clears:
            conn.execute(
                "delete from rc_user_settings where user_id = %s and key = any(%s)",
                (user_id, clears))
    _cache.set(None)
    log.info("user_settings: saved %d, cleared %d", len(sets), len(clears))


def forget_cache() -> None:
    """Drop the memo for the current context. For tests that rebuild the schema underneath it."""
    _cache.set(None)
