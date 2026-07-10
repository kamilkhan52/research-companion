"""Smoke-test the web-client serving path. Verifies that the root page serves valid
HTML from the committed web/dist/ — not raw Vite source that a browser cannot execute."""
from __future__ import annotations

from starlette.testclient import TestClient


def test_root_serves_valid_html():
    """GET / returns HTML (not raw TSX) containing the React mount point."""
    from app.main import app

    client = TestClient(app)
    resp = client.get("/")
    assert resp.status_code == 200
    content_type = resp.headers.get("content-type", "")
    assert "text/html" in content_type
    body = resp.text
    assert '<div id="root">' in body
    assert "text/javascript" not in content_type
    assert 'type="module"' not in body or '/assets/' in body
