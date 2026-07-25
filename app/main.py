"""FastAPI app assembly: auth middleware, router registration, and the static web client.

The routes themselves live in `app/routers/<feature>.py` — one module per feature area, each
owning its routes plus the request models and helpers they use (see app/routers/__init__.py).
This module just wires them together: install the log handler, build the app, gate /api/* with
the auth middleware, include every router, then mount the SPA shell last so /api/* wins.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, config, logging_config
from .auth import AuthError
from .routers import (
    audio,
    catalogue,
    covers,
    discovery,
    figures_api,
    graph,
    notes,
    projects_api,
    session,
    settings,
    system,
    usage,
)

logging_config.configure()  # install the rc.* log handler before any job/LLM/commit runs

# Refuse to start a staging/prod process that is configured permissively — BEFORE the app object
# exists, so a misconfigured deploy crashes on boot instead of serving. Every check inside guards
# against an omitted variable rather than a wrong one, because omission is what silently produces
# the permissive state (auth.mode() falls back to "open"; an unset allowlist means "everyone").
auth.assert_environment_safe(config.env_name())

app = FastAPI(title=config.APP_TITLE)

# ---------- exposure hardening: CORS + user auth (Supabase) ----------
# All env-gated and OFF by default, so local/tunnel use is unchanged. See app/auth.py for the
# three modes (supabase | token | open). Enable browser cross-origin with:
#   RC_CORS_ORIGINS=https://a,https://b | *   (native apps ignore CORS)
_CORS_ORIGINS = [o.strip() for o in os.environ.get("RC_CORS_ORIGINS", "").split(",") if o.strip()]
if _CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Routes that must stay open even when auth is on (so clients can bootstrap login).
_AUTH_EXEMPT = {"/api/health", "/api/auth/config"}


@app.middleware("http")
async def authenticate(request: Request, call_next):
    """Gate /api/* per app.auth.mode(). Token arrives as `Authorization: Bearer <t>` (fetch/
    native) or `?token=<t>` (so <audio>/download/SSE tags work). OPTIONS, the exempt routes,
    and non-/api routes (static SPA shell) are always allowed. The verified user (if any) is
    stashed on request.state.user for handlers/future per-user data.

    Two distinct denials: 401 for bad/missing credentials, 403 for a valid user who is not on this
    instance's allowlist (see auth.allowed_users)."""
    request.state.user = None
    if auth.enabled() and request.method != "OPTIONS" \
            and request.url.path.startswith("/api/") and request.url.path not in _AUTH_EXEMPT:
        hdr = request.headers.get("authorization", "")
        token = hdr[7:].strip() if hdr[:7].lower() == "bearer " else request.query_params.get("token", "")
        try:
            request.state.user = auth.check(token)
        except auth.NotAllowlisted:
            # Valid credentials, wrong person. 403 rather than 401 on purpose: 401 tells the client
            # to sign in, which would loop an allowlisted-out user through login forever.
            return JSONResponse(
                {"detail": "This account is not authorized for this instance."}, status_code=403)
        except AuthError:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


# ---------- routers ----------
# App-global routers first, then the per-project routers (each pre-scoped to /api/projects/{pid}
# with the use_project dependency via routers.make_project_router). Order among them doesn't
# matter — every path template is distinct — but all must be registered before the static mount.
app.include_router(system.router)
app.include_router(settings.router)
app.include_router(catalogue.router)
app.include_router(covers.router)
app.include_router(projects_api.router)
app.include_router(usage.router)
app.include_router(audio.router)
app.include_router(projects_api.project_router)
app.include_router(usage.project_router)
app.include_router(session.project_router)
app.include_router(covers.project_router)
app.include_router(figures_api.project_router)
app.include_router(notes.project_router)
app.include_router(discovery.project_router)
app.include_router(graph.project_router)


# ---------- static client (mounted last so /api/* wins) ----------

def _asset_version() -> str:
    """Newest mtime of the client assets — used to bust browser caches on each deploy."""
    try:
        return str(int(max((config.WEB_DIR / f).stat().st_mtime for f in ("app.js", "styles.css"))))
    except OSError:
        return "0"


@app.get("/")
def index():
    # Serve index.html with versioned asset URLs and no-cache, so phones always pick up the
    # latest app.js / styles.css instead of a stale cached copy.
    html = (config.WEB_DIR / "index.html").read_text(encoding="utf-8")
    v = _asset_version()
    html = html.replace("/app.js", f"/app.js?v={v}").replace("/styles.css", f"/styles.css?v={v}")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


app.mount("/", StaticFiles(directory=str(config.WEB_DIR), html=True), name="web")
