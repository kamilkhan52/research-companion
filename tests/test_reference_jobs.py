from __future__ import annotations

import time

from app import config, graph_store, paper_metadata, reference_jobs

from tests.conftest import add_paper


def _wait(job_id: str, timeout: float = 3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = reference_jobs._registry.get(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError(job_id)


def test_reference_job_runs_in_project_context_and_persists_canonical_record(temp_project):
    add_paper(temp_project, "paper", "Paper", full_text="Full text")
    observed: list[str | None] = []

    def extract(slug, title, full_text, model):
        observed.append(config.active_project_id())
        return {
            "slug": slug,
            "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "t",
            "model": model,
            "status": "done",
            "references": [],
            "error": "",
        }

    job = reference_jobs.start("paper", model="test", extract_fn=extract)
    assert job is not None
    assert _wait(job.id).status == "done"
    assert observed == [temp_project]
    assert paper_metadata.reference_record("paper")["status"] == "done"
