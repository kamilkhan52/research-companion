"""App-global, unauthenticated bootstrap routes: health and the public auth config clients
read before they can log in (both are in main's `_AUTH_EXEMPT` set)."""
from __future__ import annotations

from fastapi import APIRouter

from .. import auth, config

router = APIRouter()


@router.get("/api/health")
def health():
    return {"ok": True, "title": config.APP_TITLE, "dev": config.dev_mode()}


@router.get("/api/auth/config")
def auth_config():
    """Public: tells clients the auth mode and (for supabase) the publishable URL + anon key,
    so login config isn't hardcoded in the web/mobile clients."""
    return auth.public_config()
