"""The guarded outbound fetcher (P0-14).

Every test here is network-free: `socket.getaddrinfo` is faked so no DNS leaves the machine, and
the HTTP layer is an `httpx.MockTransport`. That is not just hygiene — the tests these replace in
test_cover_jobs.py were reaching example.com for real and "passing" because the 404 they got
happened to raise the error they asserted.
"""
from __future__ import annotations

import gzip
import tracemalloc
import zlib

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


def _resp(status: int, body: bytes = b"", **headers: str) -> httpx.Response:
    """A mock response whose body is a real stream.

    Built with `stream=` rather than `content=` on purpose: a Response constructed with `content=`
    is already marked stream-consumed, so `iter_raw()` raises StreamConsumed on it — an artifact of
    the constructor, not of the code under test (a network response always streams). Since
    safe_fetch counts WIRE bytes, the tests have to exercise the real streaming path.
    """
    return httpx.Response(status, stream=httpx.ByteStream(body),
                          headers={k.replace("_", "-"): v for k, v in headers.items()})


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


def test_preserves_a_trailing_dot(monkeypatch):
    """`example.com.` is the absolute name and skips the resolver's search suffixes, so it is a
    different DNS question from `example.com`. httpx connects to the dotted form verbatim, so
    stripping the dot before resolving would validate a name we do not connect to."""
    resolved: list[str] = []
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda host, port, *a, **k: (resolved.append(host),
                                                     [(2, 1, 6, "", ("93.184.216.34", port))])[1])
    safe_fetch.assert_public_url("https://example.com./x")
    assert resolved == ["example.com."]


def test_validates_the_host_httpx_will_actually_connect_to(monkeypatch):
    """IDNA normalization must not let validation and connection disagree.

    `urlparse` hands back `faß.attacker.example`; `socket.getaddrinfo` maps that through the old
    `idna` codec to `fass.attacker.example`, while httpx/httpcore apply IDNA 2008 and connect to
    `xn--fa-hia.attacker.example`. Those are DIFFERENT names, so whoever controls the parent zone
    could point the checked one at a public address and the connected one at loopback — a full
    bypass needing no DNS rebinding. The guard therefore resolves httpx's own `raw_host`.
    """
    resolved: list[str] = []

    def getaddrinfo(host, port, *a, **k):
        resolved.append(host)
        return [(2, 1, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo", getaddrinfo)
    safe_fetch.assert_public_url("http://faß.attacker.example/x")
    assert resolved == ["xn--fa-hia.attacker.example"], (
        "validated a different hostname than httpx would connect to")


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
            return _resp(302, location="https://example.com/final")
        return _resp(200, b"body", content_type="text/plain")

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    r = safe_fetch.fetch("https://example.com/start", max_bytes=1000)
    assert r.content == b"body"
    assert r.url == "https://example.com/final"


def test_redirect_to_private_address_is_refused(fake_dns, monkeypatch):
    """THE hole this module exists to close. The first URL is public and passes; the redirect
    target is cloud metadata. Following redirects inside httpx made this invisible."""
    fake_dns["metadata.evil"] = "169.254.169.254"

    def handler(request):
        return _resp(302, location="http://metadata.evil/latest/meta-data/")

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    with pytest.raises(safe_fetch.UnsafeURLError, match="non-public"):
        safe_fetch.fetch("https://public.example/start", max_bytes=1000)


def test_relative_redirect_is_resolved_against_the_current_hop(monkeypatch):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.path == "/a/start":
            return _resp(302, location="../b/final")
        return _resp(200, b"ok", content_type="text/plain")

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    r = safe_fetch.fetch("https://example.com/a/start", max_bytes=1000)
    assert r.url == "https://example.com/b/final"
    assert seen == ["https://example.com/a/start", "https://example.com/b/final"]


def test_redirect_loop_is_bounded(monkeypatch):
    def handler(request):
        return _resp(302, location="https://example.com/loop")

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    with pytest.raises(safe_fetch.UnsafeURLError, match="redirects"):
        safe_fetch.fetch("https://example.com/loop", max_bytes=1000)


def test_redirect_without_location_is_refused(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client",
                        _mock_client(lambda request: _resp(302)))
    with pytest.raises(safe_fetch.UnsafeURLError, match="Location"):
        safe_fetch.fetch("https://example.com/x", max_bytes=1000)


# ---------------- size ceiling ----------------

def test_rejects_oversized_declared_length(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, b"x" * 10, content_length="999999")))
    with pytest.raises(safe_fetch.FetchTooLargeError, match="declares"):
        safe_fetch.fetch("https://example.com/big", max_bytes=100)


