"""The safe refusal text retained by background jobs is a mobile/server wire contract.

HTTP admissions carry structured fields, but a refusal raised later inside a worker is currently
serialized as ``Job.error`` text. The mobile adapter therefore has to recognize these exact
messages until DR-049 gives job snapshots structured refusal metadata too.
"""
from __future__ import annotations

import asyncio
import json

import pytest
from app import quotas
from app.main import _quota_exceeded


@pytest.mark.parametrize(
    ("kwargs", "status", "code", "message"),
    [
        (
            {"used_nanousd": 90, "settled_nanousd": 0,
             "requested_nanousd": 20, "limit_nanousd": 100},
            429,
            "holds_outstanding",
            "Your other tasks are still running. Give them a moment and try again.",
        ),
        (
            {"used_nanousd": 0, "requested_nanousd": 101, "limit_nanousd": 100},
            402,
            "quota_exceeded",
            "This task needs more than your whole monthly allowance.",
        ),
        (
            {"used_nanousd": 100, "settled_nanousd": 100,
             "requested_nanousd": 10, "limit_nanousd": 100},
            402,
            "quota_exceeded",
            "Your usage limit has been reached. Try again after it resets.",
        ),
    ],
)
def test_job_and_http_refusals_share_the_pinned_safe_message(kwargs, status, code, message):
    refusal = quotas.QuotaExceeded(**kwargs)

    # JobRegistry retains this exception as text when it is raised inside a worker.
    assert str(refusal) == message

    # Synchronous admission must describe the same state with the same reader-facing copy.
    response = asyncio.run(_quota_exceeded(None, refusal))
    body = json.loads(response.body)
    assert response.status_code == status
    assert body["detail"] == message
    assert body["code"] == code
