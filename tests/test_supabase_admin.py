from __future__ import annotations

import json

import httpx
import pytest
from app import auth, supabase_admin

USER_ID = "715ed5db-f090-4b8c-a067-640ecee36aa0"
SECRET = "sb_secret_test-only"


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv(supabase_admin.SECRET_ENV, SECRET)


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_delete_user_sends_the_secret_only_to_the_admin_endpoint():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(200, request=request)

    with _client(handler) as client:
        supabase_admin.delete_user(USER_ID.upper(), client=client)

    assert len(seen) == 1
    request = seen[0]
    assert request.method == "DELETE"
    assert str(request.url) == (
        "https://project.supabase.co/auth/v1/admin/users/"
        "715ed5db-f090-4b8c-a067-640ecee36aa0"
    )
    assert request.headers["authorization"] == f"Bearer {SECRET}"
    assert request.headers["apikey"] == SECRET
    assert json.loads(request.content) == {"should_soft_delete": False}


@pytest.mark.parametrize("status", [200, 204, 404])
def test_delete_user_is_idempotent_for_success_and_missing_identity(status: int):
    with _client(lambda request: httpx.Response(status, request=request)) as client:
        assert supabase_admin.delete_user(USER_ID, client=client) is None


def test_delete_user_refuses_invalid_ids_before_any_request():
    called = False

    def handler(request: httpx.Request):
        nonlocal called
        called = True
        return httpx.Response(200, request=request)

    with _client(handler) as client:
        with pytest.raises(ValueError, match="UUID"):
            supabase_admin.delete_user("../../auth/users", client=client)
    assert called is False


@pytest.mark.parametrize("missing", ["url", "secret"])
def test_delete_user_fails_closed_when_admin_configuration_is_missing(monkeypatch, missing: str):
    if missing == "url":
        monkeypatch.setattr(auth, "SUPABASE_URL", "")
    else:
        monkeypatch.delenv(supabase_admin.SECRET_ENV)

    with pytest.raises(supabase_admin.SupabaseAdminUnavailable) as caught:
        supabase_admin.delete_user(USER_ID)
    assert SECRET not in str(caught.value)


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://project.supabase.co",
        "https://user:password@project.supabase.co",
        "https://project.supabase.co/unexpected",
        "https://project.supabase.co?redirect=elsewhere",
    ],
)
def test_delete_user_refuses_a_non_origin_or_cleartext_auth_url(monkeypatch, bad_url: str):
    monkeypatch.setattr(auth, "SUPABASE_URL", bad_url)
    with pytest.raises(supabase_admin.SupabaseAdminUnavailable, match="HTTPS origin"):
        supabase_admin.delete_user(USER_ID)


def test_delete_user_never_forwards_the_secret_on_redirect():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(
            302, headers={"location": "https://attacker.example/capture"}, request=request)

    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        with pytest.raises(supabase_admin.SupabaseDeleteError) as caught:
            supabase_admin.delete_user(USER_ID, client=client)

    assert caught.value.code == "http:302"
    assert len(seen) == 1
    assert seen[0].url.host == "project.supabase.co"


def test_provider_error_body_and_secret_are_not_exposed():
    body = "private@example.com provider diagnostic"
    with _client(lambda request: httpx.Response(500, text=body, request=request)) as client:
        with pytest.raises(supabase_admin.SupabaseDeleteError) as caught:
            supabase_admin.delete_user(USER_ID, client=client)

    message = str(caught.value)
    assert caught.value.code == "http:500"
    assert body not in message
    assert SECRET not in message


def test_network_error_message_and_secret_are_not_exposed():
    def handler(request: httpx.Request):
        raise httpx.ConnectError(f"could not connect with {SECRET}", request=request)

    with _client(handler) as client:
        with pytest.raises(supabase_admin.SupabaseDeleteError) as caught:
            supabase_admin.delete_user(USER_ID, client=client)

    assert caught.value.code == "network:ConnectError"
    assert SECRET not in str(caught.value)


def test_configured_requires_both_values(monkeypatch):
    assert supabase_admin.configured() is True
    monkeypatch.delenv(supabase_admin.SECRET_ENV)
    assert supabase_admin.configured() is False
    monkeypatch.setenv(supabase_admin.SECRET_ENV, SECRET)
    monkeypatch.setattr(auth, "SUPABASE_URL", "http://project.supabase.co")
    assert supabase_admin.configured() is False


def test_server_secret_never_enters_the_client_auth_config():
    public = auth.public_config()
    assert supabase_admin.SECRET_ENV not in public
    assert SECRET not in str(public)
