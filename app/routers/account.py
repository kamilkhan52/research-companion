"""Authenticated account-deletion start and polling routes."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import account_deletion

router = APIRouter()

RECENT_SESSION_S = 300


class DeleteAccountRequest(BaseModel):
    confirmation: str


def _user(request: Request) -> dict:
    user = request.state.user or {}
    user_id = user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="A Supabase account is required.")
    return user


def _require_recent_session(user: dict) -> None:
    issued_at = (user.get("claims") or {}).get("iat")
    now = int(time.time())
    if (
        not isinstance(issued_at, (int, float))
        or issued_at > now + 60
        or now - issued_at > RECENT_SESSION_S
    ):
        raise HTTPException(
            status_code=401,
            detail="Refresh your sign-in before permanently deleting this account.",
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
    _require_recent_session(user)
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
