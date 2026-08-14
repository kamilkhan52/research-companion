"""chat_jobs: the background-thread chat turn that decouples response generation from any
single HTTP connection. A turn streamed over one live SSE request died with the connection
(confirmed live: the Cloudflare edge canceled a reply_stream ~3 minutes in) and the
un-persisted response vanished from the transcript. This drives a REAL background thread with
injected runners (zero network) and confirms turns finish and are RECORDED to the session no
matter what any client does, items interleave canonical-only text with tool calls, failures
surface as error jobs without touching the session, and concurrent starts join the in-flight
job."""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest
from app import agent, chat_jobs, preview_jobs, sessions
from app.routers import session as session_routes

PROTO = "### CANONICAL ###\nThe answer.\n### STATE ###\nin_discussion\n### END ###"


@pytest.fixture(autouse=True)
def _clear_jobs():
    chat_jobs._jobs.clear()
    preview_jobs._jobs.clear()
    preview_jobs._coordinator_jobs.clear()
    yield
    chat_jobs._jobs.clear()
    preview_jobs._jobs.clear()
    preview_jobs._coordinator_jobs.clear()


def _session_with_reply(slug: str = "p") -> str:
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "a question", kind="reply")
    return slug


def _sync_runner(events):
    return lambda slug, history: iter(events)


def _async_runner(events):
    def make(slug, history):
        async def gen():
            for ev in events:
                yield ev
        return gen()
    return make


def _wait_until_settled(job_id: str, timeout: float = 5.0) -> chat_jobs.ChatJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = chat_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(f"chat job {job_id} did not settle within {timeout}s")


def test_turn_is_recorded_even_if_no_client_ever_polls(temp_project):
    slug = _session_with_reply()
    events = [{"type": "text", "text": piece} for piece in (PROTO[:40], PROTO[40:])]
    events.append({"type": "final", "text": PROTO})

    job = chat_jobs.start_turn(slug, runner=_sync_runner(events))
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.turn and finished.turn["canonical"] == "The answer."
    assert finished.state == "in_discussion"
    # The whole point: the turn is in the session file regardless of any client/connection.
    records = sessions.read_records(slug)
    assert records[-1]["role"] == "assistant"
    assert records[-1]["canonical"] == "The answer."


@pytest.mark.parametrize("with_reply", [False, True], ids=["opening", "reply"])
def test_opening_or_reply_cannot_create_an_unsolicited_notes_proposal(
    temp_project,
    with_reply,
):
    slug = _session_with_reply() if with_reply else "p"
    if not with_reply:
        sessions.start_session(slug, "Paper P")
    drifted = """###CANONICAL###
Opening analysis.
###STATE###
ready_to_draft_notes
###COMMIT_SUMMARY###
Drafted notes.
###NOTES_BLOCK###
## Notes
Unrequested.
###SYNTHESIS###
Unrequested synthesis.
###END###"""

    job = chat_jobs.start_turn(
        slug,
        runner=_sync_runner([{"type": "final", "text": drifted}]),
    )
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.turn["proposed_commit"] is None
    assert finished.state == "in_discussion"
    assert sessions.read_records(slug)[-1]["proposed_commit"] is None


def _fake_editor(monkeypatch, plan="Plan: fold in the 40% result.",
                 synthesis="## Project Notes\nEdited by the second pass."):
    calls = []

    def fake(*, project_name, goals, current_synthesis, paper_title, notes_block, model=None):
        calls.append({"project_name": project_name, "current": current_synthesis,
                      "title": paper_title, "notes_block": notes_block})
        return plan, synthesis

    monkeypatch.setattr(chat_jobs.agent, "edit_synthesis", fake)
    return calls


def test_finish_turn_runs_the_synthesis_editor_and_overwrites_drift(temp_project, monkeypatch):
    """DR-058: the finish proposal's synthesis comes from the SEPARATE editor pass — including
    when the model drifts and emits a SYNTHESIS section anyway, which must be overwritten or
    the over-weighted single-shot rewrite silently returns."""
    calls = _fake_editor(monkeypatch)
    sessions.start_session("p", "Paper P")
    sessions.record_user("p", "Draft notes now", kind="finish")
    proposed = """###CANONICAL###
Review this draft.
###STATE###
ready_to_draft_notes
###COMMIT_SUMMARY###
Drafted notes.
###NOTES_BLOCK###
## Notes
Requested.
###SYNTHESIS###
Drifted single-shot synthesis that must NOT survive.
###END###"""

    job = chat_jobs.start_turn(
        "p",
        runner=_sync_runner([{"type": "final", "text": proposed}]),
    )
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    commit = finished.turn["proposed_commit"]
    assert commit["notes_block"] == "## Notes\nRequested."
    assert commit["synthesis"] == "## Project Notes\nEdited by the second pass."
    assert commit["plan"] == "Plan: fold in the 40% result."
    assert "Drifted" not in commit["synthesis"]
    assert finished.state == "notes_drafted"
    # The editor saw the paper as its NOTES, not its full text — the whole point.
    assert calls[0]["notes_block"] == "## Notes\nRequested."
    # title_for falls back to the slug for a paper not on the reading list (this seed's case).
    assert calls[0]["title"] == "p"
    # DR-056's second stage covers this pass.
    assert finished.notes_phase == "synthesis"
    # And the recorded transcript carries the edited proposal (what review reads).
    assert sessions.read_records("p")[-1]["proposed_commit"]["plan"].startswith("Plan:")