def test_rejects_body_that_exceeds_ceiling_despite_lying_header(monkeypatch):
    """A hostile server can simply omit or understate Content-Length, so the ceiling has to be
    enforced against bytes actually read — that is the check that prevents the OOM."""
    monkeypatch.setattr(safe_fetch.httpx, "Client",
                        _mock_client(lambda request: _resp(200, b"x" * 5000)))
    with pytest.raises(safe_fetch.FetchTooLargeError, match="exceeds"):
        safe_fetch.fetch("https://example.com/lying", max_bytes=100)


@pytest.mark.parametrize("layers,encoding", [(1, "gzip"), (2, "gzip, gzip")])
def test_rejects_a_decompression_bomb_without_allocating_it(monkeypatch, layers, encoding):
    """A tiny wire payload that expands to 200MB, singly and doubly gzipped.

    Asserting that an exception is raised is NOT enough, and the first version of this test made
    exactly that mistake: it passed while 200MB had already been allocated. `iter_bytes()`
    decompresses each wire chunk *in full* before yielding it, so a size check on the yielded chunk
    runs after the damage. Measured on httpx 0.28.1: a 485-byte `gzip, gzip` body produced one
    200,000,000-byte chunk. So this test asserts the allocation bound — no single chunk handed to
    the ceiling may exceed it — which only holds if the ceiling counts wire bytes.
    """
    payload = b"x" * 200_000_000
    for _ in range(layers):
        payload = gzip.compress(payload)
    assert len(payload) < 250_000                 # the trap: tiny on the wire

    largest = {"chunk": 0}
    real_iter_raw = httpx.Response.iter_raw

    def spy(self, *a, **k):
        for chunk in real_iter_raw(self, *a, **k):
            largest["chunk"] = max(largest["chunk"], len(chunk))
            yield chunk

    def banned(self, *a, **k):
        # Watching iter_raw alone does NOT pin this: iter_bytes consumes iter_raw internally, so a
        # revert to iter_bytes would still show only small compressed chunks to the spy, still
        # raise FetchTooLargeError on the decoded total, and still pass — while allocating the
        # 200MB above it. Banning the call is what actually holds the ceiling on wire bytes.
        raise AssertionError(
            "safe_fetch must not use iter_bytes(): it decompresses a chunk in full before the "
            "size check can run")

    monkeypatch.setattr(httpx.Response, "iter_raw", spy)
    monkeypatch.setattr(httpx.Response, "iter_bytes", banned)
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, payload, content_encoding=encoding,
                              content_type="text/plain")))
    with pytest.raises(safe_fetch.FetchTooLargeError):
        safe_fetch.fetch("https://example.com/bomb", max_bytes=1_000_000)
    assert largest["chunk"] <= 250_000, (
        "the ceiling saw a decompressed chunk — it must count wire bytes, or a bomb is allocated "
        "in full before the check runs")


def test_rejects_a_truncated_gzip_body(monkeypatch):
    """A body that ends mid-member must FAIL, not return the prefix.

    zlib does not raise on a truncated stream — it decodes what it can and leaves `eof` False. An
    earlier version of this code took that as "done" and returned the prefix as a successful
    fetch: measured, 17 bytes of a 2000-byte body. A paper silently truncated to its first line is
    far worse than a failed download, because nothing downstream can tell.
    """
    full = gzip.compress(b"IMPORTANT PAPER TEXT" * 100)
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, full[:len(full) // 2], content_encoding="gzip")))
    with pytest.raises(safe_fetch.UnsupportedResponseError, match="malformed"):
        safe_fetch.fetch("https://example.com/x", max_bytes=100_000)


def test_raw_deflate_falls_back_when_zlib_framing_does_not_fit(monkeypatch):
    """Some servers send raw deflate under `Content-Encoding: deflate`. Reading it as the
    zlib-wrapped form fails, so the fallback wbits must get its turn — including when the first
    attempt ends 'incomplete' rather than raising outright."""
    raw_deflate = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    body = raw_deflate.compress(b"deflate payload") + raw_deflate.flush()
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, body, content_encoding="deflate")))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100_000).content == b"deflate payload"


def test_decodes_a_multi_member_gzip_body(monkeypatch):
    """RFC 1952 allows concatenated members (what `cat a.gz b.gz` produces), and a single
    `decompressobj.decompress()` call returns only the FIRST member — silently truncating the
    body. Silent truncation of a paper is worse than an error, so _inflate loops over members."""
    body = gzip.compress(b"AAA") + gzip.compress(b"BBB")
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, body, content_encoding="gzip")))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100_000).content == b"AAABBB"


def test_many_small_members_cannot_exceed_the_ceiling(monkeypatch):
    """The budget is across the whole body, not per member — otherwise N members of max_bytes each
    would each pass their own check."""
    body = b"".join(gzip.compress(b"x" * 10_000) for _ in range(20))
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, body, content_encoding="gzip")))
    with pytest.raises(safe_fetch.FetchTooLargeError):
        safe_fetch.fetch("https://example.com/x", max_bytes=50_000)


