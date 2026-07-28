"""Narrow server-side access to Supabase Auth administration.

The publishable anon key used by the clients cannot delete Auth identities. Supabase requires a
secret/service-role key for that operation, so this module is the only place the credential is
read and the only admin operation the application exposes. It must never be imported by or
serialized to either client.
"""
from __future__ import annotations

import os
import uuid
from urllib.parse import urlsplit

import httpx

from . import auth

TIMEOUT_S = 15.0
SECRET_ENV = "RC_SUPABASE_SECRET_KEY"


class SupabaseAdminUnavailable(RuntimeError):
    """The server is not configured to perform Auth administration."""


class SupabaseDeleteError(RuntimeError):
    """A sanitized Auth deletion failure safe for job state and operational logs."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(f"Supabase Auth deletion failed ({code}).")


def configured() -> bool:
    """Whether both the Auth origin and server-only secret are present."""
    return bool(auth.SUPABASE_URL and os.environ.get(SECRET_ENV, "").strip())


def _canonical_user_id(user_id: str) -> str:
    try:
        return str(uuid.UUID(user_id))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("user_id must be a UUID") from exc


def _admin_origin() -> str:
    base_url = auth.SUPABASE_URL
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise SupabaseAdminUnavailable(
            "Supabase Auth deletion requires RC_SUPABASE_URL to be an HTTPS origin.")
    return base_url.rstrip("/")


def delete_user(user_id: str, *, client: httpx.Client | None = None) -> None:
    """Permanently remove one Supabase Auth identity.

    A missing identity is success, making the final account-deletion step safe to retry after a
    crash or lost response. Provider bodies and exception messages are deliberately discarded:
    they can contain identity data and must not be copied into logs or durable job errors.

    The caller owns an injected client. The default client refuses redirects so the admin
    credential cannot be forwarded away from the configured Supabase origin.
    """
    canonical_id = _canonical_user_id(user_id)
    secret = os.environ.get(SECRET_ENV, "").strip()
    if not auth.SUPABASE_URL or not secret:
        raise SupabaseAdminUnavailable(
            f"Supabase Auth deletion requires RC_SUPABASE_URL and {SECRET_ENV}.")
    base_url = _admin_origin()

    url = f"{base_url}/auth/v1/admin/users/{canonical_id}"
    headers = {"Authorization": f"Bearer {secret}", "apikey": secret}

    owns_client = client is None
    requester = client or httpx.Client(timeout=TIMEOUT_S, follow_redirects=False)
    try:
        try:
            response = requester.request(
                "DELETE", url, headers=headers, follow_redirects=False)
        except httpx.HTTPError as exc:
            raise SupabaseDeleteError(f"network:{type(exc).__name__}") from None
        if response.status_code in {200, 204, 404}:
            return
        raise SupabaseDeleteError(f"http:{response.status_code}")
    finally:
        if owns_client:
            requester.close()