def test_the_plan_reaches_the_review_payload(temp_project, monkeypatch):
    """The other side of the contract: the client's Change-plan section reads
    `committer.review(slug)["plan"]` — a fixture-only assertion on the mobile side left this
    droppable with the whole backend suite green (the review proved it by revert)."""
    from app import committer

    _fake_editor(monkeypatch, plan="The stated intent.")
    sessions.start_session("p", "Paper P")
    sessions.record_user("p", "Draft notes now", kind="finish")
    proposed = ("###CANONICAL###\nPreview.\n###STATE###\nready_to_draft_notes\n"
                "###COMMIT_SUMMARY###\nS.\n###NOTES_BLOCK###\n## N\nX.\n###END###")
    _wait_until_settled(chat_jobs.start_turn(
        "p", runner=_sync_runner([{"type": "final", "text": proposed}])).id)
    payload = committer.review("p")
    assert payload["plan"] == "The stated intent."
    assert payload["synthesis_proposed"] == "## Project Notes\nEdited by the second pass."


def test_a_revision_turn_stays_single_shot(temp_project, monkeypatch):
    """The reader's feedback addresses the existing proposal as a whole; the editor pass is
    deliberately finish-only (documented in _maybe_edit_synthesis)."""
    calls = _fake_editor(monkeypatch)
    sessions.start_session("p", "Paper P")
    sessions.record_user("p", "please revise", kind="revision",
                         authored_text="More on the ablations.")
    proposed = """###CANONICAL###
Revised.
###STATE###
ready_to_draft_notes
###COMMIT_SUMMARY###
Revised notes.
###NOTES_BLOCK###
## Notes
Revised.
###SYNTHESIS###
Revised synthesis stays.
###END###"""
    finished = _wait_until_settled(chat_jobs.start_turn(
        "p", runner=_sync_runner([{"type": "final", "text": proposed}])).id)
    assert finished.turn["proposed_commit"]["synthesis"] == "Revised synthesis stays."
    assert calls == []


def test_a_failed_editor_fails_the_turn_before_recording(temp_project, monkeypatch):
    """A proposal whose approval would erase the Project Notes must never be recorded; the
    turn errors cleanly and is retryable, like a parse failure."""
    def broken(**kwargs):
        raise chat_jobs.AgentError("The synthesis editor returned no Project Notes document.")

    monkeypatch.setattr(chat_jobs.agent, "edit_synthesis", broken)
    sessions.start_session("p", "Paper P")
    before = len(sessions.read_records("p"))
    sessions.record_user("p", "Draft notes now", kind="finish")
    proposed = ("###CANONICAL###\nPreview.\n###STATE###\nready_to_draft_notes\n"
                "###COMMIT_SUMMARY###\nS.\n###NOTES_BLOCK###\n## N\nX.\n###END###")
    finished = _wait_until_settled(chat_jobs.start_turn(
        "p", runner=_sync_runner([{"type": "final", "text": proposed}])).id)
    assert finished.status == "error"
    assert "synthesis editor" in (finished.error or "")
    # Nothing was recorded past the user's finish request.
    assert len(sessions.read_records("p")) == before + 1


def test_items_interleave_tool_calls_with_canonical_only_text(temp_project):
    slug = _session_with_reply()
    full = "### CANONICAL ###\nPart one. Part two.\n### STATE ###\nin_discussion\n### END ###"
    events = [
        {"type": "text", "text": "### CANONICAL ###\nPart one. "},
        {"type": "tool", "name": "web_search", "detail": "deepspeed inference adoption"},
        {"type": "text", "text": "Part two.\n### STATE ###\nin_discussion\n### END ###"},
        {"type": "final", "text": full},
    ]

    job = chat_jobs.start_turn(slug, runner=_async_runner(events))
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert [it["kind"] for it in finished.items] == ["text", "tool", "text"]
    assert finished.items[1]["name"] == "web_search"
    assert finished.activity == "Searching the literature…"
    # One phrase and no second line: the subtitle that used to restate this in longer words is
    # gone (DR-006), and the ChatJob no longer carries a field for one.
    assert not hasattr(finished, "activity_detail")
    # Only CANONICAL text ever reaches items — never the protocol scaffolding.
    joined = "".join(it["text"] for it in finished.items if it["kind"] == "text")
    assert joined.strip() == "Part one. Part two."
    assert "###" not in joined