def test_decodes_a_legitimate_gzip_body(monkeypatch):
    """The bomb defence must not break ordinary compression: a server that ignores our
    `Accept-Encoding: identity` and gzips anyway still has to produce correct bytes."""
    body = b"hello " * 100
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, gzip.compress(body), content_encoding="gzip",
                              content_type="text/plain")))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100_000).content == body


def test_requests_identity_encoding(monkeypatch):
    """Belt to _decode_body's braces: not offering compression means a well-behaved server never
    gets to pick an expansion ratio in the first place."""
    seen = {}
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: (seen.update(request.headers), _resp(200, b"x"))[1]))
    safe_fetch.fetch("https://example.com/x", max_bytes=100)
    assert seen["accept-encoding"] == "identity"


def test_refuses_a_long_content_encoding_chain(monkeypatch):
    """The response picks the number of layers, and each one is a full decompression pass of up to
    max_bytes — so the byte ceiling alone does not bound the CPU. `gzip` repeated as far as the
    header limit allows would buy work proportional to the layer count with every individual layer
    staying inside the limit. Rejected before any decoding happens."""
    body = b"x" * 10
    encoding = ", ".join(["gzip"] * (safe_fetch.MAX_ENCODING_LAYERS + 1))
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, body, content_encoding=encoding)))
    with pytest.raises(safe_fetch.UnsupportedResponseError, match="layers"):
        safe_fetch.fetch("https://example.com/x", max_bytes=100_000)


def test_allows_a_chain_at_the_limit(monkeypatch):
    """The cap must not break a legitimately stacked body — otherwise the test above would pass
    against a function that rejected everything."""
    body = b"real content"
    payload = body
    for _ in range(safe_fetch.MAX_ENCODING_LAYERS):
        payload = gzip.compress(payload)
    encoding = ", ".join(["gzip"] * safe_fetch.MAX_ENCODING_LAYERS)
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, payload, content_encoding=encoding)))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100_000).content == body


def test_refuses_an_unsupported_content_encoding(monkeypatch):
    """We asked for identity, so an exotic encoding means the server ignored us. Refuse rather than
    reach for a decoder whose expansion we cannot bound."""
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, b"\x00\x01", content_encoding="br")))
    with pytest.raises(safe_fetch.UnsupportedResponseError, match="unsupported"):
        safe_fetch.fetch("https://example.com/x", max_bytes=100_000)
    # Not a size error: reporting it as one would tell the user their PDF was too big.
    assert not issubclass(safe_fetch.UnsupportedResponseError, safe_fetch.FetchTooLargeError)
    assert issubclass(safe_fetch.UnsupportedResponseError, safe_fetch.SafeFetchError)


class _FragmentedStream(httpx.SyncByteStream):
    """A body delivered as many tiny fragments — what a hostile (or merely pathological) server
    can do. httpx.ByteStream emits the whole body as ONE fragment, so it cannot exercise this."""

    def __init__(self, fragment: bytes, count: int):
        self._fragment, self._count = fragment, count

    def __iter__(self):
        for _ in range(self._count):
            yield self._fragment


def test_memory_does_not_scale_with_server_fragmentation(monkeypatch):
    """Retained memory must depend on the body's SIZE, not on how the server chose to chop it up.

    Holding each fragment as its own `bytes` made a permitted body cost `objects x ~33 bytes` of
    overhead: 200,000 one-byte fragments is a 200KB body costing ~8MB. Scaled to the real 40MB
    ceiling that is over a gigabyte, and an OOM in the single worker takes every in-flight job with
    it (invariant 6). Measured with tracemalloc so the test fails if the accumulator regresses to a
    per-fragment list.
    """
    count = 200_000
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(200, stream=_FragmentedStream(b"x", count))))

    tracemalloc.start()
    try:
        result = safe_fetch.fetch("https://example.com/x", max_bytes=1_000_000)
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert result.content == b"x" * count
    assert peak < 2_000_000, (
        f"peak {peak} bytes for a {count}-byte body — memory is tracking fragment COUNT, not size")


def test_accepts_a_body_at_the_ceiling(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, b"x" * 100)))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100).content == b"x" * 100


# ---------------- response surface ----------------

def test_http_error_status_raises(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client",
                        _mock_client(lambda request: _resp(404)))
    with pytest.raises(httpx.HTTPStatusError):
        safe_fetch.fetch("https://example.com/missing", max_bytes=100)


def test_text_decodes_with_declared_charset(monkeypatch):
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, "héllo".encode("latin-1"),
                              content_type="text/html; charset=latin-1")))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100).text == "héllo"


def test_text_survives_a_bogus_charset(monkeypatch):
    """Content-Type is attacker-controlled; an unknown charset must not raise LookupError out of
    a fetch the caller only wanted text from."""
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, b"hello",
                              content_type="text/html; charset=not-a-codec")))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=100).text == "hello"
