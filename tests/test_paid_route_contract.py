"""The public API exposes one connection-independent entry point per paid workflow.

This is intentionally an enumeration test: a legacy route being accidentally re-registered is a
spend-control bypass even when every production client continues to use jobs.
"""
from __future__ import annotations


def _post_paths() -> set[str]:
    from app.main import app

    return {path for path, operations in app.openapi()["paths"].items() if "post" in operations}


def test_paid_work_is_exposed_only_through_background_job_routes():
    paths = _post_paths()

    active = {
        "/api/audio/jobs",
        "/api/projects/{pid}/retrieval/jobs",
        "/api/projects/{pid}/chat/start_job",
        "/api/projects/{pid}/reply_job",
        "/api/projects/{pid}/continue_job",
        "/api/projects/{pid}/retry_job",
        "/api/projects/{pid}/edit_job",
        "/api/projects/{pid}/finish_job",
        "/api/projects/{pid}/request_changes_job",
    }
    retired = {
        "/api/speak",
        "/api/narrate",
        "/api/projects/{pid}/start",
        "/api/projects/{pid}/start_stream",
        "/api/projects/{pid}/chat/start_stream",
        "/api/projects/{pid}/reply",
        "/api/projects/{pid}/reply_stream",
        "/api/projects/{pid}/continue",
        "/api/projects/{pid}/continue_stream",
        "/api/projects/{pid}/retry_stream",
        "/api/projects/{pid}/edit_stream",
        "/api/projects/{pid}/finish",
        "/api/projects/{pid}/finish_stream",
        "/api/projects/{pid}/request_changes",
        "/api/projects/{pid}/request_changes_stream",
    }

    assert active <= paths
    assert retired.isdisjoint(paths)