def test_first_turn_activity_reflects_available_figures_and_citation_context(
    temp_project,
    monkeypatch,
):
    sessions.start_session("p", "Paper P")
    monkeypatch.setattr(chat_jobs.figures, "manifest_for", lambda slug: {
        "status": "done",
        "figures": [{"number": 1}],
    })
    monkeypatch.setattr(chat_jobs.graph, "project_citers_for", lambda slug: [{"slug": "later"}])

    status = chat_jobs._preparation_activity("p")

    assert status == "Viewing figures…"
    # A phrase, not a sentence: the pending card shows this alone (DR-006).
    assert "." not in status


def test_runner_failure_is_an_error_job_and_session_is_untouched(temp_project):
    slug = _session_with_reply()

    def exploding(slug_, history):
        yield {"type": "text", "text": "### CANONICAL ###\nHalf an ans"}
        raise chat_jobs.AgentError("Agentic stream failed: boom")

    job = chat_jobs.start_turn(slug, runner=lambda s, h: exploding(s, h))
    finished = _wait_until_settled(job.id)

    assert finished.status == "error"
    assert "boom" in (finished.error or "")
    # Partial live text is kept on the job for context, but nothing was recorded.
    assert sessions.read_records(slug)[-1]["role"] == "user"


def _age_last_record(slug: str) -> None:
    """Rewrite the last record's ts to the distant past — the on-disk shape of a turn whose
    worker died long ago (records are plain JSONL; there is no writer API on purpose)."""
    import json as _json

    p = sessions._jsonl(slug)
    records = sessions.read_records(slug)
    records[-1]["ts"] = "2020-01-01T00:00:00+00:00"
    p.write_text("".join(_json.dumps(r) + "\n" for r in records), encoding="utf-8")


def test_unaccounted_turn_surfaces_a_vanished_worker_and_nothing_else(temp_project):
    """DR-083 interim: a user turn with no assistant record, no running job, and enough age
    lands in the session snapshot as `pending_turn`; live turns, answered turns, and freshly
    recorded turns (the record→registry window) do not."""
    slug = _session_with_reply()

    # Fresh record, no job: inside the grace window — NOT reported (a poll can land between
    # record_user and the registry insert).
    assert chat_jobs.unaccounted_turn(slug) is None

    # Age the record past the grace window, the way a real orphan looks after a restart.
    _age_last_record(slug)
    marker = chat_jobs.unaccounted_turn(slug)
    assert marker is not None
    assert marker["kind"] == "reply"
    assert marker["error"] is None  # registry has no memory of it — restart shape

    # A live job for the thread suppresses the marker (clients reattach instead).
    gate = threading.Event()

    def stalled(slug_, history):
        gate.wait(5)
        yield {"type": "text", "text": PROTO}

    job = chat_jobs.start_turn(slug, runner=lambda s, h: stalled(s, h))
    assert chat_jobs.unaccounted_turn(slug) is None
    gate.set()
    _wait_until_settled(job.id)

    # Answered: last record is the assistant — no marker.
    assert sessions.read_records(slug)[-1]["role"] == "assistant"
    assert chat_jobs.unaccounted_turn(slug) is None

    # A worker that died with the registry still alive carries its error into the marker.
    sessions.record_user(slug, "again", kind="finish")
    _age_last_record(slug)

    def exploding(slug_, history):
        raise chat_jobs.AgentError("Agentic stream failed: boom")
        yield  # pragma: no cover

    failed = chat_jobs.start_turn(slug, runner=lambda s, h: exploding(s, h))
    _wait_until_settled(failed.id)
    marker = chat_jobs.unaccounted_turn(slug)
    assert marker is not None
    assert marker["kind"] == "finish"
    assert "boom" in (marker["error"] or "")
    assert marker["stopped"] is False

    # PR #404 review P1: the newest retained job may belong to a PREVIOUS turn (routes record
    # the user turn and then start_turn can refuse on the spend ceiling, leaving no new job).
    # A job older than the record must not have its error pinned to this turn.
    failed.started_at = "2019-01-01T00:00:00+00:00"
    marker = chat_jobs.unaccounted_turn(slug)
    assert marker is not None
    assert marker["error"] is None

    # A cooperative Stop that recorded no partial is the reader's own action — reported as
    # `stopped`, never as a server failure (the full cancel flow is test_chat_job_cancel's;
    # this pins the marker mapping).
    failed.started_at = "2999-01-01T00:00:00+00:00"
    failed.status = "cancelled"
    failed.error = None
    marker = chat_jobs.unaccounted_turn(slug)
    assert marker is not None
    assert marker["stopped"] is True
    assert marker["error"] is None

    # And the snapshot route carries it (the review session avoids reading-list setup).
    sessions.start_session(session_routes.REVIEW_SLUG, session_routes.REVIEW_TITLE,
                           kind="review")
    sessions.record_user(session_routes.REVIEW_SLUG, "review question", kind="reply")
    _age_last_record(session_routes.REVIEW_SLUG)
    snap = session_routes._get_session(session_routes.REVIEW_SLUG, sessions.MAIN_THREAD)
    assert snap["pending_turn"]["kind"] == "reply"


