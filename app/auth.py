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

SUPABASE_URL = os.environ.get("RC_SUPABASE_URL", "").rstrip("/")
# Publishable (safe to expose to clients); needed by supabase-js to start the auth flow.
SUPABASE_ANON_KEY = os.environ.get("RC_SUPABASE_ANON_KEY", "")
LEGACY_TOKEN = os.environ.get("RC_AUTH_TOKEN", "")

_ISSUER = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else ""
_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
_AUDIENCE = "authenticated"

_jwk_client = None  # lazily-created PyJWKClient (caches signing keys)


class AuthError(Exception):
    pass


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
        raise AuthError(f"Invalid token: {e}")


def check(token: str) -> dict | None:
    """Gate one request. Returns the user dict (supabase) / {} (token mode) when allowed;
    raises AuthError when denied. In open mode returns None (no user)."""
    m = mode()
    if m == "open":
        return None
    if m == "token":
        if token != LEGACY_TOKEN:
            raise AuthError("Unauthorized")
        return {}
    claims = verify(token)
    return {"user_id": claims.get("sub"), "email": claims.get("email"), "claims": claims}
