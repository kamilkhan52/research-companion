"""Authentication: verify Supabase-issued user tokens (modular + optional).

Three modes, chosen by env so local/dev keeps working and exposure is a config flip:
- **Supabase** (RC_SUPABASE_URL set): verify the user's JWT against Supabase's JWKS
  (asymmetric ES256/RS256) locally — no per-request network call, no server-side Supabase
  library. The verified claims (sub, email) identify the user.
- **Shared token** (RC_AUTH_TOKEN set, no Supabase): legacy single-secret gate.
- **Open** (neither): no auth — the default for local use behind a private tunnel.

The web/mobile clients fetch /api/auth/config to learn the mode + the publishable Supabase
URL and anon key, so nothing client-specific is hardcoded.
"""
from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict

from .config import KNOWN_ENVIRONMENTS, env_truthy

SUPABASE_URL = os.environ.get("RC_SUPABASE_URL", "").rstrip("/")
# Publishable (safe to expose to clients); needed by supabase-js to start the auth flow.
SUPABASE_ANON_KEY = os.environ.get("RC_SUPABASE_ANON_KEY", "")
LEGACY_TOKEN = os.environ.get("RC_AUTH_TOKEN", "")

_ISSUER = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else ""
_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
_AUDIENCE = "authenticated"

_jwk_client = None  # lazily-created PyJWKClient (caches signing keys)


class AuthError(Exception):
    """Bad or missing credentials — maps to 401."""


class NotAllowlisted(Exception):
    """Valid credentials, but this user may not use this instance — maps to 403.

    Deliberately NOT a subclass of AuthError: the distinction is the whole point. 401 tells a
    client "sign in", which would send an allowlisted-out user round the login loop forever.
    """


class ConfigurationError(Exception):
    """The process is configured in a way that is unsafe for its environment. Raised at import so
    the app refuses to start rather than serving in a permissive state."""


def allowed_users() -> frozenset[str]:
    """User ids permitted to use this instance (`RC_ALLOWED_USERS`, comma-separated), or empty for
    "anyone who authenticates". Read live so the list can be changed with a secrets update.

    This exists because Supabase sign-up is SELF-SERVICE: authentication alone proves someone
    created an account, not that they are allowed here. Until per-user ownership lands (M2), any
    authenticated user reaches every project plus the shared provider keys and system prompts, so
    the allowlist is the only thing standing between a stranger's signup and the whole instance.
    """
    raw = os.environ.get("RC_ALLOWED_USERS", "")
    return frozenset(part.strip() for part in raw.split(",") if part.strip())


def operator_users() -> frozenset[str]:
    """User ids allowed to change instance-wide configuration (`RC_OPERATOR_USERS`).

    Separate from `allowed_users` on purpose: that answers "may this person use the app", this
    answers "may this person change it for everyone". Empty means NOBODY is an operator, so the
    privileged routes are closed until someone is named — the same fail-closed posture as the rest
    of this module. Read live so the list changes with a secrets update.

    Until per-user ownership lands (M2) this is the whole authorization model for operator
    actions; M2 replaces the env var with a column without changing the call sites.
    """
    raw = os.environ.get("RC_OPERATOR_USERS", "")
    return frozenset(part.strip() for part in raw.split(",") if part.strip())


def is_operator(user: dict | None) -> bool:
    """Whether `user` (as stashed on request.state.user) may change instance-wide configuration.

    In a dev environment with auth disabled there is no user at all, and local prompt editing has
    to keep working — so dev says yes. Every other environment requires an explicit match, and
    `assert_environment_safe` guarantees auth is Supabase there, so `user` is a verified identity
    rather than an empty dict.
    """
    from . import config
    if config.is_dev_env():
        return True
    return bool(user) and user.get("user_id") in operator_users()


