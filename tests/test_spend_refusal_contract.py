"""The refusal contract between refusals raised anywhere and the mobile client (DR-049).

HTTP admission refusals and refusals raised later inside a worker now share ONE derivation —
``refusal_payload()`` on the exception — delivered either as the HTTP body or as the job
snapshot's ``refusal`` field. The client classifies ``code``; the prose in ``detail`` is display
copy, free to change without a client release. Before DR-049 the job path carried only
``Job.error`` text and the mobile adapter matched three exact messages, which pinned every copy
edit to a client release.
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from app import quotas, rate_limits
from app.jobs import Job, JobRegistry
from app.main import _quota_exceeded


@pytest.mark.parametrize(
    ("kwargs", "status", "code"),
    [
        (
            {"used_nanousd": 90, "settled_nanousd": 0,
             "requested_nanousd": 20, "limit_nanousd": 100},
            429,
            "holds_outstanding",
        ),
        (
            {"used_nanousd": 0, "requested_nanousd": 101, "limit_nanousd": 100},
            402,
            "quota_exceeded",
        ),
        (
            {"used_nanousd": 100, "settled_nanousd": 100,
             "requested_nanousd": 10, "limit_nanousd": 100},
            402,
            "quota_exceeded",
        ),
    ],
)
def test_http_body_is_the_exceptions_own_payload(kwargs, status, code):
    """The handler serves `refusal_payload()` verbatim (transient pops retry into the header),
    so the HTTP and job paths cannot drift apart — they are the same dict."""
    refusal = quotas.QuotaExceeded(**kwargs)
    payload = refusal.refusal_payload()
    assert payload["code"] == code
    assert payload["detail"] == str(refusal)
    assert payload["limit_nanousd"] == kwargs["limit_nanousd"]

    response = asyncio.run(_quota_exceeded(None, refusal))
    body = json.loads(response.body)
    assert response.status_code == status
    assert body["code"] == code
    assert body["detail"] == str(refusal)
    if status == 429:
        assert response.headers["retry-after"] == "15"
        assert "retry_after_seconds" not in body  # header, not body, on the HTTP path
    else:
        assert body["requested_nanousd"] == kwargs["requested_nanousd"]


def _settled(registry: JobRegistry, job_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = registry.snapshot(job_id)
        if snap and snap["status"] != "running":
            return snap
        time.sleep(0.02)
    raise TimeoutError(job_id)


def test_a_worker_refusal_reaches_the_snapshot_structured(temp_project):
    """The central stamp: a QuotaExceeded escaping `work` puts the exception's own payload on
    the job, next to the prose in `error` — the client reads `refusal.code`, never the text."""
    registry: JobRegistry[Job] = JobRegistry("refusal-test", max_finished=4)

    def refused(_job: Job) -> None:
        raise quotas.QuotaExceeded(
            used_nanousd=100, settled_nanousd=100, requested_nanousd=10, limit_nanousd=100)

    job = registry.start_or_join("k1", lambda: Job(id="r1"), refused)
    snap = _settled(registry, job.id)
    assert snap["status"] == "error"
    assert snap["refusal"]["code"] == "quota_exceeded"
    assert snap["refusal"]["limit_nanousd"] == 100
    assert snap["error"] == snap["refusal"]["detail"]


def test_a_transient_worker_refusal_carries_retry_after(temp_project):
    registry: JobRegistry[Job] = JobRegistry("refusal-test-2", max_finished=4)

    def held(_job: Job) -> None:
        raise quotas.QuotaExceeded(
            used_nanousd=90, settled_nanousd=0, requested_nanousd=20, limit_nanousd=100)

    snap = _settled(registry, registry.start_or_join("k1", lambda: Job(id="r2"), held).id)
    assert snap["refusal"]["code"] == "holds_outstanding"
    assert snap["refusal"]["retry_after_seconds"] == 15


def test_a_rate_refusal_and_an_unavailable_ledger_are_coded_too(temp_project):
    registry: JobRegistry[Job] = JobRegistry("refusal-test-3", max_finished=4)

    def limited(_job: Job) -> None:
        raise rate_limits.RateLimited("Too many starts.", retry_after_seconds=7)

    snap = _settled(registry, registry.start_or_join("k1", lambda: Job(id="r3"), limited).id)
    assert snap["refusal"] == {
        "code": "rate_limited", "detail": "Too many starts.", "retry_after_seconds": 7,
    }

    def unavailable(_job: Job) -> None:
        raise quotas.QuotaUnavailable("The usage ledger is unreachable.")

    snap = _settled(registry, registry.start_or_join("k2", lambda: Job(id="r4"), unavailable).id)
    assert snap["refusal"] == {
        "code": "quota_unavailable", "detail": "The usage ledger is unreachable.",
    }


def test_an_ordinary_failure_gains_no_structure(temp_project):
    """Arbitrary exception text must not acquire a refusal payload — the field's guarantee is
    that its contents are the account's own figures and app-authored copy, nothing else."""
    registry: JobRegistry[Job] = JobRegistry("refusal-test-4", max_finished=4)

    def broken(_job: Job) -> None:
        raise RuntimeError("provider 503")

    snap = _settled(registry, registry.start_or_join("k1", lambda: Job(id="r5"), broken).id)
    assert snap["status"] == "error"
    assert snap["refusal"] is None
