"""Operator-only configuration routes.

The system prompts drive every analysis turn, so a user who can rewrite them can steer other
people's reading — and on a shared instance that is a prompt-injection primitive (P0-3). Product
decision 2026-07-25: prompt editing belongs to the operator, not to users.

The gate fails closed. `RC_OPERATOR_USERS` unset means NOBODY is an operator, so a deploy that
forgets to name one gets prompts nobody can edit rather than prompts anyone can.
"""
from __future__ import annotations

import pytest
from app import auth
from app.routers import settings as settings_router
from fastapi import HTTPException


class _Request:
    def __init__(self, user=None):
        self.state = type("S", (), {"user": user})()


@pytest.fixture(autouse=True)
def _non_dev(monkeypatch):
    """Default these tests to a NON-dev environment. In dev the gate deliberately allows everyone
    (local prompt editing must keep working), so testing it in dev would prove nothing."""
    monkeypatch.setenv("RC_ENV", "prod")
    monkeypatch.delenv("RC_OPERATOR_USERS", raising=False)


def test_nobody_is_an_operator_when_unset():
    assert auth.operator_users() == frozenset()
    assert auth.is_operator({"user_id": "anyone"}) is False


def test_named_operator_is_allowed(monkeypatch):
    monkeypatch.setenv("RC_OPERATOR_USERS", "b8f19707-4b13-4cbb-834a-93cd6d06f489")
    assert auth.is_operator({"user_id": "b8f19707-4b13-4cbb-834a-93cd6d06f489"}) is True
    assert auth.is_operator({"user_id": "someone-else"}) is False


def test_dev_allows_prompt_editing(monkeypatch):
    """Local development has no authenticated user at all, and editing prompts is a core dev
    workflow — so dev short-circuits. Every other environment requires a match."""
    monkeypatch.setenv("RC_ENV", "dev")
    assert auth.is_operator(None) is True


@pytest.mark.parametrize("user", [None, {}, {"user_id": "stranger"}])
def test_prompt_writes_refused_for_non_operators(user):
    for call in (settings_router.save_prompt, settings_router.reset_prompt):
        with pytest.raises(HTTPException) as exc:
            call(settings_router.PromptReq(key="reading_method", value="x"), _Request(user))
        assert exc.value.status_code == 403


def test_prompt_writes_allowed_for_the_operator(monkeypatch, tmp_path):
    """The gate must let the operator through, or the refusal tests above would be satisfied by a
    route that refuses everyone."""
    monkeypatch.setenv("RC_OPERATOR_USERS", "op-uuid")
    calls = {}
    monkeypatch.setattr(settings_router.prompts, "set_prompt",
                        lambda key, value: calls.update(key=key, value=value))
    monkeypatch.setattr(settings_router.prompts, "get", lambda key: "stored")
    monkeypatch.setattr(settings_router.prompts, "is_overridden", lambda key: True)
    out = settings_router.save_prompt(
        settings_router.PromptReq(key="reading_method", value="new text"),
        _Request({"user_id": "op-uuid"}))
    assert calls == {"key": "reading_method", "value": "new text"}
    assert out["key"] == "reading_method"
