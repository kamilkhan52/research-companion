"""notes_jobs: viewing/saving committed notes and the agent-assisted edit job. Saves must
land in the store AND be git-committed (same versioning contract as committer.py); the agent
edit must run as a real background thread with injected runners (zero network) whose result
stays a proposal — nothing on disk changes until save() applies it."""
from __future__ import annotations

import subprocess
import threading
import time

import pytest
from app import notes_jobs, projects, store

from tests.conftest import add_paper


@pytest.fixture(autouse=True)
def _clear_jobs():
    notes_jobs._jobs.clear()
    yield
    notes_jobs._jobs.clear()


def _last_commit_message(pid: str) -> str:
    out = subprocess.run(["git", "log", "-1", "--format=%s"],
                         cwd=str(projects.project_path(pid)), capture_output=True, text=True)
    return out.stdout.strip()


def _sync_runner(events):
    return lambda target, prompt: iter(events)


def _wait_until_settled(job_id: str, timeout: float = 5.0) -> notes_jobs.NotesJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = notes_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(f"notes job {job_id} did not settle within {timeout}s")


# ---- read / save ----

def test_paper_notes_save_and_read_round_trip(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    assert notes_jobs.read("p1") == ""

    result = notes_jobs.save("p1", "Key finding: it works.")
    assert result["ok"] and result["rev"]
    text = notes_jobs.read("p1")
    assert text.startswith("## Notes\n")         # heading on its own line, well-formed markdown
    assert "Key finding: it works." in text
    assert _last_commit_message(temp_project) == "Edit notes: Paper One"
    # The full text is untouched by a notes edit.
    assert store.read_full_text("p1") == "full text"


def test_working_notes_save_and_read_round_trip(temp_project):
    assert notes_jobs.read(notes_jobs.WORKING) == ""
    notes_jobs.save(notes_jobs.WORKING, "# Synthesis\n\nThe field is young.",
                    summary="Fold in the new papers")
    assert notes_jobs.read(notes_jobs.WORKING).strip() == "# Synthesis\n\nThe field is young."
    assert _last_commit_message(temp_project) == "Fold in the new papers"


def test_save_rejects_empty_and_unknown_targets(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    with pytest.raises(notes_jobs.NotesError):
        notes_jobs.save("p1", "   ")
    with pytest.raises(notes_jobs.NotesError):
        notes_jobs.save("nope", "text")
    with pytest.raises(notes_jobs.NotesError):
        notes_jobs.read("nope")


# ---- agent edit job ----

def test_agent_edit_is_a_proposal_and_touches_nothing_on_disk(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    notes_jobs.save("p1", "## Notes\n\nOriginal text.")
    events = [
        {"type": "tool", "name": "web_search", "detail": "paper one citations"},
        {"type": "text", "text": "## Notes\n\nRevised "},
        {"type": "text", "text": "text."},
        {"type": "final", "text": "## Notes\n\nRevised text."},
    ]

    job = notes_jobs.start_edit("p1", "revise it", runner=_sync_runner(events))
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.result == "## Notes\n\nRevised text."
    assert [it["kind"] for it in finished.items] == ["tool", "text"]
    # Proposal only: the stored notes are unchanged until save() applies it.
    assert "Original text." in notes_jobs.read("p1")


def test_agent_result_strips_a_wrapping_code_fence(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    notes_jobs.save("p1", "## Notes\n\nOriginal.")
    fenced = "```markdown\n## Notes\n\nRevised.\n```"
    job = notes_jobs.start_edit("p1", "revise", runner=_sync_runner([{"type": "final", "text": fenced}]))
    assert _wait_until_settled(job.id).result == "## Notes\n\nRevised."


def test_runner_failure_is_an_error_job(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    notes_jobs.save("p1", "## Notes\n\nOriginal.")

    def exploding(target, prompt):
        yield {"type": "text", "text": "half a rev"}
        raise notes_jobs.agent.AgentError("boom")

    job = notes_jobs.start_edit("p1", "revise", runner=exploding)
    finished = _wait_until_settled(job.id)
    assert finished.status == "error" and "boom" in (finished.error or "")
    assert "Original." in notes_jobs.read("p1")


def test_start_requires_existing_notes_and_instruction(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    with pytest.raises(notes_jobs.NotesError):
        notes_jobs.start_edit("p1", "revise")          # no notes yet
    notes_jobs.save("p1", "## Notes\n\nOriginal.")
    with pytest.raises(notes_jobs.NotesError):
        notes_jobs.start_edit("p1", "   ")             # empty instruction


def test_second_start_for_same_target_joins_the_running_job(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    notes_jobs.save("p1", "## Notes\n\nOriginal.")
    release = threading.Event()

    def slow(target, prompt):
        release.wait(5)
        yield {"type": "final", "text": "## Notes\n\nRevised."}

    first = notes_jobs.start_edit("p1", "revise", runner=slow)
    second = notes_jobs.start_edit("p1", "revise again", runner=_sync_runner([]))
    assert second is first
    assert notes_jobs.active_for("p1") is first

    release.set()
    assert _wait_until_settled(first.id).status == "done"
    assert notes_jobs.active_for("p1") is None


def test_edit_prompt_contains_document_and_instruction(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    notes_jobs.save("p1", "## Notes\n\nOriginal.")
    seen = {}

    def capture(target, prompt):
        seen["prompt"] = prompt
        yield {"type": "final", "text": "## Notes\n\nRevised."}

    job = notes_jobs.start_edit("p1", "make it shorter", runner=capture)
    _wait_until_settled(job.id)
    assert "Original." in seen["prompt"]
    assert "make it shorter" in seen["prompt"]
    assert "Paper One" in seen["prompt"]
