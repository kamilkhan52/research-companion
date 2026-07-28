"""Authenticated account-deletion start and polling routes."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import account_deletion

router = APIRouter()

RECENT_AUTHENTICATION_S = 300
_USER_PRESENCE_METHODS = frozenset({
    "email/signup",
    "magiclink",
    "oauth",
    "otp",
    "password",
    "totp",
})


class DeleteAccountRequest(BaseModel):
    confirmation: str


def _user(request: Request) -> dict:
    user = request.state.user or {}
    user_id = user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="A Supabase account is required.")
    return user


def _require_recent_authentication(user: dict) -> None:
    """Require a recent user-presence method, never merely a refreshed access token.

    Supabase access tokens are minted again automatically, so ``iat`` proves token freshness, not
    that the person reauthenticated. Supabase's signed ``amr`` entries retain the method and its
    timestamp; ``token_refresh`` is deliberately absent from the allowlist.
    """
    methods = (user.get("claims") or {}).get("amr")
    now = int(time.time())
    recent = False
    if isinstance(methods, list):
        for entry in methods:
            if not isinstance(entry, dict) or entry.get("method") not in _USER_PRESENCE_METHODS:
                continue
            authenticated_at = entry.get("timestamp")
            if (
                isinstance(authenticated_at, (int, float))
                and authenticated_at <= now + 60
                and now - authenticated_at <= RECENT_AUTHENTICATION_S
            ):
                recent = True
                break
    if not recent:
        raise HTTPException(
            status_code=401,
            detail="Sign in again before permanently deleting this account.",
        )


@router.get("/api/account/deletion")
def deletion_status(request: Request):
    user = _user(request)
    try:
        state = account_deletion.status_for(user["user_id"])
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Account deletion status is temporarily unavailable.",
        ) from exc
    return {"deletion": state}


@router.post("/api/account/deletion", status_code=202)
def delete_account(body: DeleteAccountRequest, request: Request):
    user = _user(request)
    if body.confirmation != "DELETE":
        raise HTTPException(status_code=422, detail='Type "DELETE" to confirm.')
    # Recent authentication authorizes the irreversible operation exactly once. After the durable
    # tombstone exists, POST is only an idempotent retry/resume—even if the Auth DELETE succeeded
    # but its response was lost, making a token refresh impossible because the identity is gone.
    # Requiring recent iat again in that state can permanently strand the retry.
    try:
        existing = account_deletion.status_for(user["user_id"])
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Account deletion status is temporarily unavailable.",
        ) from exc
    if existing is None:
        _require_recent_authentication(user)
    try:
        state = account_deletion.request(user["user_id"])
    except account_deletion.AccountDeletionUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Account deletion could not be started.",
        ) from exc
    return {"deletion": state}