def test_failed_parent_suppresses_blocked_preview_before_publishing_error(
    temp_project, monkeypatch,
):
    slug = _session_with_reply()
    preview_started = threading.Event()
    release_preview = threading.Event()
    synth_calls = []
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {
            "speech_provider": "openai",
            "preview_model": "preview/model",
            "narration_model": "narration/model",
            "tts_model": "tts-model",
            "tts_voice": "voice",
        },
    )
    monkeypatch.setattr(chat_jobs, "PREVIEW_CADENCE_SECONDS", 0)

    def blocked_preview(messages, model):
        preview_started.set()
        release_preview.wait(5)
        return '{"cue":"Grounded cue.","source_sentence_ids":["s0001"]}'

    monkeypatch.setattr(preview_jobs, "_default_generate", blocked_preview)
    monkeypatch.setattr(
        preview_jobs.tts,
        "openai_speech",
        lambda cue: synth_calls.append(cue) or b"mp3",
    )

    def failing_after_preview(slug_, history):
        yield {"type": "text", "text": "### CANONICAL ###\nGrounded cue. "}
        yield {"type": "text", "text": "More analysis is coming"}
        assert preview_started.wait(5)
        raise chat_jobs.AgentError("analysis failed after preview")

    job = chat_jobs.start_turn(
        slug,
        runner=lambda s, h: failing_after_preview(s, h),
        delivery_mode="listening",
    )
    finished = _wait_until_settled(job.id)
    assert finished.status == "error"
    assert finished.preview_job_ids

    release_preview.set()
    deadline = time.time() + 5
    cue_job = None
    while time.time() < deadline:
        cue_job = preview_jobs.get_job(finished.preview_job_ids[0])
        if cue_job and cue_job.status != "running":
            break
        time.sleep(0.02)
    assert cue_job and cue_job.status == "done"
    assert cue_job.suppressed is True
    assert cue_job.url is None
    assert synth_calls == []
    assert sessions.read_records(slug)[-1]["role"] == "user"


def test_agentic_tool_use_becomes_a_grounded_cue_source():
    """A tool call during an agentic listening turn is captured as an `agent_activity` source so
    cues can narrate what the agent is doing (searching, fetching), not just the written prose."""
    job = chat_jobs.ChatJob(id="job-tool", slug="paper", delivery_mode="listening")
    job._preview_enabled = True
    job._tool_activity = []

    chat_jobs._apply(job, {"type": "tool", "name": "web_search",
                           "detail": "transformer scaling laws"}, [], 0)

    assert len(job._tool_activity) == 1
    source = job._tool_activity[0]
    assert source["kind"] == "agent_activity"
    assert source["id"] == "tool0001"
    assert "web search" in source["text"].lower()
    assert "transformer scaling laws" in source["text"]
    # And it lands in the client-visible item stream as a tool row.
    assert job.items[-1] == {"kind": "tool", "name": "web_search",
                             "detail": "transformer scaling laws"}


def test_empty_canonical_is_an_error_not_a_recorded_blank_turn(temp_project):
    slug = _session_with_reply()
    job = chat_jobs.start_turn(slug, runner=_sync_runner([{"type": "final", "text": ""}]))
    finished = _wait_until_settled(job.id)

    assert finished.status == "error"
    assert "empty response" in (finished.error or "")
    assert sessions.read_records(slug)[-1]["role"] == "user"


def test_second_start_for_same_slug_joins_the_running_job(temp_project):
    slug = _session_with_reply()
    release = threading.Event()

    def slow(slug_, history):
        release.wait(5)
        yield {"type": "final", "text": PROTO}

    first = chat_jobs.start_turn(slug, runner=lambda s, h: slow(s, h))
    second = chat_jobs.start_turn(slug, runner=_sync_runner([]))
    assert second is first  # joined, not duplicated
    assert chat_jobs.active_for(slug) is first

    release.set()
    assert _wait_until_settled(first.id).status == "done"
    assert chat_jobs.active_for(slug) is None


def test_snapshot_is_a_plain_dict_safe_for_polling(temp_project):
    slug = _session_with_reply()
    job = chat_jobs.start_turn(slug, runner=_sync_runner([{"type": "final", "text": PROTO}]))
    _wait_until_settled(job.id)

    snap = chat_jobs.snapshot(job.id)
    assert snap and snap["status"] == "done" and snap["slug"] == slug
    assert chat_jobs.snapshot("nope") is None


def test_a_refused_narration_start_carries_the_structured_payload(temp_project, monkeypatch):
    """DR-049's third invisible carrier: the narration continuation's hold is taken on the CHAT
    worker thread, and a refusal there was folded into `audio_error` prose with no structure —
    the AudioJob that would carry it was never created. The turn itself stays `done` (the
    response exists and is readable); only the audio half was refused."""
    from app import quotas

    slug = _session_with_reply()
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {"speech_provider": "openai"},
    )

    def refused_audio(text, billing_project=None, metered=True):
        raise quotas.QuotaExceeded(
            used_nanousd=100, settled_nanousd=100, requested_nanousd=10, limit_nanousd=100)

    monkeypatch.setattr(chat_jobs.audio_jobs, "start_job", refused_audio)
    job = chat_jobs.start_turn(
        slug,
        runner=_sync_runner([{"type": "final", "text": PROTO}]),
        delivery_mode="listening",
    )
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.audio_job_id is None
    assert "usage limit" in (finished.audio_error or "").lower()
    assert finished.audio_refusal["code"] == "quota_exceeded"
    assert finished.audio_refusal["limit_nanousd"] == 100
    # The turn-level refusal field stays empty: the TURN was not refused.
    assert finished.refusal is None


