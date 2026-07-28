"""Authenticated account-deletion start and polling routes."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import account_deletion, content_reports, logging_config

router = APIRouter()

log = logging_config.get("account")

RECENT_AUTHENTICATION_S = 300
# The one detail a pre-persistence refusal returns. The mobile client matches this exact string to
# decide it is safe to clear its local deletion marker, so it is part of the contract: changing it
# needs the client changed in the same PR, and nothing else may reuse it.
UNCONFIGURED_DETAIL = "Account deletion is not configured on this server yet."
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


class ContentReportRequest(BaseModel):
    surface: str
    reason: str
    project_id: str | None = None
    paper_slug: str | None = None
    reference: str | None = None
    reporter_note: str | None = None


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
        # ONE stable detail for every raise of this class, with the specific reason logged rather
        # than returned. The client has to decide whether a 503 landed before or after the durable
        # tombstone: before, it clears its local deletion marker; after, it must keep it. It makes
        # that call by matching this string, and `AccountDeletionUnavailable` is by construction the
        # pre-persistence case — so the match has to be complete, not merely correct today.
        #
        # It was not. This raised `str(exc)`, and the class has two messages; the client knew only
        # the second. On an instance with `RC_DATABASE_URL` unset, a tap wrote a marker nothing
        # could ever clear, which then wiped drafts, active project and the image cache at the next
        # ORDINARY sign-out. A third message would have reintroduced it. One string cannot.
        log.warning("account deletion refused before persistence: %s", exc)
        raise HTTPException(
            status_code=503, detail=UNCONFIGURED_DETAIL,
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Account deletion could not be started.",
        ) from exc
    return {"deletion": state}


@router.post("/api/reports/content", status_code=201)
def report_content(body: ContentReportRequest, request: Request):
    """Report offensive AI-generated content without leaving the app.

    Required by Google Play's AI-Generated Content policy for any app whose content is model
    output, which is all of this one. Kept a plain POST rather than a job (invariant 1): it is one
    small insert, and a reader who has just seen something objectionable should be told immediately
    that it was recorded, not handed a job id to poll.
    """
    user = _user(request)
    try:
        created = content_reports.submit(
            user["user_id"],
            surface=body.surface,
            reason=body.reason,
            project_id=body.project_id,
            paper_slug=body.paper_slug,
            reference=body.reference,
            reporter_note=body.reporter_note,
            email=user.get("email"),
        )
    except content_reports.ContentReportError as exc:
        # 422 rather than 500: every one of these is something the caller can correct or a limit
        # they have hit, and the message is written to be shown to them.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail="The report could not be recorded. Please try again.",
        ) from exc
    return {"report": created}
