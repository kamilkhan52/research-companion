"""The auth middleware's two denials, and what each one is allowed to say.

Lives apart from `test_env_gating.py` on purpose: that module's autouse fixture unsets `RC_ENV` so
it can test the boot guard, and importing `app.main` under an unset `RC_ENV` refuses to start — by
design. These tests need the app object, so they need the suite's normal `RC_ENV=dev`.
"""
from __future__ import annotations

import pytest
from app import auth
from starlette.testclient import TestClient


@pytest.fixture(autouse=True)
def _fresh_rejection_counters():
    """The dedup/rate-limit state is module-global and would otherwise leak between tests — the
    second test to reject the same id would find it already suppressed."""
    auth._reset_rejection_state()
    yield
    auth._reset_rejection_state()


def _reject(_token):
    raise auth.NotAllowlisted("stranger-uuid-9f2c")


def test_rejected_user_id_is_logged_but_never_returned(monkeypatch, capfd):
    """The 403 body must not name the account; the log must.

    Both halves matter and they pull in opposite directions. Putting the id in the response would
    confirm to a stranger which account they just proved they hold. Logging it nowhere strands the
    operator: Supabase user ids are **per project**, so repointing an instance at a different
    Supabase project invalidates every id in `RC_ALLOWED_USERS` at once — including the operator's —
    and the 403 deliberately offers no way to learn the new one.

    Asserts on captured **stderr**, not `caplog`: `logging_config.configure()` sets
    `propagate = False` on the `rc` logger so it owns its handler, which means pytest's root-level
    caplog handler never sees the record. Stderr is also what `fly logs` actually shows, so this
    tests the thing the operator will really read.
    """
    from app.main import app

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "check", _reject)

    response = TestClient(app).get(
        "/api/settings", headers={"Authorization": "Bearer whatever"})

    assert response.status_code == 403
    assert "stranger-uuid-9f2c" not in response.text
    assert "stranger-uuid-9f2c" in capfd.readouterr().err


def test_bad_credentials_are_401_and_log_no_identity(monkeypatch, capfd):
    """The other denial. A 401 means "sign in"; there is no verified identity to log, and the
    absence of a log line here is what keeps the 403 line above meaningful."""
    from app.main import app

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(
        auth, "check", lambda _t: (_ for _ in ()).throw(auth.AuthError("bad token")))

    response = TestClient(app).get(
        "/api/settings", headers={"Authorization": "Bearer nonsense"})

    assert response.status_code == 401
    assert "rejected non-allowlisted" not in capfd.readouterr().err


def test_query_string_bearer_tokens_are_only_a_legacy_media_fallback(monkeypatch):
    """Current clients use headers. Keep one narrow fallback so an already-installed client does
    not lose every cover during a non-atomic mobile/backend rollout."""
    from app.main import app

    seen = []

    def check(token):
        seen.append(token)
        if token != "valid-header-token":
            raise auth.AuthError("bad token")
        return {"user_id": "00000000-0000-0000-0000-000000000001"}

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "check", check)

    client = TestClient(app)
    assert client.get("/api/settings?token=valid-header-token").status_code == 401
    assert seen == [""]
    # Authentication succeeded; the missing project then produces the expected route-level 404.
    assert client.get(
        "/api/projects/missing/papers/paper/cover.png?token=valid-header-token",
    ).status_code == 404
    assert seen[-1] == "valid-header-token"
    assert client.get(
        "/api/settings", headers={"Authorization": "Bearer valid-header-token"}).status_code == 200


def test_query_tokens_are_removed_from_the_access_log_scope():
    """Uvicorn formats its access target from this scope after the response."""
    from app.main import _query_token_and_redact
    from starlette.requests import Request

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/projects/p/papers/s/cover.png",
        "query_string": b"v=7&token=secret-jwt&download=1",
        "headers": [],
    }
    request = Request(scope)

    assert _query_token_and_redact(request) == "secret-jwt"
    assert scope["query_string"] == b"v=7&download=1"


def test_the_health_probe_stays_open_so_clients_can_bootstrap(monkeypatch):
    """If the exempt list ever stopped covering it, a client could not discover how to sign in —
    and the operator could not tell a down instance from a locked-out one."""
    from app.main import app

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "check", _reject)

    assert TestClient(app).get("/api/health").status_code == 200
    assert TestClient(app).get("/api/auth/config").status_code == 200


def test_a_flood_of_rejections_cannot_flood_the_log():
    """Supabase sign-up is self-service, so a stranger can hold a valid non-allowlisted token and
    drive this log line with every request. One line per subject per window, so the operator's
    signal survives the flood — and the suppressed count rides on the next emitted line, so the
    flood is still *visible*, just not *voluminous*."""
    logged = [auth.note_rejection("abuser")[0] for _ in range(500)]
    assert logged.count(True) == 1

    # The next distinct subject still gets through — suppression is per subject, not a global mute.
    should_log, suppressed = auth.note_rejection("someone-else")
    assert should_log
    assert suppressed == 499


def test_rotating_user_ids_cannot_evade_the_bound():
    """Per-subject dedup alone would let an attacker who creates many accounts log once per id. The
    per-window ceiling is what actually bounds it."""
    emitted = sum(auth.note_rejection(f"id-{n}")[0] for n in range(5_000))
    assert emitted == auth._REJECT_MAX_LINES


def test_the_dedup_map_cannot_grow_without_bound():
    """The map is attacker-grown, so it is the flood vector if left unbounded."""
    for n in range(5_000):
        auth.note_rejection(f"id-{n}")
    assert len(auth._reject_seen) <= auth._REJECT_MAX_TRACKED


def test_a_subject_can_log_again_in_the_next_window():
    """Suppression must expire, or a persistent problem goes permanently quiet after one line."""
    assert auth.note_rejection("someone", now=1000.0)[0] is True
    assert auth.note_rejection("someone", now=1000.0 + auth._REJECT_WINDOW - 1)[0] is False
    assert auth.note_rejection("someone", now=1000.0 + auth._REJECT_WINDOW + 1)[0] is True
