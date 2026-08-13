"""Response compression (SelectiveGZipMiddleware in app.main).

The clients poll multi-KB JSON constantly (session snapshots every 900 ms during a turn), so
large JSON must go out gzipped — but media must not: PNG/JPEG re-compression is wasted CPU, and
a gzip-wrapped 206 would corrupt what audio Range offsets mean to a seeking player.
"""
from __future__ import annotations

from starlette.testclient import TestClient


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


def test_large_json_is_gzipped():
    client = _client()
    resp = client.get("/api/prompts", headers={"Accept-Encoding": "gzip"})
    assert resp.status_code == 200
    assert len(resp.content) > 1000  # premise: this payload is big enough to qualify
    assert resp.headers.get("content-encoding") == "gzip"
    assert resp.json()["prompts"]  # body survives the round trip (httpx decompresses)


def test_small_responses_stay_identity():
    client = _client()
    resp = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers


def test_clients_not_asking_for_gzip_get_identity():
    client = _client()
    resp = client.get("/api/prompts", headers={"Accept-Encoding": "identity"})
    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers


def test_media_paths_bypass_compression():
    """The path filter, pinned as data: media never enters the gzip responder, JSON always may.

    Asserted on the regex rather than end-to-end because a real cover/figure/audio response
    needs a rendered artifact on disk; the dispatch above it is two lines that only consult
    this pattern.
    """
    from app.main import _UNCOMPRESSED_MEDIA as media

    assert media.search("/api/projects/p1/papers/some-slug/cover.png")
    assert media.search("/api/projects/p1/papers/some-slug/figures/fig-3.png")
    assert media.search("/api/audio/abc123.mp3")
    assert not media.search("/api/audio/jobs")
    assert not media.search("/api/audio/jobs/j-42")
    assert not media.search("/api/projects/p1/session/some-slug")
    assert not media.search("/api/prompts")