# --- rejection logging: bounded on purpose ------------------------------------------------------
# The middleware logs the id of a valid-but-not-allowlisted user so the operator can repair the
# allowlist (see the call site in `main.py`). Supabase sign-up is SELF-SERVICE, so a stranger can
# obtain a valid token and then drive that log line with every request they make — flooding the
# operator's logs, burying the real signal the line exists to provide, and writing to stderr from
# the single worker on the request path. So the line is bounded in both dimensions a flood can
# grow in: how often one subject may log, and how many lines may be written at all per window.
_REJECT_WINDOW = 600.0        # seconds
_REJECT_MAX_LINES = 20        # across ALL subjects per window — bounds id-rotation too
_REJECT_MAX_TRACKED = 256     # bound the dedup map itself; it is attacker-grown otherwise

_reject_lock = threading.Lock()
_reject_seen: OrderedDict[str, float] = OrderedDict()
_reject_window_start = 0.0
_reject_window_lines = 0
_reject_suppressed = 0


def note_rejection(user_id: str, *, now: float | None = None) -> tuple[bool, int]:
    """Decide whether to log this rejection. Returns `(log_it, suppressed_since_last_line)`.

    One line per subject per window, and at most `_REJECT_MAX_LINES` lines per window overall. The
    suppressed count rides along on the next line that *is* emitted, so a flood is still visible as
    a number without being visible as volume. Safe under the single-worker assumption (invariant 6)
    plus the lock; the state is deliberately in-process and lossy across restarts, because it is a
    log-noise control and not a security control.
    """
    global _reject_window_start, _reject_window_lines, _reject_suppressed
    now = time.monotonic() if now is None else now
    with _reject_lock:
        if now - _reject_window_start >= _REJECT_WINDOW:
            _reject_window_start = now
            _reject_window_lines = 0
            # Drop entries that can no longer suppress anything, so the map tracks live abusers
            # rather than growing forever.
            for uid in [u for u, seen in _reject_seen.items() if now - seen >= _REJECT_WINDOW]:
                del _reject_seen[uid]

        last = _reject_seen.get(user_id)
        if last is not None and now - last < _REJECT_WINDOW:
            _reject_suppressed += 1
            return False, 0
        if _reject_window_lines >= _REJECT_MAX_LINES:
            _reject_suppressed += 1
            return False, 0

        _reject_seen[user_id] = now
        _reject_seen.move_to_end(user_id)
        while len(_reject_seen) > _REJECT_MAX_TRACKED:
            _reject_seen.popitem(last=False)
        _reject_window_lines += 1
        suppressed, _reject_suppressed = _reject_suppressed, 0
        return True, suppressed


def _reset_rejection_state() -> None:
    """Test hook — the counters are module-global and would leak between tests."""
    global _reject_window_start, _reject_window_lines, _reject_suppressed
    with _reject_lock:
        _reject_seen.clear()
        _reject_window_start = 0.0
        _reject_window_lines = 0
        _reject_suppressed = 0


