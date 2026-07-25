"""How `retriever._fetch` chooses between the paced arXiv path and the guarded fetcher.

This exists because the choice used to be `"arxiv.org" in url` — a substring test applied to a
CLIENT-SUPPLIED url (`StartReq.pdf_url`). Appending `#arxiv.org` to any address selected the arXiv
branch, which follows redirects and buffers the whole body with no destination check and no byte
ceiling: the entirety of P0-14, reachable by anyone who could type a fragment.
"""
from __future__ import annotations

import httpx
import pytest
from app import retriever, safe_fetch


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/#arxiv.org",   # the reported bypass
    "http://169.254.169.254/latest/meta-data/?ref=arxiv.org",
    "http://arxiv.org.attacker.example/x.pdf",              # suffix-confusion domain
    "http://notarxiv.org/x.pdf",
    "http://evil.example/arxiv.org/paper.pdf",              # path segment
])
def test_lookalike_urls_do_not_take_the_arxiv_path(url):
    assert retriever._is_arxiv_host(url) is False


@pytest.mark.parametrize("url", [
    "https://arxiv.org/pdf/2201.11705",
    "https://ARXIV.ORG/pdf/2201.11705",       # host comparison is case-insensitive
    "https://export.arxiv.org/api/query",     # subdomain
    "https://arxiv.org./pdf/2201.11705",      # trailing dot: same host, absolute form
])
def test_real_arxiv_urls_take_the_arxiv_path(url):
    assert retriever._is_arxiv_host(url) is True


def test_bypass_url_is_actually_refused_end_to_end(monkeypatch):
    """The routing predicate is the fix, but assert the whole path: the metadata URL must reach the
    guarded fetcher and be refused, not merely 'not be classified as arXiv'."""
    def boom(*a, **k):
        raise AssertionError("client-supplied url reached the unguarded arXiv path")

    monkeypatch.setattr(retriever, "_arxiv_get", boom)
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda host, port, *a, **k: [(2, 1, 6, "", ("169.254.169.254", port))])
    with pytest.raises(retriever.RetrievalError, match="Refusing"):
        retriever._fetch("http://169.254.169.254/latest/meta-data/#arxiv.org")


def test_arxiv_path_still_validates_the_destination(monkeypatch):
    """Routing on the hostname stops an attacker steering an arbitrary address into this branch,
    but not DNS games against arxiv.org itself — so the branch validates too."""
    def boom(*a, **k):
        raise AssertionError("fetched without validating")

    monkeypatch.setattr(retriever, "_arxiv_get", boom)
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda host, port, *a, **k: [(2, 1, 6, "", ("127.0.0.1", port))])
    with pytest.raises(retriever.RetrievalError, match="Refusing"):
        retriever._fetch("https://arxiv.org/pdf/2201.11705")


def test_arxiv_pdf_download_is_byte_capped(monkeypatch):
    """The arXiv branch keeps its own pacing/retry rather than being folded into safe_fetch, so
    assert it still carries the ceiling: the url can be a caller-supplied pdf_url that merely lives
    on an arxiv.org host, and an unbounded buffer there is the same OOM as anywhere else.

    Patched at the HTTP client, not at safe_fetch.fetch — patching the helper would prove only that
    the test can stub a function. This version failed loudly when the transfer moved from a
    hand-rolled stream to safe_fetch (it had stubbed retriever.httpx.stream, which was no longer
    called, so the call went to the real network), which is the behaviour you want from it.
    """
    real_client = httpx.Client

    def client_factory(**kw):
        return real_client(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=httpx.ByteStream(b"x" * 5000))), **kw)

    monkeypatch.setattr(retriever, "_arxiv_pace", lambda: None)
    monkeypatch.setattr(safe_fetch.httpx, "Client", client_factory)
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda host, port, *a, **k: [(2, 1, 6, "", ("93.184.216.34", port))])
    monkeypatch.setattr(retriever, "MAX_PDF_BYTES", 1000)
    with pytest.raises(retriever.RetrievalError, match="too large"):
        retriever._fetch("https://arxiv.org/pdf/2201.11705")


def test_arxiv_redirect_to_a_private_address_is_refused(monkeypatch):
    """arxiv.org/pdf/<id> really does redirect, and an earlier version of _arxiv_get_bytes followed
    redirects inside httpx — so the TARGET was never validated. Going through safe_fetch means each
    hop is checked."""
    real_client = httpx.Client

    def handler(request):
        if request.url.host == "arxiv.org":
            return httpx.Response(302, headers={"location": "http://internal.example/secret"},
                                  stream=httpx.ByteStream(b""))
        return httpx.Response(200, stream=httpx.ByteStream(b"%PDF-secret"))

    def client_factory(**kw):
        return real_client(transport=httpx.MockTransport(handler), **kw)

    def getaddrinfo(host, port, *a, **k):
        ip = "127.0.0.1" if host == "internal.example" else "93.184.216.34"
        return [(2, 1, 6, "", (ip, port))]

    monkeypatch.setattr(retriever, "_arxiv_pace", lambda: None)
    monkeypatch.setattr(safe_fetch.httpx, "Client", client_factory)
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo", getaddrinfo)
    with pytest.raises(retriever.RetrievalError, match="Refusing"):
        retriever._fetch("https://arxiv.org/pdf/2201.11705")


@pytest.mark.parametrize("exc", [
    safe_fetch.UnsafeURLError("non-public"),
    safe_fetch.FetchTooLargeError("too big"),
    safe_fetch.FetchTimeoutError("deadline"),
    safe_fetch.UnsupportedResponseError("content-encoding"),
])
def test_fetch_translates_every_refusal_to_retrieval_error(monkeypatch, exc):
    """No safe_fetch exception may escape retriever untranslated — the routes map RetrievalError to
    HTTP, and anything else reaches the job runner as an unhandled crash. The base-class clause
    covers types added after these call sites were written, which is exactly what makes it worth
    asserting per type."""
    def boom(*a, **k):
        raise exc

    monkeypatch.setattr(safe_fetch, "fetch", boom)
    monkeypatch.setattr(safe_fetch, "assert_public_url", lambda url: None)
    with pytest.raises(retriever.RetrievalError):
        retriever._fetch("https://example.com/paper.pdf")


def test_malformed_redirect_becomes_a_retrieval_error(monkeypatch):
    """The property that actually matters for a malformed redirect target: whatever safe_fetch
    raises, the caller turns it into its own error type rather than letting it reach the job runner
    as an unhandled crash."""
    real_client = httpx.Client

    def client_factory(**kw):
        return real_client(transport=httpx.MockTransport(
            lambda request: httpx.Response(302, headers={"location": "http://[fe80::1/x"},
                                           stream=httpx.ByteStream(b""))), **kw)

    monkeypatch.setattr(safe_fetch.httpx, "Client", client_factory)
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda host, port, *a, **k: [(2, 1, 6, "", ("93.184.216.34", port))])
    with pytest.raises(retriever.RetrievalError):
        retriever._fetch("https://example.com/paper.pdf")
