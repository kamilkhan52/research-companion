"""The guarded outbound fetcher (P0-14).

Every test here is network-free: `socket.getaddrinfo` is faked so no DNS leaves the machine, and
the HTTP layer is an `httpx.MockTransport`. That is not just hygiene — the tests these replace in
test_cover_jobs.py were reaching example.com for real and "passing" because the 404 they got
happened to raise the error they asserted.
"""
from __future__ import annotations

import httpx
import pytest
from app import safe_fetch


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    """Resolve every host to a public address unless a test says otherwise, so assert_public_url
    exercises its logic without DNS. Returns the setter so a test can pin a specific answer."""
    answers: dict[str, str] = {}

    def getaddrinfo(host, port, *a, **k):
        ip = answers.get(host, "93.184.216.34")           # a public address by default
        family = 10 if ":" in ip else 2
        return [(family, 1, 6, "", (ip, port))]

    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo", getaddrinfo)
    return answers


_REAL_CLIENT = httpx.Client       # captured before any test patches safe_fetch.httpx.Client


def _mock_client(handler):
    """Patch safe_fetch's client construction to route through a MockTransport. Builds from the
    captured real class, not `httpx.Client` — by the time the factory runs, that name has been
    rebound to this factory, and calling it would recurse."""
    def factory(**kwargs):
        return _REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs)
    return factory


# ---------------- destination validation ----------------

@pytest.mark.parametrize("ip", [
    "127.0.0.1",            # loopback — including this process's own API
    "169.254.169.254",      # cloud metadata, the classic SSRF target
    "10.0.0.5",             # RFC1918
    "192.168.1.1",
    "::1",
    "fd00::1",
    "0.0.0.0",
    "::ffff:127.0.0.1",     # IPv4-mapped loopback: the enumeration form of this check missed
                            # variants like this depending on how it was written
])
def test_refuses_non_public_addresses(fake_dns, ip):
    fake_dns["evil.example"] = ip
    with pytest.raises(safe_fetch.UnsafeURLError):
        safe_fetch.assert_public_url("https://evil.example/x")


def test_refuses_carrier_grade_nat(fake_dns):
    """100.64.0.0/10 is the regression this check exists for. The previous guard enumerated
    is_private/is_loopback/is_link_local/is_reserved/is_multicast/is_unspecified, none of which
    match 100.64/10 — and that is the Tailscale range, so on a tailnet-joined host (which the dev
    Mac and any tailnet deployment are) those addresses reach real internal peers."""
    fake_dns["tailnet.example"] = "100.83.161.127"
    with pytest.raises(safe_fetch.UnsafeURLError, match="non-public"):
        safe_fetch.assert_public_url("https://tailnet.example/x")


def test_allows_a_public_address():
    safe_fetch.assert_public_url("https://arxiv.org/pdf/2201.11705")   # must not raise


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
    "data:text/plain,hi",
])
def test_refuses_non_http_schemes(url):
    with pytest.raises(safe_fetch.UnsafeURLError, match="http"):
        safe_fetch.assert_public_url(url)


def test_refuses_url_without_host():
    with pytest.raises(safe_fetch.UnsafeURLError):
        safe_fetch.assert_public_url("http:///nohost")


def test_refuses_unresolvable_host(monkeypatch):
    import socket as _socket
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda *a, **k: (_ for _ in ()).throw(_socket.gaierror("nope")))
    with pytest.raises(safe_fetch.UnsafeURLError, match="could not resolve"):
        safe_fetch.assert_public_url("https://nx.example/x")


def test_checks_every_resolved_address(monkeypatch):
    """A host answering with one public and one private address must be refused: we do not choose
    which address the connection uses, so 'one of them is fine' is not good enough."""
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo", lambda host, port, *a, **k: [
        (2, 1, 6, "", ("93.184.216.34", port)),
        (2, 1, 6, "", ("127.0.0.1", port)),
    ])
    with pytest.raises(safe_fetch.UnsafeURLError):
        safe_fetch.assert_public_url("https://split.example/x")


