"""The guarded outbound fetcher (P0-14).

Every test here is network-free: `socket.getaddrinfo` is faked so no DNS leaves the machine, and
the HTTP layer is an `httpx.MockTransport`. That is not just hygiene — the tests these replace in
test_cover_jobs.py were reaching example.com for real and "passing" because the 404 they got
happened to raise the error they asserted.
"""
from __future__ import annotations

import gzip
import socket
import threading
import time
import tracemalloc

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
    # Multicast: `is_global` reports these as PUBLIC, so replacing the old enumeration with it
    # alone quietly dropped a category the previous guard had covered.
    "224.0.0.1",
    "239.255.255.250",
    "ff02::1",
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


@pytest.mark.parametrize("url", ["http://[fe80::1/x", "http://[::1/", "http://[/"])
def test_malformed_url_is_refused_not_crashed(url):
    """urlparse raises ValueError on a broken authority (an unmatched IPv6 bracket). That is not a
    SafeFetchError, so it escaped every caller's except clauses — a client-supplied pdf_url could
    produce a 500 or an unhandled background-job crash instead of a refusal."""
    with pytest.raises(safe_fetch.UnsafeURLError):
        safe_fetch.assert_public_url(url)


def test_malformed_redirect_location_does_not_escape_untranslated(monkeypatch):
    """A malformed, attacker-chosen Location must be refused, not raised as something the callers
    do not handle.

    `httpx.URL.join` is forced to raise here. Left to itself httpx rejects a bad Location earlier
    with RemoteProtocolError — which IS an httpx.HTTPError and so already handled — meaning the
    branch under test is never reached and the test stays green with the translation removed. That
    is exactly what the first version of this test did: it observed the interception, wrote it into
    its own docstring, and then asserted the weaker property anyway.
    """
    def exploding_join(self, other):
        raise httpx.InvalidURL("Invalid port: ':1'")

    monkeypatch.setattr(httpx.URL, "join", exploding_join)
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(302, location="https://example.com/next")))
    with pytest.raises(safe_fetch.UnsafeURLError, match="Location"):
        safe_fetch.fetch("https://example.com/start", max_bytes=1000)


def test_per_hop_timeout_is_computed_after_dns(monkeypatch):
    """The budget handed to httpx must reflect time spent in DNS, not the figure from before it.

    assert_public_url blocks in getaddrinfo, which the watchdog cannot interrupt because no HTTP is
    in flight yet. A hop that spent most of its budget resolving would otherwise still receive a
    full-length read timeout, reopening the connect-time race the per-hop timeout exists to close.

    Asserting the TIMEOUT VALUE, not the outcome: the first version of this test asserted that a
    slow resolve raises FetchTimeoutError, which it does either way — the post-loop deadline check
    catches it — so it passed with the recompute moved back before the DNS call and proved nothing.
    """
    now = {"t": 1000.0}
    monkeypatch.setattr(safe_fetch.time, "monotonic", lambda: now["t"])
    monkeypatch.setattr(safe_fetch, "assert_public_url",
                        lambda url: now.__setitem__("t", now["t"] + 6.0))   # DNS eats 6 of 10

    seen = {}
    real_client = httpx.Client

    def factory(**kwargs):
        client = real_client(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=httpx.ByteStream(b"ok"))), **kwargs)
        original = client.stream

        def recording_stream(method, url, **kw):
            seen["timeout"] = kw.get("timeout")
            return original(method, url, **kw)

        client.stream = recording_stream
        return client

    monkeypatch.setattr(safe_fetch.httpx, "Client", factory)
    try:
        safe_fetch.fetch("https://example.com/x", max_bytes=1000, timeout=60, deadline=10)
    except safe_fetch.FetchTimeoutError:
        pass                      # the post-loop check may also fire; the timeout is the point
    assert seen["timeout"] is not None
    assert seen["timeout"] <= 4.0 + 0.01, (
        f"hop got {seen['timeout']}s after DNS consumed 6s of a 10s budget — computed pre-DNS")


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


@pytest.mark.parametrize("hops,ok", [(safe_fetch.MAX_REDIRECTS, True),
                                     (safe_fetch.MAX_REDIRECTS + 1, False)])
def test_redirect_limit_boundary(monkeypatch, hops, ok):
    """Both sides of MAX_REDIRECTS. The loop test only proves an infinite chain stops eventually,
    which an off-by-one in `range(MAX_REDIRECTS + 1)` would still satisfy."""
    def handler(request):
        n = int(request.url.path.strip("/"))
        if n < hops:
            return _resp(302, location=f"https://example.com/{n + 1}")
        return _resp(200, b"arrived")

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(handler))
    if ok:
        assert safe_fetch.fetch("https://example.com/0", max_bytes=1000).content == b"arrived"
    else:
        with pytest.raises(safe_fetch.UnsafeURLError, match="redirects"):
            safe_fetch.fetch("https://example.com/0", max_bytes=1000)


