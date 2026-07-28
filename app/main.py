"""FastAPI app assembly: auth middleware, router registration, and the static web client.

The routes themselves live in `app/routers/<feature>.py` — one module per feature area, each
owning its routes plus the request models and helpers they use (see app/routers/__init__.py).
This module just wires them together: install the log handler, build the app, gate /api/* with
the auth middleware, include every router, then mount the SPA shell last so /api/* wins.
"""
from __future__ import annotations

import os
import re
import threading
import time
from urllib.parse import parse_qsl, urlencode

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, config, db, logging_config
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
_log = logging_config.get("auth")

# Refuse to start a staging/prod process that is configured permissively — BEFORE the app object
# exists, so a misconfigured deploy crashes on boot instead of serving. Every check inside guards
# against an omitted variable rather than a wrong one, because omission is what silently produces
# the permissive state (auth.mode() falls back to "open"; an unset allowlist means "everyone").
auth.assert_environment_safe(config.env_name())

def _apply_migrations() -> None:
    """Bring the schema up to date on boot, when a database is configured at all.

    Until now the only thing that ran migrations was `scripts/adopt_projects.py`, which the
    operator runs by hand — so shipping a migration meant remembering to run a script after the
    deploy, and forgetting it leaves an instance whose code expects a table that is not there.
    `db.migrate()` was written for this: it is idempotent, and it takes an advisory lock precisely
    because a Fly deploy overlaps the old and new machines.

    A failure here is logged, not fatal: if the database is unreachable the alternative is a
    machine that will not boot, which on Fly is a crash loop needing a human.

    But logging alone is not enough, because the process is long-lived and this runs once. A blip
    during a deploy would otherwise leave the replacement machine serving indefinitely against an
    old schema — and the migration most likely to be the missing one is the newest, which right now
    is the Data API lockout (`0004`). So a failure arms a background retry instead. The exposure
    window is then bounded by the retry interval rather than by "until somebody restarts it", and
    it closes on its own: the app can only *use* the database under the same condition that lets
    the retry succeed.
    """
    if not db.enabled():
        return
    try:
        applied = db.migrate()
    except Exception as e:  # noqa: BLE001 — see the docstring: a boot must not depend on this
        _log.error("db: migrations did not run (%s): %s — retrying in the background",
                   db.safe_target(), str(e)[:300])
        _retry_migrations_until_they_apply()
        return
    if applied:
        _log.info("db: applied migrations: %s", ", ".join(applied))


MIGRATION_RETRY_START_S = 5.0
MIGRATION_RETRY_MAX_S = 300.0


def _retry_migrations_until_they_apply() -> None:
    """Keep trying, with backoff, until the schema is current. Daemon thread, so it never holds up
    shutdown; single worker (invariant 6), so there is only ever one of these."""
    def _retry() -> None:
        delay = MIGRATION_RETRY_START_S
        while True:
            time.sleep(delay)
            try:
                applied = db.migrate()
            except Exception as e:  # noqa: BLE001 — this loop exists to outlive failures
                _log.warning("db: migration retry failed, next in %.0fs: %s", delay, str(e)[:200])
                delay = min(delay * 2, MIGRATION_RETRY_MAX_S)
                continue
            _log.info("db: migrations applied on retry: %s", ", ".join(applied) or "(none pending)")
            return

    threading.Thread(target=_retry, daemon=True, name="db-migrate-retry").start()


_apply_migrations()

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
# One-release compatibility bridge for installed clients that cannot move in lockstep with the
# backend. Only the two GET image routes emitted by the old mobile bundle qualify; ordinary API,
# audio, SSE, and mutation routes never do. Remove after the header-authenticated mobile release
# is no longer distributed/supported.
_LEGACY_QUERY_MEDIA = re.compile(
    r"^/api/projects/[^/]+/papers/[^/]+/(?:cover\.png|figures/[^/]+)$")


def _query_token_and_redact(request: Request) -> str:
    """Return one legacy `token` value and remove every copy from the ASGI query string.

    Uvicorn builds its access-log request target from the scope after the response. Mutating the
    scope here therefore keeps this app's access log credential-free even during the compatibility
    window. An upstream proxy can still observe the original request target, which is why this
    fallback is temporary rather than a permanent media-auth mechanism.
    """
    raw = request.scope.get("query_string", b"")
    if not raw or b"token" not in raw.lower():
        return ""
    pairs = parse_qsl(raw.decode("utf-8", errors="replace"), keep_blank_values=True)
    values = [value for key, value in pairs if key == "token"]
    request.scope["query_string"] = urlencode(
        [(key, value) for key, value in pairs if key != "token"], doseq=True).encode()
    return values[0] if len(values) == 1 else ""


@app.middleware("http")
async def authenticate(request: Request, call_next):
    """Gate /api/* per app.auth.mode(). Current clients use `Authorization: Bearer <t>`.
    During one mobile-release compatibility window, old clients may use `?token=<t>` only for
    protected cover/figure GETs; the token is stripped from this process's access-log target.
    Native images and audio can attach request headers. OPTIONS, the exempt routes, and non-/api
    routes (static SPA shell) are always allowed. The verified user (if any) is stashed on
    request.state.user for handlers/future per-user data.

    Two distinct denials: 401 for bad/missing credentials, 403 for a valid user who is not on this
    instance's allowlist (see auth.allowed_users)."""
    request.state.user = None
    if auth.enabled() and request.method != "OPTIONS" \
            and request.url.path.startswith("/api/") and request.url.path not in _AUTH_EXEMPT:
        hdr = request.headers.get("authorization", "")
        query_token = _query_token_and_redact(request)
        token = hdr[7:].strip() if hdr[:7].lower() == "bearer " else ""
        if not token and request.method in {"GET", "HEAD"} \
                and _LEGACY_QUERY_MEDIA.fullmatch(request.url.path):
            token = query_token
        try:
            request.state.user = auth.check(token)
        except auth.NotAllowlisted as rejected:
            # Valid credentials, wrong person. 403 rather than 401 on purpose: 401 tells the client
            # to sign in, which would loop an allowlisted-out user through login forever.
            #
            # The id goes to the LOG, never to the response. The response stays deliberately
            # incurious — it must not confirm to a stranger which account they just proved they
            # hold. But the operator needs it: Supabase user ids are PER PROJECT, so pointing an
            # instance at a different Supabase project invalidates every id in RC_ALLOWED_USERS and
            # locks everyone out, including the operator, with no way to read the new id off the
            # 403. `fly logs` is then the shortest path back in. The same line answers "why can't
            # my tester sign in" once there are testers.
            should_log, suppressed = auth.note_rejection(str(rejected))
            if should_log:
                _log.warning(
                    "auth: rejected non-allowlisted user id=%s%s", rejected,
                    f" ({suppressed} similar suppressed since the last line)" if suppressed else "")
            return JSONResponse(
                {"detail": "This account is not authorized for this instance."}, status_code=403)
        except AuthError:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)

    # Bind the verified user for the rest of this request, so `config.load_settings()` returns
    # THEIR effective settings (model, voice, prior-notes scope) without every one of its ~24 call
    # sites having to be handed a user. Set before `call_next`: the endpoint runs in a context
    # copied from this one, so the value propagates down but never leaks back up or sideways into
    # another request. `tests/test_user_settings.py` asserts that propagation over HTTP rather than
    # assuming it. Reset in `finally` because this coroutine's context outlives the response.
    token = config.set_active_user((request.state.user or {}).get("user_id"))
    try:
        return await call_next(request)
    finally:
        config.reset_active_user(token)


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