# ---------------- redirect handling ----------------

def test_follows_redirects_and_returns_final_url(monkeypatch):
    def handler(request):
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "https://example.com/final"})
        return httpx.Response(200, content=b"body", headers={"content-type": "text/plain"})

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    r = safe_fetch.fetch("https://example.com/start", max_bytes=1000)
    assert r.content == b"body"
    assert r.url == "https://example.com/final"


def test_redirect_to_private_address_is_refused(fake_dns, monkeypatch):
    """THE hole this module exists to close. The first URL is public and passes; the redirect
    target is cloud metadata. Following redirects inside httpx made this invisible."""
    fake_dns["metadata.evil"] = "169.254.169.254"

    def handler(request):
        return httpx.Response(302, headers={"location": "http://metadata.evil/latest/meta-data/"})

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    with pytest.raises(safe_fetch.UnsafeURLError, match="non-public"):
        safe_fetch.fetch("https://public.example/start", max_bytes=1000)


def test_relative_redirect_is_resolved_against_the_current_hop(monkeypatch):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.path == "/a/start":
            return httpx.Response(302, headers={"location": "../b/final"})
        return httpx.Response(200, content=b"ok", headers={"content-type": "text/plain"})

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    r = safe_fetch.fetch("https://example.com/a/start", max_bytes=1000)
    assert r.url == "https://example.com/b/final"
    assert seen == ["https://example.com/a/start", "https://example.com/b/final"]


def test_redirect_loop_is_bounded(monkeypatch):
    def handler(request):
        return httpx.Response(302, headers={"location": "https://example.com/loop"})

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    with pytest.raises(safe_fetch.UnsafeURLError, match="redirects"):
        safe_fetch.fetch("https://example.com/loop", max_bytes=1000)


def test_redirect_without_location_is_refused(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client",
                        _mock_client(lambda request: httpx.Response(302)))
    with pytest.raises(safe_fetch.UnsafeURLError, match="Location"):
        safe_fetch.fetch("https://example.com/x", max_bytes=1000)


# ---------------- size ceiling ----------------

def test_rejects_oversized_declared_length(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(200, content=b"x" * 10,
                                       headers={"content-length": "999999"})))
    with pytest.raises(safe_fetch.FetchTooLargeError, match="declares"):
        safe_fetch.fetch("https://example.com/big", max_bytes=100)


def test_rejects_body_that_exceeds_ceiling_despite_lying_header(monkeypatch):
    """A hostile server can simply omit or understate Content-Length, so the ceiling has to be
    enforced against bytes actually read — that is the check that prevents the OOM."""
    def handler(request):
        return httpx.Response(200, stream=httpx.ByteStream(b"x" * 5000))

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    with pytest.raises(safe_fetch.FetchTooLargeError, match="exceeds"):
        safe_fetch.fetch("https://example.com/lying", max_bytes=100)


def test_accepts_a_body_at_the_ceiling(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(200, content=b"x" * 100)))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100).content == b"x" * 100


# ---------------- response surface ----------------

def test_http_error_status_raises(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client",
                        _mock_client(lambda request: httpx.Response(404)))
    with pytest.raises(httpx.HTTPStatusError):
        safe_fetch.fetch("https://example.com/missing", max_bytes=100)


def test_text_decodes_with_declared_charset(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(
            200, content="héllo".encode("latin-1"),
            headers={"content-type": "text/html; charset=latin-1"})))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100).text == "héllo"


def test_text_survives_a_bogus_charset(monkeypatch):
    """Content-Type is attacker-controlled; an unknown charset must not raise LookupError out of
    a fetch the caller only wanted text from."""
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(200, content=b"hello",
                                       headers={"content-type": "text/html; charset=not-a-codec"})))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100).text == "hello"