@pytest.mark.parametrize("target", ["file:///etc/passwd", "ftp://example.com/x"])
def test_redirect_to_a_non_http_scheme_is_refused(monkeypatch, target):
    """The scheme check must apply to redirect TARGETS, not just to the URL the caller passed.
    Every other destination rule is re-applied per hop; this one needs the same proof."""
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(302, location=target)))
    with pytest.raises(safe_fetch.UnsafeURLError):
        safe_fetch.fetch("https://example.com/start", max_bytes=1000)


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


# ---------------- resource bounds ----------------

def test_requests_identity_encoding(monkeypatch):
    """Belt to _decode_body's braces: not offering compression means a well-behaved server never
    gets to pick an expansion ratio in the first place."""
    seen = {}
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: (seen.update(request.headers), _resp(200, b"x"))[1]))
    safe_fetch.fetch("https://example.com/x", max_bytes=100)
    assert seen["accept-encoding"] == "identity"


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


def test_total_deadline_stops_a_slow_drip_server(monkeypatch):
    """httpx's `timeout` resets on every socket read, so a server feeding one byte just inside it
    keeps iter_raw() running forever, tripping neither the timeout nor the byte ceiling. Each
    caller here is a background job in a single-worker process, so a pinned thread never returns.

    The clock advances INSIDE the stream, once per fragment yielded, which is what makes this
    faithful. An earlier version advanced it inside `_check_deadline` instead — that measures how
    often we check, not how much wall clock the server has consumed, so it passed even while
    `iter_raw(chunk_size=64KB)` was batching 65,536 socket reads into a single check. Removing
    chunk_size is the fix this test exists to hold.
    """
    now = {"t": 1000.0}
    monkeypatch.setattr(safe_fetch.time, "monotonic", lambda: now["t"])

    class _SlowDrip(httpx.SyncByteStream):
        def __iter__(self):
            while True:
                now["t"] += 1.0        # each socket read costs a second of wall clock
                yield b"x"

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(200, stream=_SlowDrip())))
    started = now["t"]
    with pytest.raises(safe_fetch.FetchTimeoutError, match="deadline"):
        safe_fetch.fetch("https://example.com/drip", max_bytes=100_000_000, deadline=10)

    # The assertion that matters is HOW LONG the server got, not that an error eventually
    # arrived. Asserting only the exception passes with chunk_size=64KB too — the fetch still
    # times out, but not before letting the server burn 65,536 simulated seconds. That is the
    # bug: a pinned thread for eighteen hours is not meaningfully better than forever.
    assert now["t"] - started <= 12, (
        f"server was allowed {now['t'] - started}s against a 10s deadline — the deadline is not "
        "being checked per socket read")


def test_deadline_survives_a_server_that_drips_headers(monkeypatch):
    """The one test here that uses a REAL socket, because it has to.

    httpx loops on reads while parsing response headers and resets its read timeout on each one, so
    a server sending a header line every fraction of a second never returns control to fetch() —
    no amount of `_check_deadline` sprinkled through the loop can see it. Reproduced before fixing:
    a 2-second read timeout still hung past two minutes. A MockTransport cannot express this,
    because it hands back a response object without ever doing socket reads.

    The listener is on loopback, which assert_public_url refuses by design, so validation is
    stubbed for this test only — the destination check is covered thoroughly elsewhere.

    Note the failure mode if the watchdog is removed: this test HANGS rather than failing, because
    that is precisely the bug (measured: still running after five minutes). A hanging test is an
    unpleasant signal, but a silent pass would be worse.
    """
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    stop = threading.Event()

    def serve():
        try:
            conn, _ = server.accept()
        except OSError:
            return
        try:
            conn.recv(65536)
            conn.sendall(b"HTTP/1.1 200 OK\r\n")
            while not stop.is_set():       # headers that never end
                conn.sendall(b"X-Pad: y\r\n")
                time.sleep(0.05)
        except OSError:
            pass
        finally:
            conn.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    monkeypatch.setattr(safe_fetch, "assert_public_url", lambda url: None)
    try:
        started = time.monotonic()
        with pytest.raises(safe_fetch.FetchTimeoutError):
            safe_fetch.fetch(f"http://127.0.0.1:{port}/", max_bytes=1_000_000,
                             timeout=3, deadline=2)
        elapsed = time.monotonic() - started
        # deadline + one `timeout`: the watchdog closes the client, and the read already in flight
        # ends at its own timeout. That is the real guarantee — not `deadline`, and not unbounded.
        assert elapsed < 2 + 3 + 4, f"took {elapsed:.1f}s against deadline=2 timeout=3"
    finally:
        stop.set()
        server.close()
        thread.join(timeout=2)


