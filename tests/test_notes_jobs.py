"""notes_jobs: viewing/saving committed notes and the agent-assisted edit job. Saves must
land in the store AND be git-committed (same versioning contract as committer.py); the agent
edit must run as a real background thread with injected runners (zero network) whose result
stays a proposal — nothing on disk changes until save() applies it."""
from __future__ import annotations

import subprocess
import threading
import time

import pytest
from app import notes_jobs, projects, sessions, store
from fastapi import HTTPException

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
    # A completed proposal is still recoverable on re-entry; it is not a persisted document.
    assert notes_jobs.latest_for("p1") is first


def test_completed_proposal_must_be_resolved_before_another_starts(temp_project):
    add_paper(temp_project, "p1", "Paper One")
    notes_jobs.save("p1", "## Notes\n\nOriginal.")
    first = notes_jobs.start_edit(
        "p1",
        "first revision",
        runner=_sync_runner([{"type": "final", "text": "## Notes\n\nFirst proposal."}]),
    )
    assert _wait_until_settled(first.id).status == "done"

    with pytest.raises(notes_jobs.NotesError, match="apply, or discard"):
        notes_jobs.start_edit(
            "p1",
            "second revision",
            runner=_sync_runner([{"type": "final", "text": "## Notes\n\nSecond proposal."}]),
        )

    assert notes_jobs.latest_for("p1") is first


def test_relocation_pass_rejects_an_existing_running_proposal(temp_project):
    release = threading.Event()

    def slow(target, prompt):
        release.wait(5)
        yield {"type": "final", "text": "# Working notes\n\nFirst proposal."}

    first = notes_jobs.start_split_destination(
        [{"slug": "p1", "title": "Paper One", "notes": "## Notes\n\nFirst."}],
        source_name="Source",
        runner=slow,
    )
    try:
        with pytest.raises(notes_jobs.NotesError, match="already running"):
            notes_jobs.start_split_destination(
                [{"slug": "p2", "title": "Paper Two", "notes": "## Notes\n\nSecond."}],
                source_name="Another source",
                runner=_sync_runner([]),
            )
    finally:
        release.set()
    assert _wait_until_settled(first.id).status == "done"


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


def test_split_destination_drafts_from_committed_notes_when_working_notes_are_empty(
    temp_project,
):
    captured = {}

    def runner(target, prompt):
        captured["target"] = target
        captured["prompt"] = prompt
        yield {"type": "final", "text": "# Working notes\n\nA grounded synthesis."}

    job = notes_jobs.start_split_destination(
        [
            {"slug": "awq", "title": "AWQ", "notes": "## Notes\n\nFour-bit weights work."},
            {"slug": "unread", "title": "Unread", "notes": ""},
        ],
        source_name="Inference",
        runner=runner,
    )
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.kind == "split_destination"
    assert finished.base_revision == notes_jobs.revision(notes_jobs.WORKING)
    assert "AWQ (slug: awq)" in captured["prompt"]
    assert "Four-bit weights work" in captured["prompt"]
    assert "Unread" not in captured["prompt"]
    assert notes_jobs.read(notes_jobs.WORKING) == ""  # proposal only


def test_split_destination_receives_full_paper_and_discussion_context(temp_project):
    add_paper(temp_project, "awq", "Activation-aware Weight Quantization")
    sessions.start_session("awq", "Activation-aware Weight Quantization")
    sessions.record_user("awq", "How does the calibration set affect the result?")
    sessions._append_record("awq", {
        "role": "assistant",
        "canonical": "It identifies salient activation channels before quantization.",
    })
    captured = {}

    def runner(target, prompt):
        captured["prompt"] = prompt
        yield {"type": "final", "text": "# Working notes\n\nGrounded integration."}

    job = notes_jobs.start_split_destination(
        [{"slug": "awq", "title": "AWQ", "notes": "## Notes\n\nFour-bit weights work."}],
        source_name="Inference",
        runner=runner,
    )
    assert _wait_until_settled(job.id).status == "done"
    assert "### Full paper text\nfull text" in captured["prompt"]
    assert "How does the calibration set affect the result?" in captured["prompt"]
    assert "It identifies salient activation channels" in captured["prompt"]


