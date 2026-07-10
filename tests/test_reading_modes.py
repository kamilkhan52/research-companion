"""Reading modes + continue-after-commit (polish plan H.2/H.3): a per-session mode layers a
register-tuning block onto the analysis system prompt for every subsequent turn; 'balanced'
is the no-layer default. Committed sessions can reopen their composer without dropping
anything recorded."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app import agent, prompts, sessions
from app.routers import session as session_routes


def _started(slug: str = "p") -> str:
    sessions.start_session(slug, "Paper P")
    return slug


def test_mode_defaults_to_balanced_and_persists(temp_project):
    slug = _started()
    assert sessions.get_reading_mode(slug) == "balanced"
    sessions.set_reading_mode(slug, "technical")
    assert sessions.get_reading_mode(slug) == "technical"
    with pytest.raises(ValueError):
        sessions.set_reading_mode(slug, "casual")


def test_mode_layer_feeds_the_system_prompt(temp_project):
    slug = _started()
    assert agent._mode_layer(slug) == ""  # balanced adds nothing
    sessions.set_reading_mode(slug, "background")
    layer = agent._mode_layer(slug)
    assert prompts.get("reading_mode_background") in layer
    for mode in ("background", "technical", "detailed"):
        assert prompts.get(f"reading_mode_{mode}").strip()  # registry keys all resolve


def test_start_request_sets_the_mode(temp_project):
    # ChatStartReq.mode flows through _prep_chat_start (validated by the Literal type).
    assert "mode" in session_routes.ChatStartReq.model_fields


def test_mode_endpoint_requires_a_session(temp_project):
    with pytest.raises(HTTPException) as e:
        session_routes.session_mode(session_routes.ModeReq(slug="ghost", mode="technical"))
    assert e.value.status_code == 409
    slug = _started()
    out = session_routes.session_mode(session_routes.ModeReq(slug=slug, mode="detailed"))
    assert out == {"mode": "detailed"}


def test_continue_discussion_reopens_committed_without_dropping_records(temp_project):
    slug = _started()
    sessions.record_user(slug, "question", kind="reply")
    sessions.set_state(slug, "committed")
    before = sessions.read_records(slug)

    out = session_routes.continue_discussion(session_routes.FinishReq(slug=slug))
    assert out["state"] == "in_discussion"
    assert sessions.read_records(slug) == before  # nothing dropped, nothing added


def test_continue_discussion_rejects_non_committed_states(temp_project):
    with pytest.raises(HTTPException) as e:
        session_routes.continue_discussion(session_routes.FinishReq(slug="ghost"))
    assert e.value.status_code == 409
    slug = _started()  # in_discussion
    with pytest.raises(HTTPException) as e:
        session_routes.continue_discussion(session_routes.FinishReq(slug=slug))
    assert e.value.status_code == 409
