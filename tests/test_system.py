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