def test_relocation_notes_integrate_and_commit_one_paper_at_a_time(temp_project):
    from app.routers.notes import NotesSaveReq, save_notes

    prompts_seen = []

    def runner(target, prompt):
        prompts_seen.append(prompt)
        if "SmoothQuant (slug: smooth)" in prompt:
            yield {
                "type": "final",
                "text": "# Working notes\n\nAWQ is integrated.\n\nSmoothQuant is integrated.",
            }
        else:
            yield {"type": "final", "text": "# Working notes\n\nAWQ is integrated."}

    first = notes_jobs.start_split_destination_queue(
        [
            {"slug": "awq", "title": "AWQ", "notes": "## Notes\n\nFour-bit weights work."},
            {
                "slug": "smooth",
                "title": "SmoothQuant",
                "notes": "## Notes\n\nActivation smoothing helps.",
            },
        ],
        source_name="Inference",
        runner=runner,
    )
    first = _wait_until_settled(first.id)
    assert (first.relocation_index, first.relocation_total, first.relocation_title) == (
        1, 2, "AWQ",
    )
    assert "SmoothQuant (slug: smooth)" not in prompts_seen[0]

    applied_first = save_notes(
        notes_jobs.WORKING,
        NotesSaveReq(
            markdown=first.result or "",
            summary=first.summary,
            base_revision=first.base_revision,
            job_id=first.id,
        ),
    )
    assert "AWQ is integrated." in notes_jobs.read(notes_jobs.WORKING)
    assert applied_first["next_job"]["relocation_index"] == 2

    second = _wait_until_settled(applied_first["next_job"]["id"])
    assert (second.relocation_index, second.relocation_total, second.relocation_title) == (
        2, 2, "SmoothQuant",
    )
    # The second pass is grounded in both the newly committed first integration and only the
    # second paper's committed Notes.
    assert "AWQ is integrated." in prompts_seen[1]
    assert "Activation smoothing helps." in prompts_seen[1]

    applied_second = save_notes(
        notes_jobs.WORKING,
        NotesSaveReq(
            markdown=second.result or "",
            summary=second.summary,
            base_revision=second.base_revision,
            job_id=second.id,
        ),
    )
    assert applied_second["next_job"] is None
    assert notes_jobs.latest_for(notes_jobs.WORKING) is None
    assert "SmoothQuant is integrated." in notes_jobs.read(notes_jobs.WORKING)


def test_split_source_cleanup_is_grounded_in_departed_notes(temp_project):
    notes_jobs.save(
        notes_jobs.WORKING,
        "# Working notes\n\nAWQ supports fast four-bit inference. Core remains relevant.",
    )
    captured = {}

    def runner(target, prompt):
        captured["prompt"] = prompt
        yield {"type": "final", "text": "# Working notes\n\nCore remains relevant."}

    job = notes_jobs.start_split_source_cleanup(
        [{"slug": "awq", "title": "AWQ", "notes": "## Notes\n\nFour-bit inference."}],
        destination_name="Quantization",
        runner=runner,
    )
    finished = _wait_until_settled(job.id)

    assert finished.kind == "split_source_cleanup"
    assert "If a passage cannot be confidently tied" in captured["prompt"]
    assert "Four-bit inference" in captured["prompt"]
    assert "AWQ supports" in notes_jobs.read(notes_jobs.WORKING)  # still unmodified


def test_stale_notes_proposal_cannot_overwrite_a_newer_document(temp_project):
    from app.routers.notes import NotesSaveReq, save_notes

    notes_jobs.save(notes_jobs.WORKING, "# Working notes\n\nOriginal.")
    job = notes_jobs.start_edit(
        notes_jobs.WORKING,
        "revise",
        runner=_sync_runner([{"type": "final", "text": "# Working notes\n\nProposal."}]),
    )
    finished = _wait_until_settled(job.id)
    notes_jobs.save(notes_jobs.WORKING, "# Working notes\n\nNewer human edit.")

    with pytest.raises(HTTPException) as exc:
        save_notes(
            notes_jobs.WORKING,
            NotesSaveReq(
                markdown=finished.result or "",
                base_revision=finished.base_revision,
                job_id=finished.id,
            ),
        )
    assert exc.value.status_code == 409
    assert "Newer human edit" in notes_jobs.read(notes_jobs.WORKING)
    assert notes_jobs.latest_for(notes_jobs.WORKING) is finished


def test_applying_a_proposal_discards_it_from_latest(temp_project):
    from app.routers.notes import NotesSaveReq, save_notes

    notes_jobs.save(notes_jobs.WORKING, "# Working notes\n\nOriginal.")
    job = notes_jobs.start_edit(
        notes_jobs.WORKING,
        "revise",
        runner=_sync_runner([{"type": "final", "text": "# Working notes\n\nApplied."}]),
    )
    finished = _wait_until_settled(job.id)

    save_notes(
        notes_jobs.WORKING,
        NotesSaveReq(
            markdown=finished.result or "",
            summary=finished.summary,
            base_revision=finished.base_revision,
            job_id=finished.id,
        ),
    )

    assert "Applied." in notes_jobs.read(notes_jobs.WORKING)
    assert notes_jobs.latest_for(notes_jobs.WORKING) is None


def test_legacy_apply_without_job_id_discards_an_exact_matching_proposal(temp_project):
    from app.routers.notes import NotesSaveReq, save_notes

    notes_jobs.save(notes_jobs.WORKING, "# Working notes\n\nOriginal.")
    first = notes_jobs.start_edit(
        notes_jobs.WORKING,
        "revise",
        runner=_sync_runner([{"type": "final", "text": "# Working notes\n\nApplied."}]),
    )
    finished = _wait_until_settled(first.id)

    # The pre-R8.3 mobile save contract sent only markdown + summary.
    save_notes(
        notes_jobs.WORKING,
        NotesSaveReq(markdown=finished.result or "", summary="Legacy apply"),
    )

    assert notes_jobs.latest_for(notes_jobs.WORKING) is None
    second = notes_jobs.start_edit(
        notes_jobs.WORKING,
        "revise again",
        runner=_sync_runner([{"type": "final", "text": "# Working notes\n\nNext."}]),
    )
    assert second.id != first.id
    assert _wait_until_settled(second.id).status == "done"


