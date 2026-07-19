"""U.14 retry forks: a retry archives the old tail as a branch instead of discarding it, the
selector can switch the live conversation between branches at a fork point, and bookkeeping
never outlives the turns it annotates."""
from __future__ import annotations

import pytest
from app import sessions
from app.models import Turn
from app.routers import session as session_router
from fastapi import HTTPException


def _assistant(slug: str, text: str, *, proposed: bool = False) -> None:
    sessions.record_assistant(slug, Turn(
        role="assistant", canonical=text, state_signal="in_discussion",
        proposed_commit={"summary": "s", "notes_block": "n", "synthesis": "y"} if proposed else None,
    ))


def _seed(slug: str = "p") -> str:
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "question one", kind="reply")
    _assistant(slug, "answer one (v1)")
    return slug


def test_fork_archives_old_response_and_switch_restores_it(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    # The live transcript reset to the user message; the reader sees generation from there.
    assert [r["role"] for r in sessions.read_records(slug)] == ["user"]

    _assistant(slug, "answer one (v2)")
    t = sessions.transcript(slug)
    assert t[-1]["canonical"] == "answer one (v2)"
    assert t[-1]["branch_count"] == 2
    assert t[-1]["branch_active"] == 2

    assert sessions.switch_branch(slug, 0, 1) is True
    t = sessions.transcript(slug)
    assert t[-1]["canonical"] == "answer one (v1)"
    assert t[-1]["branch_active"] == 1
    # And back again — v2 was synced into its slot before switching away.
    assert sessions.switch_branch(slug, 0, 2) is True
    assert sessions.transcript(slug)[-1]["canonical"] == "answer one (v2)"


def test_switch_carries_the_whole_tail_and_state(temp_project):
    slug = _seed()
    sessions.record_user(slug, "question two", kind="reply")
    _assistant(slug, "answer two", proposed=True)
    sessions.set_state(slug, sessions.NOTES_DRAFTED)

    # Fork at the FIRST assistant turn: the archived tail includes question two + its draft.
    sessions.fork_before_assistant(slug, 0)
    assert sessions.get_state(slug) == sessions.IN_DISCUSSION
    _assistant(slug, "fresh take")

    assert sessions.switch_branch(slug, 0, 1) is True
    texts = [r.get("canonical") or r.get("text") for r in sessions.read_records(slug)]
    assert texts == ["question one", "answer one (v1)", "question two", "answer two"]
    # A restored draft brings its state back.
    assert sessions.get_state(slug) == sessions.NOTES_DRAFTED


def test_branchless_turns_expose_no_selector_and_bad_switches_fail(temp_project):
    slug = _seed()
    t = sessions.transcript(slug)
    assert t[-1]["branch_count"] is None
    assert sessions.switch_branch(slug, 0, 2) is False
    assert sessions.switch_branch(slug, 5, 1) is False


def test_repeated_retries_accumulate_ordinals(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    _assistant(slug, "v2")
    sessions.fork_before_assistant(slug, 0)
    _assistant(slug, "v3")
    t = sessions.transcript(slug)
    assert t[-1]["branch_count"] == 3
    assert t[-1]["branch_active"] == 3
    assert sessions.switch_branch(slug, 0, 2) is True
    assert sessions.transcript(slug)[-1]["canonical"] == "v2"


def test_first_response_branches_restore_their_opening_prompt_and_mode(temp_project):
    slug = "opening"
    sessions.start_session(slug, "Paper", opening="Original opening")
    sessions.set_reading_mode(slug, "background")
    _assistant(slug, "original response")

    sessions.fork_before_assistant(
        slug,
        0,
        context={"opening": "Technical opening", "reading_mode": "technical"},
    )
    _assistant(slug, "technical response")
    assert sessions.get_opening(slug) == "Technical opening"
    assert sessions.get_reading_mode(slug) == "technical"

    assert sessions.switch_branch(slug, 0, 1) is True
    assert sessions.get_opening(slug) == "Original opening"
    assert sessions.get_reading_mode(slug) == "background"

    assert sessions.switch_branch(slug, 0, 2) is True
    assert sessions.get_opening(slug) == "Technical opening"
    assert sessions.get_reading_mode(slug) == "technical"


def test_failed_first_response_retry_rolls_back_opening_context(temp_project):
    slug = "opening"
    sessions.start_session(slug, "Paper", opening="Original opening")
    _assistant(slug, "original response")
    sessions.fork_before_assistant(
        slug,
        0,
        context={"opening": "Temporary opening", "reading_mode": "detailed"},
    )

    sessions.rollback_empty_fork(slug)

    assert sessions.get_opening(slug) == "Original opening"
    assert sessions.get_reading_mode(slug) == "balanced"


def test_retry_request_can_change_context_only_for_the_first_response(temp_project):
    slug = "opening"
    sessions.start_session(slug, "Paper", opening="Original opening")
    _assistant(slug, "original response")

    session_router._prep_retry(session_router.RetryReq(
        slug=slug,
        assistant_index=0,
        prompt="Detailed opening",
        mode="detailed",
    ))

    assert sessions.get_opening(slug) == "Detailed opening"
    assert sessions.get_reading_mode(slug) == "detailed"


def test_later_response_retry_rejects_opening_context_changes(temp_project):
    slug = _seed()
    sessions.record_user(slug, "question two", kind="reply")
    _assistant(slug, "answer two")

    with pytest.raises(HTTPException) as exc:
        session_router._prep_retry(session_router.RetryReq(
            slug=slug,
            assistant_index=1,
            prompt="A different opening",
            mode="technical",
        ))

    assert exc.value.status_code == 400
    assert sessions.branch_map(slug) == {}
    assert sessions.transcript(slug)[-1]["canonical"] == "answer two"


def test_edit_and_restart_clear_stale_bookkeeping(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    _assistant(slug, "v2")
    assert sessions.branch_map(slug)
    # Editing the reply drops the assistant turn the fork annotated.
    assert sessions.edit_reply(slug, 0, "question one, sharpened") is True
    assert sessions.branch_map(slug) == {}
    # A fresh session start clears everything.
    sessions.fork_before_assistant(slug, 0)
    sessions.start_session(slug, "Paper P")
    assert sessions.branch_map(slug) == {}


def test_rollback_empty_fork_restores_the_branch_it_left(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    # Generation failed: nothing was recorded on the fresh tail.
    sessions.rollback_empty_fork(slug)
    t = sessions.transcript(slug)
    assert t[-1]["canonical"] == "answer one (v1)"
    # A single remaining branch is not a fork — the selector state dissolves.
    assert sessions.branch_map(slug) == {}


def test_rollback_after_a_real_sibling_keeps_the_fork(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    _assistant(slug, "v2")
    sessions.fork_before_assistant(slug, 0)   # second retry...
    sessions.rollback_empty_fork(slug)        # ...fails empty
    t = sessions.transcript(slug)
    assert t[-1]["canonical"] == "v2"          # restored to the branch the fork left
    assert t[-1]["branch_count"] == 2          # v1 and v2 both still selectable
    assert sessions.switch_branch(slug, 0, 1) is True
    assert sessions.transcript(slug)[-1]["canonical"] == "answer one (v1)"


def test_rollback_is_a_noop_when_the_new_branch_has_content(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    _assistant(slug, "v2")
    sessions.rollback_empty_fork(slug)
    assert sessions.transcript(slug)[-1]["canonical"] == "v2"
    assert sessions.branch_map(slug)[0]["count"] == 2


def test_commit_finalizes_the_chosen_branch(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    _assistant(slug, "v2", proposed=True)
    assert sessions.branch_map(slug)
    sessions.finalize_proposal_for_commit(slug)
    sessions.mark_committed(slug)
    # No selector survives a commit — siblings (which may hold stale drafts) are gone.
    assert sessions.branch_map(slug) == {}
    assert sessions.switch_branch(slug, 0, 1) is False


def test_read_path_rollback_respects_the_grace_window(temp_project):
    slug = _seed()
    sessions.fork_before_assistant(slug, 0)
    # Fresh fork (job about to register): the aged read-path rollback must NOT touch it.
    sessions.rollback_empty_fork(slug, min_age_s=30.0)
    assert [r["role"] for r in sessions.read_records(slug)] == ["user"]
    # An aged orphan (simulated by backdating) IS recovered.
    data = sessions._read_branches(slug)
    data["0"]["forked_at"] = "2020-01-01T00:00:00+00:00"
    sessions._write_branches(slug, data)
    sessions.rollback_empty_fork(slug, min_age_s=30.0)
    assert sessions.transcript(slug)[-1]["canonical"] == "answer one (v1)"


def test_committed_proposal_never_reoffers_approve_after_fork_and_switch(temp_project):
    """Round-8 review path: approve, continue the discussion, retry a later turn, switch back
    to the branch holding the committed proposal — its restore must NOT be notes_drafted."""
    slug = _seed()
    sessions.record_user(slug, "finish", kind="finish")
    _assistant(slug, "the draft", proposed=True)
    sessions.finalize_proposal_for_commit(slug)
    sessions.mark_committed(slug)
    sessions.continue_discussion(slug)

    sessions.record_user(slug, "one more question", kind="reply")
    _assistant(slug, "further answer")
    sessions.fork_before_assistant(slug, 2)   # retry the post-commit answer
    _assistant(slug, "further answer v2")

    assert sessions.switch_branch(slug, 2, 1) is True
    # The committed proposal sits in the restored conversation, but the boundary holds.
    assert sessions.get_state(slug) == sessions.IN_DISCUSSION

    # Even forking at the proposal itself and coming back cannot resurrect Approve.
    sessions.fork_before_assistant(slug, 1)
    _assistant(slug, "replacement draft attempt")
    assert sessions.switch_branch(slug, 1, 1) is True
    assert sessions.get_state(slug) == sessions.IN_DISCUSSION


def test_stale_review_payload_is_refused(temp_project):
    """Round-12 review path: a review screen loads the proposal, a branch switch replaces it,
    the stale explicit payload must be refused; the fresh revision is accepted."""
    import pytest as _pytest
    from app.routers import notes as notes_routes
    from fastapi import HTTPException

    slug = _seed()
    sessions.record_user(slug, "finish", kind="finish")
    _assistant(slug, "draft v1", proposed=True)
    stale_revision = sessions.proposal_revision(slug)
    assert stale_revision

    # The proposal is regenerated (fork + new draft) while the review screen sits open.
    sessions.fork_before_assistant(slug, 1)
    _assistant(slug, "draft v2", proposed=True)
    assert sessions.proposal_revision(slug) != stale_revision

    with _pytest.raises(HTTPException) as err:
        notes_routes.approve(notes_routes.ApproveReq(
            slug=slug, notes_block="stale notes", synthesis="stale synthesis",
            proposal_revision=stale_revision))
    assert err.value.status_code == 409

    # A payload reviewed against the LIVE proposal goes through to the committer.
    result = notes_routes.approve(notes_routes.ApproveReq(
        slug=slug, notes_block="fresh notes", synthesis="fresh synthesis",
        proposal_revision=sessions.proposal_revision(slug)))
    assert result["result"]["committed"] is True