def test_listening_turn_starts_audio_after_recording(temp_project, monkeypatch):
    slug = _session_with_reply()
    captured = {}
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {"speech_provider": "openai"},
    )

    def fake_audio(text, billing_project=None, metered=True):
        assert sessions.read_records(slug)[-1]["role"] == "assistant"
        captured.update(text=text, billing_project=billing_project, metered=metered)
        return SimpleNamespace(id="audio-job")

    monkeypatch.setattr(chat_jobs.audio_jobs, "start_job", fake_audio)
    job = chat_jobs.start_turn(
        slug,
        runner=_sync_runner([{"type": "final", "text": PROTO}]),
        delivery_mode="listening",
    )
    finished = _wait_until_settled(job.id)

    assert finished.audio_job_id == "audio-job"
    assert finished.audio_error is None
    assert finished.assistant_index == 0
    # `metered=False`: this narration continues a turn the account was already admitted for.
    # Charging it again would spend a second concurrency slot on one listening turn, and because
    # this call happens inside the worker the refusal would be swallowed into `audio_error`
    # rather than surfacing as a 429.
    assert captured == {
        "text": "The answer.", "billing_project": temp_project, "metered": False,
    }
    transcript = sessions.transcript(slug)
    assert transcript[-1]["assistant_index"] == 0
    assert transcript[-1]["delivery_mode"] == "listening"
    assert transcript[-1]["chat_job_id"] == finished.id
    assert transcript[-1]["audio_job_id"] == "audio-job"


def test_reading_turn_does_not_start_audio(temp_project, monkeypatch):
    slug = _session_with_reply()
    monkeypatch.setattr(
        chat_jobs.audio_jobs,
        "start_job",
        lambda *args, **kwargs: pytest.fail("reading turn started audio"),
    )
    job = chat_jobs.start_turn(slug, runner=_sync_runner([{"type": "final", "text": PROTO}]))
    assert _wait_until_settled(job.id).audio_job_id is None


def test_listening_turn_starts_grounded_preview_without_blocking_analysis(
    temp_project, monkeypatch,
):
    slug = _session_with_reply()
    captured = {}
    coordinator = {}
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {"speech_provider": "openai", "tts_model": "m", "tts_voice": "v"},
    )
    monkeypatch.setattr(chat_jobs, "PREVIEW_CADENCE_SECONDS", 0)

    monkeypatch.setattr(
        chat_jobs.preview_jobs,
        "research_sources",
        lambda slug: [{"id": "project0001", "text": "Prior work.",
                       "kind": "prior_project_context"}],
    )

    def fake_preview(
        chat_job_id, ordinal, sentences, previous_cue, progress, **history,
    ):
        captured.update(
            chat_job_id=chat_job_id,
            ordinal=ordinal,
            sentences=sentences,
            previous_cue=previous_cue,
            progress=progress,
            history=history,
        )
        return SimpleNamespace(id="preview-job")

    monkeypatch.setattr(chat_jobs.preview_jobs, "start_job", fake_preview)
    monkeypatch.setattr(
        chat_jobs.preview_jobs, "get_job",
        lambda job_id: SimpleNamespace(status="running", cue=None),
    )
    def fake_coordinator(chat_id, audio_id, sources, existing_ids, publish, **kwargs):
        coordinator.update(
            chat_id=chat_id,
            audio_id=audio_id,
            sources=sources,
            existing_ids=existing_ids,
            kwargs=kwargs,
        )
        return SimpleNamespace(id="coordinator-job")

    monkeypatch.setattr(chat_jobs.preview_jobs, "start_coordinator", fake_coordinator)
    monkeypatch.setattr(
        chat_jobs.audio_jobs,
        "start_job",
        lambda *args, **kwargs: SimpleNamespace(id="audio-job"),
    )
    full = ("### CANONICAL ###\nThe first finding is grounded. The second finding is ready. "
            "\n### STATE ###\nin_discussion\n### END ###")
    events = [
        {"type": "text", "text": "### CANONICAL ###\nThe first finding is grounded. "},
        {"type": "text", "text": "The second finding is ready. "},
        {"type": "final", "text": full},
    ]

    job = chat_jobs.start_turn(slug, runner=_sync_runner(events), delivery_mode="listening")
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.preview_job_ids == ["preview-job"]
    assert captured == {
        "chat_job_id": job.id,
        "ordinal": 1,
        "sentences": [
            {"id": "s0001", "text": "The first finding is grounded.",
             "kind": "live_response"},
            {"id": "project0001", "text": "Prior work.",
             "kind": "prior_project_context"},
        ],
        "previous_cue": "",
        "progress": {
            "phase": "analysis",
            "completed_response_sentences": 1,
            "remaining_known": False,
        },
        "history": {"played_cues": [], "generated_cues": []},
    }
    assert coordinator["audio_id"] == "audio-job"
    assert coordinator["existing_ids"] == ["preview-job"]
    assert [source["kind"] for source in coordinator["sources"]] == [
        "live_response", "live_response", "prior_project_context",
    ]
    assert finished.preview_complete is False
    assert finished.preview_coordinator_id == "coordinator-job"


