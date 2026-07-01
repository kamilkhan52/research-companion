"""edit_reply: editing an earlier user reply rewrites that turn and drops everything after it,
so the discussion can be regenerated from the edited message. This is the destructive-edit
model (no branch kept) that backs the mobile 'edit message' action."""
from __future__ import annotations

from app import sessions
from app.models import Turn


def _assistant(slug: str, text: str) -> None:
    sessions.record_assistant(slug, Turn(role="assistant", canonical=text, state_signal="in_discussion"))


def test_edit_reply_rewrites_turn_and_truncates_after(temp_project):
    slug = "p"
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "first question", kind="reply")
    _assistant(slug, "first answer")
    sessions.record_user(slug, "second question", kind="reply")
    _assistant(slug, "second answer")

    ok = sessions.edit_reply(slug, 0, "first question, edited")
    assert ok is True

    t = sessions.transcript(slug)
    # Only the edited reply survives; its old answer and everything after are gone.
    assert t == [{"role": "user", "text": "first question, edited"}]
    assert sessions.get_state(slug) == "in_discussion"


def test_edit_reply_indexes_only_reply_turns_not_internal_prompts(temp_project):
    slug = "p"
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "reply zero", kind="reply")
    _assistant(slug, "answer zero")
    sessions.record_user(slug, "internal finish prompt", kind="finish")  # not a "reply"
    _assistant(slug, "draft answer")
    sessions.record_user(slug, "reply one", kind="reply")
    _assistant(slug, "answer one")

    # reply_index 1 must target "reply one" (the 2nd reply), skipping the finish prompt.
    assert sessions.edit_reply(slug, 1, "reply one, edited") is True
    texts = [r["text"] for r in sessions.read_records(slug) if r["role"] == "user"]
    assert texts == ["reply zero", "internal finish prompt", "reply one, edited"]


def test_edit_reply_returns_false_when_index_out_of_range(temp_project):
    slug = "p"
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "only reply", kind="reply")
    _assistant(slug, "only answer")

    assert sessions.edit_reply(slug, 3, "nope") is False
    # Nothing changed.
    assert [r["text"] for r in sessions.read_records(slug) if r["role"] == "user"] == ["only reply"]