def test_default_notes_editor_includes_math_contract(monkeypatch):
    captured = {}
    monkeypatch.setattr(notes_jobs.agent_harness, "AGENTIC_ENABLED", False)
    monkeypatch.setattr(notes_jobs.prompts, "get", lambda key: "custom notes editor")

    def fake_stream(messages, **kwargs):
        captured["messages"] = messages
        yield "revised notes"

    monkeypatch.setattr(notes_jobs.agent, "stream_messages", fake_stream)
    events = list(notes_jobs._default_events("working", "edit prompt"))

    assert notes_jobs.agent.MATH_MARKDOWN_CONTRACT in captured["messages"][0]["content"]
    assert events[-1] == {"type": "final", "text": "revised notes"}

# ---- DR-043: notes proposal from the discussion, any time ----

def _discussed_paper(temp_project, slug="p1"):
    add_paper(temp_project, slug, "Paper One", full_text="text")
    sessions.start_session(slug, "Paper One")
    sessions.record_user(slug, "What is the key finding?", kind="reply")
    # Assistant records go through record_assistant(Turn); appending the record directly keeps
    # this seed independent of the Turn machinery — read_records is the consumer under test.
    sessions._append_record(slug, {
        "role": "assistant", "text": "The key finding is X improves Y by 40%.",
    })
    return slug


def test_discussion_update_drafts_notes_that_do_not_exist_yet(temp_project):
    """Mid-paper is exactly when committed notes usually don't exist — unlike start_edit,
    the discussion update drafts rather than refusing."""
    slug = _discussed_paper(temp_project)
    job = notes_jobs.start_discussion_update(
        slug, runner=_sync_runner([{"type": "final", "text": "## Notes\nX improves Y."}]))
    finished = _wait_until_settled(job.id)
    assert finished.status == "done"
    assert finished.result == "## Notes\nX improves Y."
    # Invariant 4: a proposal only — nothing on disk until save().
    assert notes_jobs.read(slug).strip() == ""


def test_discussion_update_prompt_carries_the_discussion_and_current_notes(temp_project):
    slug = _discussed_paper(temp_project)
    notes_jobs.save(slug, "## Notes\nEarlier committed point.")
    prompts_seen = []

    def runner(target, prompt):
        prompts_seen.append(prompt)
        return iter([{"type": "final", "text": "## Notes\nMerged."}])

    _wait_until_settled(notes_jobs.start_discussion_update(slug, runner=runner).id)
    assert "X improves Y by 40%" in prompts_seen[0]          # the discussion reached the model
    assert "Earlier committed point." in prompts_seen[0]     # so did the committed notes
    assert "ONLY the supplied discussion" in prompts_seen[0]  # and the grounding constraint


def test_discussion_update_refuses_working_target_and_empty_discussions(temp_project):
    add_paper(temp_project, "quiet", "Quiet Paper", full_text="t")
    with pytest.raises(notes_jobs.NotesError):
        notes_jobs.start_discussion_update("working")
    with pytest.raises(notes_jobs.NotesError):
        notes_jobs.start_discussion_update("quiet")   # no discussion yet


def test_the_analyst_tool_starts_the_proposal_in_its_own_thread(temp_project, monkeypatch):
    """The propose_notes_update tool passes no thread: the ambient thread contextvar names the
    conversation it was called from, which is what must reach the notes job. The tool is found
    through the AGENT'S registered toolset — asserting on a module-level list would stay green
    with the registration deleted."""
    from app import agent_harness
    from pydantic_ai.models.test import TestModel

    slug = _discussed_paper(temp_project)
    calls = []

    def capture(target, thread_id=None, runner=None):
        calls.append((target, sessions.active_thread_id()))
        return notes_jobs.NotesJob(id="fake", target=target)

    monkeypatch.setattr(notes_jobs, "start_discussion_update", capture)

    ag = agent_harness.build_agent(slug, model=TestModel())
    fn = None
    for toolset in getattr(ag, "toolsets", []):
        for name, tool in (getattr(toolset, "tools", {}) or {}).items():
            if "propose_notes_update" in str(name):
                fn = getattr(tool, "function", None)
    assert fn is not None, "propose_notes_update is not registered on the session agent"

    # Call the closure inside a bound side thread, as the tool threadpool would (Pydantic AI
    # copies context into its executor).
    with sessions.thread_scope("side-1"):
        out = fn(reason="capture the 40% result")
    assert calls == [(slug, "side-1")]
    assert "review" in out.lower() or "approval" in out.lower()