def test_watchdog_teardown_mid_body_is_not_silent_truncation(monkeypatch):
    """A deadline that fires while the BODY is streaming must raise, never return what arrived.

    This module has shipped silent truncation twice (multi-member gzip, and a stream ending
    mid-member), both times returning a short body as a successful fetch. The watchdog introduces a
    third opportunity for it: if closing the client made `iter_raw()` simply stop yielding rather
    than raise, the partial body would be returned as SUCCESS and nothing downstream could tell a
    truncated paper from a short one.
    """
    body_len = 100_000
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    stop = threading.Event()

    def serve():
        try:
            conn, _ = server.accept()
        except OSError:
            return
        try:
            conn.recv(65536)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % body_len)
            sent = 0
            while not stop.is_set() and sent < body_len:
                conn.sendall(b"A" * 100)   # dribble the body, never finishing it
                sent += 100
                time.sleep(0.05)
        except OSError:
            pass
        finally:
            conn.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    monkeypatch.setattr(safe_fetch, "assert_public_url", lambda url: None)
    try:
        with pytest.raises(safe_fetch.FetchTimeoutError):
            safe_fetch.fetch(f"http://127.0.0.1:{port}/", max_bytes=1_000_000,
                             timeout=3, deadline=2)
    finally:
        stop.set()
        server.close()
        thread.join(timeout=2)


def test_close_delimited_eof_after_deadline_is_not_success(monkeypatch):
    """A close-delimited body (no Content-Length, no chunked framing) ends at EOF, which h11
    accepts as a COMPLETE message — so the read loop stops yielding instead of raising, and without
    a check after the loop the partial body returns as SUCCESS.

    Simulated rather than driven by a real socket: on macOS the watchdog's close() interrupts the
    blocked read, so the live version of this raises for a different reason and cannot distinguish
    the two implementations. The hazard is real where close() does NOT interrupt a blocked read, so
    the stream here reproduces that condition directly — yield some data, let the deadline pass,
    then end the iteration cleanly.
    """
    now = {"t": 1000.0}
    monkeypatch.setattr(safe_fetch.time, "monotonic", lambda: now["t"])

    class _StallThenEOF(httpx.SyncByteStream):
        def __iter__(self):
            yield b"PARTIAL"
            now["t"] += 60.0          # the stall: deadline passes with no further data
            return                    # EOF, which h11 reads as a complete message

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(200, stream=_StallThenEOF())))
    with pytest.raises(safe_fetch.FetchTimeoutError):
        safe_fetch.fetch("https://example.com/x", max_bytes=1_000_000, deadline=10)


def test_deadline_does_not_fire_on_a_normal_fetch(monkeypatch):
    """The guard must not break ordinary downloads, or the test above would pass against a
    function that always timed out."""
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, b"quick")))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=1000).content == b"quick"


@pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "gzip, gzip"])
def test_refuses_any_content_encoding_unread(monkeypatch, encoding):
    """We ask for identity and refuse anything else WITHOUT reading the body.

    This replaces a bounded decoder that produced four of this module's defects — a bomb that
    allocated before the check, silent truncation twice over, an unbounded encoding chain, an
    unbounded member count, a per-member suffix copy. Each fix was right and exposed one more axis.
    Not decompressing removes the axis itself.
    """
    read = {"body": False}

    class _Watched(httpx.SyncByteStream):
        def __iter__(self):
            read["body"] = True
            yield gzip.compress(b"x" * 10_000)

    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: httpx.Response(200, stream=_Watched(),
                                       headers={"content-encoding": encoding})))
    with pytest.raises(safe_fetch.UnsupportedResponseError, match="does not decompress"):
        safe_fetch.fetch("https://example.com/x", max_bytes=1_000_000)
    assert not read["body"], "refused only after reading the body"


def test_identity_encoding_header_is_accepted(monkeypatch):
    """An explicit `identity` is not a content coding and must not be refused."""
    monkeypatch.setattr(safe_fetch.httpx, "Client", _mock_client(
        lambda request: _resp(200, b"plain", content_encoding="identity")))
    assert safe_fetch.fetch("https://example.com/x", max_bytes=1000).content == b"plain"


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
