"""The public legal pages, and the two properties Play actually checks.

Google's User Data policy requires the privacy-policy URL to be public and globally accessible, and
the account-deletion resource to be reachable without installing the app. Both mean *without
signing in* — so the test that matters is that these paths answer while authentication is on and
rejecting everything. A reviewer hitting a 401 or a 500 on one of these is a rejection, and a slow
one.
"""
from __future__ import annotations

import re

import pytest
from app import auth
from app.routers import legal
from starlette.testclient import TestClient

PATHS = ["/legal/privacy", "/legal/terms", "/legal/delete-account"]


def _reject(_token):
    raise auth.AuthError("no")


@pytest.fixture
def locked_client(monkeypatch):
    """Auth on, and refusing every credential — the state a Play reviewer arrives in."""
    from app.main import app

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "check", _reject)
    return TestClient(app)


@pytest.mark.parametrize("path", PATHS)
def test_page_is_public_while_auth_rejects_everything(locked_client, path):
    response = locked_client.get(path)

    assert response.status_code == 200
    # "not a PDF" is an explicit Play requirement, so assert the type rather than just the status.
    assert response.headers["content-type"].startswith("text/html")
    assert len(response.text) > 2000


@pytest.mark.parametrize("path", PATHS)
def test_no_placeholder_survives_into_a_served_page(locked_client, path):
    """`_load` fills `{{...}}` by name. A renamed or misspelled placeholder would otherwise ship
    verbatim onto a page whose whole purpose is to be read by a regulator."""
    assert "{{" not in locked_client.get(path).text


@pytest.mark.parametrize("path", PATHS)
def test_every_page_carries_the_privacy_contact(locked_client, path):
    """Play's User Data policy requires a privacy contact on the policy itself; the other two pages
    are useless without one for the same reason."""
    assert legal.SUPPORT_EMAIL in locked_client.get(path).text


def test_internal_links_all_resolve(locked_client):
    """Every `/`-rooted link on these pages must answer 200.

    This is the one that catches real breakage: the shared footer links all three documents to each
    other, and a typo there is invisible in review and fatal in a store listing.
    """
    checked = set()
    for path in PATHS:
        for href in re.findall(r'href="(/[^"]*)"', locked_client.get(path).text):
            checked.add(href)
            assert locked_client.get(href).status_code == 200, f"{path} links to a dead {href}"
    # Vacuity guard: a page whose links stopped being emitted would pass the loop above trivially.
    assert checked >= set(PATHS)


def test_deletion_page_gives_both_routes(locked_client):
    """Play requires the web resource to explain how to *request* deletion. The in-app path alone
    does not satisfy it — the page has to work for someone who no longer has the app."""
    body = locked_client.get("/legal/delete-account").text

    assert "Settings" in body and "Delete account" in body
    assert f"mailto:{legal.SUPPORT_EMAIL}" in body
    # And it must say what survives, which is a separate policy requirement from how to ask.
    assert "What is kept" in body
