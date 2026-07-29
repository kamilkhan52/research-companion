"""The public, unauthenticated pages Google Play requires to exist outside the app.

Three documents, three requirements:

- **Privacy policy** (`/legal/privacy`) — Play's User Data policy requires a URL that is public,
  globally accessible, non-editable, and *not a PDF*, identifying the app and developer and
  describing access, collection, use, sharing, security, retention, deletion, and a privacy
  contact.
- **Terms** (`/legal/terms`) — not itself a Play requirement, but the policy references the licence
  the reader grants us to process their content, and a subscription cannot be sold without terms.
- **Account deletion** (`/legal/delete-account`) — Play requires a web resource, reachable WITHOUT
  installing the app, where a reader can request deletion and read what is removed and what is
  kept. The in-app path exists too; the policy demands both.

**Why these are served by the backend rather than hosted somewhere.** The Fly app already has a
TLS-terminated public origin, and a policy URL that outlives the product is worth more than one
tied to a hosting account that lapses. It also means the page and the code it describes ship in the
same commit — the inventory in `docs/production/02-security-and-privacy.md` has a maintenance rule
requiring it to be updated in the same PR as any data change, and a policy in the same repository
is the only version of that rule anyone will actually follow.

These routes are public by construction, not by exemption: `main`'s auth middleware only guards
paths under `/api/`, so nothing here needs to be added to `_AUTH_EXEMPT`. They are registered
BEFORE the SPA mount in `main`, which otherwise catches `/`-rooted paths.

The page bodies are static HTML fragments under `app/legal/`, read ONCE at import. A missing or
unreadable file therefore fails at boot, where CI catches it, rather than serving a 500 to a Play
reviewer opening the privacy URL — which is a rejection, and a slow one.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

# The public identity of the product. `SUPPORT_EMAIL` is the privacy contact Play's User Data
# policy requires and the support address on the store listing; it is deliberately not a personal
# address, and deliberately not configurable by environment — a policy document whose contact
# details vary by deployment is not a policy document.
APP_NAME = "Scholiast"
DEVELOPER = "Kamil Khan"
SUPPORT_EMAIL = "thelocalscientist@gmail.com"
LAST_UPDATED = "28 July 2026"

_PAGES_DIR = Path(__file__).resolve().parent.parent / "legal"

_TITLES = {
    "privacy": "Privacy Policy",
    "terms": "Terms of Service",
    "delete-account": "Delete your account",
}

_STYLE = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 5rem;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #16181d; background: #fbfbfa;
}
main { max-width: 42rem; margin: 0 auto; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 .25rem; letter-spacing: -0.01em; }
h2 { font-size: 1.15rem; margin: 2.25rem 0 .6rem; letter-spacing: -0.005em; }
h3 { font-size: 1rem; margin: 1.5rem 0 .4rem; }
p, li { margin: 0 0 .85rem; }
ul { padding-left: 1.25rem; }
a { color: #2f5fd0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
.updated { color: #6b7280; font-size: .875rem; margin: 0 0 2rem; }
.nav { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid #e3e3e0; font-size: .875rem; }
.nav a { margin-right: 1.25rem; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1.25rem; font-size: .9rem; }
th, td { text-align: left; vertical-align: top; padding: .5rem .6rem; border-bottom: 1px solid #e3e3e0; }
th { font-weight: 600; }
.wrap { overflow-x: auto; }
@media (prefers-color-scheme: dark) {
  body { color: #e6e6e3; background: #16181d; }
  a { color: #8ab4ff; }
  .updated { color: #9aa0aa; }
  .nav, th, td { border-color: #2c3038; }
}
"""


def _shell(title: str, body: str) -> str:
    return (
        "<!doctype html><html lang=\"en\"><head>"
        "<meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{title} · {APP_NAME}</title>"
        f"<style>{_STYLE}</style>"
        "</head><body><main>"
        f"<h1>{title}</h1>"
        f"<p class=\"updated\">{APP_NAME} · {DEVELOPER} · Last updated {LAST_UPDATED}</p>"
        f"{body}"
        "<div class=\"nav\">"
        "<a href=\"/legal/privacy\">Privacy</a>"
        "<a href=\"/legal/terms\">Terms</a>"
        "<a href=\"/legal/delete-account\">Delete your account</a>"
        f"<a href=\"mailto:{SUPPORT_EMAIL}\">Contact</a>"
        "</div></main></body></html>"
    )


def _load(slug: str) -> str:
    """Read a fragment and fill the handful of placeholders shared across all three documents."""
    raw = (_PAGES_DIR / f"{slug}.html").read_text(encoding="utf-8")
    return (raw
            .replace("{{APP_NAME}}", APP_NAME)
            .replace("{{DEVELOPER}}", DEVELOPER)
            .replace("{{SUPPORT_EMAIL}}", SUPPORT_EMAIL)
            .replace("{{LAST_UPDATED}}", LAST_UPDATED))


# Rendered at import, so a missing fragment is a boot failure — caught in CI, rather than a 500
# served to whoever opens the policy URL. Note what this does NOT catch: `_load` substitutes four
# known names, so an unknown `{{FOO}}` passes through silently and boots fine. The guard against
# that is behavioural, in `test_legal.py::test_no_placeholder_survives_into_a_served_page`.
_RENDERED = {slug: _shell(title, _load(slug)) for slug, title in _TITLES.items()}


def _page(slug: str) -> HTMLResponse:
    # Cached for an hour: the documents change only on deploy, and a reviewer or a reader following
    # a link from the store should not wait on the app. Not `immutable` — a policy correction has
    # to be able to propagate.
    return HTMLResponse(_RENDERED[slug], headers={"Cache-Control": "public, max-age=3600"})


@router.get("/legal/privacy", include_in_schema=False)
def privacy() -> HTMLResponse:
    return _page("privacy")


@router.get("/legal/terms", include_in_schema=False)
def terms() -> HTMLResponse:
    return _page("terms")


@router.get("/legal/delete-account", include_in_schema=False)
def delete_account() -> HTMLResponse:
    return _page("delete-account")
