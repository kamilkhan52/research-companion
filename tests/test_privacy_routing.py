"""`/legal/privacy` promises that paper text is never routed to a provider that retains or trains
on it. That promise is one dict in `llm.PRIVACY_ROUTING`, and it has to be on the wire for BOTH
turn paths — the raw client in `llm.py` and the agentic loop in `agent_harness.py`, which is the
default. A regression on either makes a published legal document false, which is why this is a test
and not a comment.
"""
from __future__ import annotations

import httpx
import pytest
from app import agent_harness, config, llm


def _capture(sent: list[dict]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        import json
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })
    return httpx.MockTransport(handler)


def test_the_routing_payload_is_json_serializable_and_a_fresh_copy():
    """`PRIVACY_ROUTING` is a mapping proxy so nothing can quietly weaken it at runtime — but a
    mapping proxy is NOT JSON-serializable, so putting it straight into a request body raises on
    EVERY llm call in the app. `routing_payload()` exists for that; this pins both halves."""
    import json

    payload = llm.routing_payload()

    assert json.loads(json.dumps({"provider": payload}))["provider"] == dict(llm.PRIVACY_ROUTING)
    with pytest.raises(TypeError):
        json.dumps({"provider": llm.PRIVACY_ROUTING})
    # A fresh copy each call: one request body mutating its own `provider` must not reach the next.
    assert payload is not llm.routing_payload()
    with pytest.raises(TypeError):
        llm.PRIVACY_ROUTING["zdr"] = False


def test_both_keys_are_set_and_neither_alone_would_do():
    """`data_collection: deny` excludes training; `zdr` excludes retention at rest. A provider can
    satisfy one and fail the other, so the policy's wording requires both."""
    assert llm.PRIVACY_ROUTING == {"data_collection": "deny", "zdr": True}


def test_raw_client_sends_the_routing_constraint(monkeypatch):
    sent: list[dict] = []
    transport = _capture(sent)

    real_post = httpx.post

    def post(url, **kw):
        with httpx.Client(transport=transport) as c:
            return c.post(url, **kw)

    monkeypatch.setattr(httpx, "post", post)
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})

    llm.complete([{"role": "user", "content": "hi"}], operation="test")

    assert sent, "no request was captured"
    assert sent[0]["provider"] == llm.PRIVACY_ROUTING
    assert real_post is not httpx.post  # the monkeypatch really took effect


def test_agentic_path_sends_the_routing_constraint(monkeypatch):
    """The default turn path. Pydantic AI builds its own request body, so the constraint has to
    ride in `extra_body`; asserting on the model's settings is what proves it will."""
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})

    model = agent_harness._openrouter_model()

    settings = model.settings or {}
    assert "extra_body" in settings, (
        "the agentic model carries no extra_body, so no routing constraint reaches OpenRouter")
    assert settings["extra_body"].get("provider") == llm.PRIVACY_ROUTING


def test_a_data_policy_404_does_not_read_as_a_missing_model():
    """OpenRouter answers the "no conforming endpoint" case with a 404 — the same status as an
    unknown model. Telling a reader to check the model name would send them to fix the wrong
    thing, so the two must produce different messages."""
    body = '{"error":{"message":"No endpoints found matching your data policy (Zero data retention)"}}'

    assert llm._is_data_policy_refusal(404, body)
    assert not llm._is_data_policy_refusal(404, '{"error":{"message":"No allowed providers"}}')
    assert not llm._is_data_policy_refusal(500, body)

    refused = llm._friendly_http_error(404, "some/model", data_policy=True)
    unknown = llm._friendly_http_error(404, "some/model", data_policy=False)
    assert refused != unknown
    assert "privacy" in refused.lower()
    assert "doesn't recognize" not in refused


def test_qwen_max_is_not_offered():
    """It has no conforming endpoint, so every request for it would 404. Kept as a test because the
    favourites list is edited by hand and the failure is invisible until a user picks it."""
    from app.routers.catalogue import FAVORITE_FAMILIES

    labels = [f["label"] for f in FAVORITE_FAMILIES]
    assert "Qwen Max" not in labels
    assert len(labels) == len(set(labels))


@pytest.mark.parametrize("path", ["/legal/privacy"])
def test_the_policy_actually_makes_the_claim_this_module_defends(path):
    """Guards against the inverse regression: someone relaxes the routing AND quietly edits the
    page, leaving these tests passing over a promise nobody makes any more."""
    from app.main import app
    from starlette.testclient import TestClient

    # Whitespace-normalised: the source wraps prose at 100 columns, so a literal phrase can be
    # split across lines in the file and still read as one sentence on the page.
    body = " ".join(TestClient(app).get(path).text.split())
    assert "do not train on it" in body
    assert "do not retain the content we send" in body
