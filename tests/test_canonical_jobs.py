from __future__ import annotations

import time
from types import SimpleNamespace

from app import canonical_jobs

from tests.conftest import add_paper

_REAL_WARM_ASYNC = canonical_jobs.warm_async


def test_first_read_coordinator_fans_out_reference_extraction(temp_project, monkeypatch):
    add_paper(temp_project, "paper", "Paper", full_text="Full text")
    started: list[tuple[str, str]] = []

    def child(kind: str):
        def start(slug: str):
            started.append((kind, slug))
            return SimpleNamespace(status="done")
        return start

    monkeypatch.setattr(canonical_jobs.affiliation_jobs, "warm_async", child("affiliations"))
    monkeypatch.setattr(canonical_jobs.reference_jobs, "warm_async", child("references"))
    monkeypatch.setattr(canonical_jobs.figures, "warm_async", child("figures"))

    job = _REAL_WARM_ASYNC("paper")
    assert job is not None
    deadline = time.time() + 2
    while job.status == "running" and time.time() < deadline:
        time.sleep(0.01)

    assert job.status == "done"
    assert started == [
        ("affiliations", "paper"),
        ("references", "paper"),
        ("figures", "paper"),
    ]
    assert job.step == "Paper context ready."
