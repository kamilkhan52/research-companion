"""The auth middleware's two denials, and what each one is allowed to say.

Lives apart from `test_env_gating.py` on purpose: that module's autouse fixture unsets `RC_ENV` so
it can test the boot guard, and importing `app.main` under an unset `RC_ENV` refuses to start — by
design. These tests need the app object, so they need the suite's normal `RC_ENV=dev`.
"""
from __future__ import annotations

from app import auth
from starlette.testclient import TestClient


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


def test_the_health_probe_stays_open_so_clients_can_bootstrap(monkeypatch):
    """If the exempt list ever stopped covering it, a client could not discover how to sign in —
    and the operator could not tell a down instance from a locked-out one."""
    from app.main import app

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "check", _reject)

    assert TestClient(app).get("/api/health").status_code == 200
    assert TestClient(app).get("/api/auth/config").status_code == 200