def test_preview_cadence_uses_new_sentences_context_and_previous_cue(monkeypatch):
    job = chat_jobs.ChatJob(id="chat-1", delivery_mode="listening")
    job._preview_enabled = True
    job._preview_last_started = 0.0
    job._preview_next_sentence = 0
    job._preview_context = [
        {"id": "project0001", "text": "Prior work.", "kind": "prior_project_context"}
    ]
    calls = []
    monkeypatch.setattr(chat_jobs, "PREVIEW_CADENCE_SECONDS", 3)
    monkeypatch.setattr(chat_jobs.time, "monotonic", lambda: 20.0 + len(calls) * 3)

    def fake_start(
        chat_job_id, ordinal, sentences, previous_cue, progress, **history,
    ):
        calls.append((chat_job_id, ordinal, sentences, previous_cue, progress, history))
        return SimpleNamespace(id=f"preview-{ordinal}")

    monkeypatch.setattr(chat_jobs.preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(
        chat_jobs.preview_jobs,
        "get_job",
        lambda job_id: SimpleNamespace(status="done", cue=f"spoken {job_id}"),
    )

    chat_jobs._maybe_start_preview(job, "One. fragment")
    chat_jobs._maybe_start_preview(job, "One. Two. fragment")
    chat_jobs._maybe_start_preview(job, "One. Two. Three. fragment")
    chat_jobs._maybe_start_preview(job, "One. Two. Three. Four. fragment")

    assert job.preview_job_ids == ["preview-1", "preview-2", "preview-3", "preview-4"]
    assert calls[0][2] == [
        {"id": "s0001", "text": "One.", "kind": "live_response"},
        {"id": "project0001", "text": "Prior work.", "kind": "prior_project_context"},
    ]
    assert calls[1][2][0] == {"id": "s0002", "text": "Two.", "kind": "live_response"}
    assert calls[1][3] == "spoken preview-1"
    assert calls[1][4]["completed_response_sentences"] == 2
    assert calls[1][5] == {
        "played_cues": [],
        "generated_cues": ["spoken preview-1"],
    }
    assert all(call[0] == "chat-1" for call in calls)


def test_audio_start_failure_does_not_fail_recorded_listening_turn(temp_project, monkeypatch):
    slug = _session_with_reply()
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {"speech_provider": "openai"},
    )
    def fail_audio(*args, **kwargs):
        raise RuntimeError("TTS unavailable")

    monkeypatch.setattr(chat_jobs.audio_jobs, "start_job", fail_audio)
    job = chat_jobs.start_turn(
        slug,
        runner=_sync_runner([{"type": "final", "text": PROTO}]),
        delivery_mode="listening",
    )
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.audio_job_id is None
    assert "TTS unavailable" in (finished.audio_error or "")
    assert sessions.read_records(slug)[-1]["canonical"] == "The answer."
    transcript = sessions.transcript(slug)
    assert transcript[-1]["audio_job_id"] is None
    assert "TTS unavailable" in transcript[-1]["audio_error"]


def test_job_route_passes_listening_delivery_mode(temp_project, monkeypatch):
    slug = _session_with_reply()
    captured = {}

    def fake_start(target, delivery_mode="reading", model=None):
        captured.update(slug=target, delivery_mode=delivery_mode, model=model)
        return SimpleNamespace(id="chat-job")

    monkeypatch.setattr(chat_jobs, "start_turn", fake_start)
    monkeypatch.setattr(chat_jobs, "snapshot", lambda job_id: {"id": job_id})
    response = session_routes.continue_job(
        session_routes.FinishReq(slug=slug, delivery_mode="listening")
    )

    assert response == {"job": {"id": "chat-job"}}
    assert captured["delivery_mode"] == "listening"
    assert captured["model"] is None


def test_job_route_passes_one_shot_model_override(temp_project, monkeypatch):
    """A model chosen for one turn reaches start_turn as a one-shot override — and, per the
    locked product decision, never touches persisted settings (config.save_settings is not
    called anywhere in this path any more)."""
    slug = _session_with_reply()
    captured = {}

    def fake_start(target, delivery_mode="reading", model=None):
        captured.update(slug=target, delivery_mode=delivery_mode, model=model)
        return SimpleNamespace(id="chat-job")

    monkeypatch.setattr(chat_jobs, "start_turn", fake_start)
    monkeypatch.setattr(chat_jobs, "snapshot", lambda job_id: {"id": job_id})

    def fail_save_settings(*args, **kwargs):
        raise AssertionError("must not persist a one-shot model override to settings")

    monkeypatch.setattr(session_routes.config, "save_settings", fail_save_settings)

    response = session_routes.continue_job(
        session_routes.FinishReq(slug=slug, model="anthropic/claude-opus-4-8")
    )

    assert response == {"job": {"id": "chat-job"}}
    assert captured["model"] == "anthropic/claude-opus-4-8"


