"""App-global system routes: the health probe carries the dev-mode flag (RC_DEV) that gates
operator-only client affordances — force rebuild-from-scratch, in-app prompt editing (R.5/R.4)."""
from __future__ import annotations

from starlette.testclient import TestClient


def test_health_reports_dev_flag(monkeypatch):
    from app.main import app

    client = TestClient(app)

    monkeypatch.delenv("RC_DEV", raising=False)
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["dev"] is False

    monkeypatch.setenv("RC_DEV", "1")
    assert client.get("/api/health").json()["dev"] is True


def test_the_suite_can_never_write_to_the_real_app_state():
    """Pins the harness itself, not the app. `.app-state/` on a developer's machine IS their live
    instance — their settings, their audio cache, their narration cache. A test that writes there
    corrupts something the developer is actually using, and the failure surfaces far from the test
    that caused it. `PROJECTS_ROOT` has always been redirected; this asserts the other half."""
    from app import audio_jobs, config

    repo_state = (config.BASE_DIR / ".app-state").resolve()
    assert config.APP_STATE_DIR.resolve() != repo_state
    assert config.SETTINGS_FILE.resolve().parent != repo_state
    assert audio_jobs.AUDIO_DIR.resolve().parent != repo_state
    # And the redirect must be somewhere disposable, not merely somewhere else.
    assert "pytest" in str(config.APP_STATE_DIR) or "tmp" in str(config.APP_STATE_DIR).lower()