def assert_environment_safe(env: str) -> None:
    """Refuse to start a non-dev process that is configured permissively. Called from `main` at
    import, so a misconfigured deploy fails loudly instead of serving unauthenticated.

    Every check here guards against *omission*. `mode()` falls back to `open` when no auth
    variable is set, `dev_mode()` keys off a variable that might be left over, and an unset
    allowlist would mean "everyone" — so forgetting any one of them silently produces the most
    permissive instance rather than an error. Hence: verify, don't default.
    """
    if not env:
        raise ConfigurationError(
            f"RC_ENV is not set. It must be one of {KNOWN_ENVIRONMENTS}. Refusing to start rather "
            "than assuming 'dev': a container that lost its environment would otherwise boot with "
            "every guard disabled and serve the whole API unauthenticated. run.sh and the test "
            "suite set RC_ENV=dev; the Dockerfile defaults to prod."
        )
    if env not in KNOWN_ENVIRONMENTS:
        raise ConfigurationError(
            f"RC_ENV={env!r} is not one of {KNOWN_ENVIRONMENTS}. Refusing to start rather than "
            "guessing — an unrecognized environment would otherwise disable production hardening."
        )
    if env == "dev":
        return

    if mode() != "supabase":
        raise ConfigurationError(
            f"RC_ENV={env} requires Supabase auth, but auth.mode() is {mode()!r}. Set "
            "RC_SUPABASE_URL and RC_SUPABASE_ANON_KEY. (Refusing to start: with no auth variables "
            "set, mode() falls back to 'open' and this process would serve the entire API "
            "unauthenticated.)"
        )
    if not SUPABASE_ANON_KEY:
        # mode() keys off the URL alone, so a missing anon key still reports "supabase" — and
        # /api/auth/config then advertises Supabase auth with an empty key. The clients only build
        # a Supabase client when BOTH are present (web/src/components/AuthGate.tsx), so the sign-in
        # UI would render but do nothing: every user locked out of an instance that demands auth.
        # Checked here rather than in mode(), because making mode() fall back to "open" on a
        # missing key would fail OPEN — the opposite of what this function is for.
        raise ConfigurationError(
            f"RC_SUPABASE_ANON_KEY must be set when RC_ENV={env}. RC_SUPABASE_URL alone makes "
            "auth.mode() report 'supabase' while leaving clients unable to construct a Supabase "
            "client, which locks every user out instead of letting them sign in."
        )
    if LEGACY_TOKEN:
        raise ConfigurationError(
            f"RC_AUTH_TOKEN must not be set when RC_ENV={env}. The shared-secret gate is a dev "
            "convenience; leaving it configured means a later removal of RC_SUPABASE_URL would "
            "silently downgrade this instance to one shared password."
        )
    if env_truthy("RC_DEV"):
        raise ConfigurationError(
            f"RC_DEV must not be enabled when RC_ENV={env}. It exposes operator-only affordances "
            "(in-app prompt editing, force rebuild) to every user of the instance."
        )
    if not allowed_users():
        raise ConfigurationError(
            f"RC_ALLOWED_USERS must list at least one user id when RC_ENV={env}. Supabase sign-up "
            "is self-service, so without an allowlist the first stranger to register gets full "
            "access to every project and the shared provider keys. Remove this requirement only "
            "once per-user ownership (M2) is enforced."
        )


def mode() -> str:
    if SUPABASE_URL:
        return "supabase"
    if LEGACY_TOKEN:
        return "token"
    return "open"


def enabled() -> bool:
    return mode() != "open"


def public_config() -> dict:
    """Non-secret config the clients need to drive login. anon key is publishable."""
    return {
        "mode": mode(),
        "enabled": enabled(),
        "supabase_url": SUPABASE_URL,
        "supabase_anon_key": SUPABASE_ANON_KEY,
    }


def _jwks():
    global _jwk_client
    if _jwk_client is None:
        import jwt  # PyJWT
        _jwk_client = jwt.PyJWKClient(_JWKS_URL)
    return _jwk_client


def verify(token: str) -> dict:
    """Return verified claims for a Supabase user JWT, or raise AuthError."""
    import jwt
    if not token:
        raise AuthError("Missing token")
    try:
        signing_key = _jwks().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, signing_key,
            algorithms=["ES256", "RS256"],
            audience=_AUDIENCE, issuer=_ISSUER,
            options={"require": ["exp", "sub"]},
        )
        return claims
    except AuthError:
        raise
    except Exception as e:  # PyJWKClientError / InvalidTokenError / network
        raise AuthError(f"Invalid token: {e}") from e


def check(token: str) -> dict | None:
    """Gate one request. Returns the user dict (supabase) / {} (token mode) when allowed; raises
    AuthError (401) when the credentials are bad, or NotAllowlisted (403) when they are valid but
    the user is not permitted on this instance. In open mode returns None (no user)."""
    m = mode()
    if m == "open":
        return None
    if m == "token":
        if token != LEGACY_TOKEN:
            raise AuthError("Unauthorized")
        return {}
    claims = verify(token)
    user_id = claims.get("sub")
    allowed = allowed_users()
    # Empty list means "no allowlist configured" (dev). Non-dev environments cannot reach here
    # with an empty list — assert_environment_safe refuses to start in that state.
    if allowed and user_id not in allowed:
        raise NotAllowlisted(user_id or "unknown")
    return {"user_id": user_id, "email": claims.get("email"), "claims": claims}