def test_default_events_threads_model_to_single_shot(monkeypatch):
    """chat_jobs._default_events (the production runner) must pass a model override through
    to agent.stream_tokens rather than relying on the settings default."""
    captured = {}

    def fake_stream_tokens(slug, history, model=None):
        captured["model"] = model
        yield "### CANONICAL ###\nhi\n### END ###"

    monkeypatch.setattr(chat_jobs.agent_harness, "AGENTIC_ENABLED", False)
    monkeypatch.setattr(agent, "stream_tokens", fake_stream_tokens)

    events = list(chat_jobs._default_events("p", [], model="openai/gpt-5"))

    assert captured["model"] == "openai/gpt-5"
    assert events[-1]["type"] == "final"


def test_cross_model_turn_records_the_model_on_the_turn(temp_project):
    """R6.7 — a turn generated by a non-default model carries that model on its record and in
    the UI transcript, so the client can badge cross-model retries."""
    slug = _session_with_reply()
    events = [{"type": "text", "text": PROTO}, {"type": "final", "text": PROTO}]

    job = chat_jobs.start_turn(slug, runner=_sync_runner(events), model="vendor/alt-model")
    _wait_until_settled(job.id)

    assert sessions.read_records(slug)[-1]["model"] == "vendor/alt-model"
    assert sessions.transcript(slug)[-1]["model"] == "vendor/alt-model"


def test_default_model_turn_stays_unlabeled(temp_project):
    """No override (or one equal to the settings default) records no model at all."""
    slug = _session_with_reply()
    events = [{"type": "final", "text": PROTO}]

    job = chat_jobs.start_turn(slug, runner=_sync_runner(events))
    _wait_until_settled(job.id)

    assert "model" not in sessions.read_records(slug)[-1]
    assert sessions.transcript(slug)[-1]["model"] is None


def test_override_label_compares_against_settings_default(monkeypatch):
    monkeypatch.setattr(chat_jobs.config, "load_settings", lambda: {"model": "vendor/default"})
    assert chat_jobs.override_label(None) is None
    assert chat_jobs.override_label("vendor/default") is None
    assert chat_jobs.override_label("vendor/other") == "vendor/other"


# ---- R6.8: segment boundaries — pre-tool commentary never contaminates the answer ----

PREAMBLE = "Let me search for recent work on this."
R68_FULL = "### CANONICAL ###\nThe grounded answer.\n### STATE ###\nin_discussion\n### END ###"


def _r68_events():
    """A realistic agentic run: commentary text, a tool call, a segment boundary (the final
    model request), then the protocol answer."""
    return [
        {"type": "text", "text": PREAMBLE},
        {"type": "tool", "name": "web_search", "detail": "recent related work"},
        {"type": "segment"},
        {"type": "text", "text": R68_FULL},
        {"type": "final", "text": R68_FULL},
    ]


def test_segment_boundary_demotes_commentary_and_keeps_answer_clean(temp_project):
    slug = _session_with_reply()

    job = chat_jobs.start_turn(slug, runner=_async_runner(_r68_events()))
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    # The recorded answer is ONLY the final request's canonical — same text narration uses.
    assert finished.turn["canonical"] == "The grounded answer."
    assert PREAMBLE not in finished.turn["canonical"]
    # The commentary survives as a 'thought' trail item, in order, before the tool call.
    kinds = [it["kind"] for it in finished.items]
    assert kinds == ["thought", "tool", "text"]
    assert finished.items[0]["text"] == PREAMBLE
    joined_text = "".join(it["text"] for it in finished.items if it["kind"] == "text")
    assert joined_text.strip() == "The grounded answer."
    assert finished.activity == "Analyzing results…"


def test_agent_trail_is_persisted_on_the_recorded_turn(temp_project):
    slug = _session_with_reply()

    job = chat_jobs.start_turn(slug, runner=_async_runner(_r68_events()))
    _wait_until_settled(job.id)

    record = sessions.read_records(slug)[-1]
    assert record["agent_trail"] == [
        {"kind": "thought", "text": PREAMBLE},
        {"kind": "tool", "name": "web_search", "detail": "recent related work"},
    ]
    assert sessions.transcript(slug)[-1]["agent_trail"] == record["agent_trail"]


def test_turn_without_activity_records_no_trail(temp_project):
    slug = _session_with_reply()
    events = [{"type": "text", "text": PROTO}, {"type": "final", "text": PROTO}]

    job = chat_jobs.start_turn(slug, runner=_sync_runner(events))
    _wait_until_settled(job.id)

    assert "agent_trail" not in sessions.read_records(slug)[-1]
    assert sessions.transcript(slug)[-1]["agent_trail"] is None


def test_empty_final_falls_back_to_last_segment_text_only(temp_project):
    """A provider whose run.result.output comes back empty must fall back to the LAST
    segment's streamed text — never to earlier commentary."""
    slug = _session_with_reply()
    events = [
        {"type": "text", "text": PREAMBLE},
        {"type": "tool", "name": "web_search", "detail": "x"},
        {"type": "segment"},
        {"type": "text", "text": R68_FULL},
        {"type": "final", "text": ""},
    ]

    job = chat_jobs.start_turn(slug, runner=_async_runner(events))
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.turn["canonical"] == "The grounded answer."

def test_a_finish_shaped_stream_reaches_notes_and_the_editor_owns_synthesis(temp_project):
    """DR-056 × DR-058: production finish streams no longer carry a SYNTHESIS marker (the
    prompt says leave it NONE), so the marker advance legitimately stops at `notes` — the
    `synthesis` stage flips when the editor pass starts, pinned by the editor tests. This
    replaces a test that streamed a marker shape production can no longer produce."""
    slug = _session_with_reply()
    chunks = [
        "###CANONICAL###\nHere is the review preview.",
        "\n###STATE###\nin_discussion\n###COMMIT_SUMMARY###\nNONE.",
        "\n###NOTES_BLOCK###\nNONE",
        "\n###END###",
    ]
    def runner(s2, h):
        for c in chunks:
            yield {"type": "text", "text": c}
        yield {"type": "final", "text": "".join(chunks)}

    finished = _wait_until_settled(chat_jobs.start_turn(slug, runner=runner).id)
    assert finished.notes_phase == "notes"


def test_notes_phase_advances_live_and_forward_only():
    """The phase must move DURING the stream (the client stages the wait from polls), advance
    in section order, and never regress — a SYNTHESIS heading quoted inside later prose must
    not bounce the phase back to notes."""
    job = chat_jobs.ChatJob(id="j", slug="p")
    chat_jobs._advance_notes_phase(job, "###CANONICAL###\npreview text")
    assert job.notes_phase is None
    chat_jobs._advance_notes_phase(job, "###CANONICAL###\npreview\n###NOTES_BLOCK###\n## Notes")
    assert job.notes_phase == "notes"
    chat_jobs._advance_notes_phase(job, "…\n###SYNTHESIS###\nthe Project Notes")
    assert job.notes_phase == "synthesis"
    chat_jobs._advance_notes_phase(job, "…later text\n###NOTES_BLOCK###\nagain")
    assert job.notes_phase == "synthesis"  # forward-only
    # Tolerant of heading drift, like agent._parse — but only a marker ALONE on its line.
    job2 = chat_jobs.ChatJob(id="j2", slug="p")
    chat_jobs._advance_notes_phase(job2, "## NOTES_BLOCK\ncontent")
    assert job2.notes_phase == "notes"
    # Prose ABOUT the sections must not advance anything: the finish preview legitimately
    # says things like "## SYNTHESIS OF RESULTS" while still writing the canonical.
    job3 = chat_jobs.ChatJob(id="j3", slug="p")
    chat_jobs._advance_notes_phase(job3, "## SYNTHESIS OF RESULTS\nThey report gains.")
    chat_jobs._advance_notes_phase(job3, "I emit a ## NOTES_BLOCK section when done.")
    assert job3.notes_phase is None
    # A marker buried deep inside ONE huge delta (single-chunk providers) is still seen.
    job4 = chat_jobs.ChatJob(id="j4", slug="p")
    huge = "###NOTES_BLOCK###\n" + ("x" * 6_000)
    chat_jobs._advance_notes_phase(job4, huge, delta_len=len(huge))
    assert job4.notes_phase == "notes"


def test_a_segment_boundary_restarts_the_phase_with_the_document(temp_project):
    """A segment means the answer starts over — including the single-shot fallback replaying
    the turn — so a phase pinned by pre-tool commentary must not survive it."""
    slug = _session_with_reply()

    def runner(s2, h):
        yield {"type": "text", "text": "thinking…\n###SYNTHESIS###\n(quoted in commentary)"}
        yield {"type": "segment"}
        yield {"type": "text", "text": "###CANONICAL###\nThe real answer."}
        yield {"type": "final",
               "text": "###CANONICAL###\nThe real answer.\n###STATE###\nin_discussion\n###END###"}

    finished = _wait_until_settled(chat_jobs.start_turn(slug, runner=runner).id)
    assert finished.notes_phase is None


def test_an_ordinary_turn_never_gains_a_notes_phase(temp_project):
    slug = _session_with_reply()
    finished = _wait_until_settled(chat_jobs.start_turn(
        slug,
        runner=_sync_runner([{"type": "text", "text": "###CANONICAL###\nJust an answer."},
                             {"type": "final", "text": "###CANONICAL###\nJust an answer.\n###STATE###\nin_discussion\n###END###"}]),
    ).id)
    assert finished.notes_phase is None

