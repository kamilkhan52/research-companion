"""One guarded path for every outbound fetch of a URL the app did not choose itself (P0-14).

Four call sites downloaded a caller-supplied URL, and the single guard that existed
(`research_tools._assert_public_url`) had three holes:

  * **Redirects were never re-checked.** The guard validated the *first* URL and then handed the
    request to httpx with `follow_redirects=True`. A public URL that 302s to
    `http://169.254.169.254/` (cloud metadata) or to `http://127.0.0.1:8000/api/...` (this very
    process, past the network boundary) sailed straight through. This is the hole that matters
    most, because `POST /api/projects/{pid}/session/start` takes `pdf_url` straight from the
    client and hands it to `retriever._fetch`, which had no guard at all.
  * **Carrier-grade NAT was allowed.** The check enumerated `is_private/is_loopback/...`, which
    misses `100.64.0.0/10` — precisely the Tailscale range. On a tailnet-joined host (the dev Mac
    is `100.83.161.127`) those are reachable internal peers. `is_global` is the question worth
    asking: it covers every enumerated case plus CGNAT, `192.0.0.0/24`, and the IPv4-mapped IPv6
    spellings of all of them.
  * **Nothing bounded the response.** `resp.content[:N]` truncates only *after* the whole body is
    in memory, so one oversized URL is an OOM — and with a single worker (invariant 6) that takes
    down every in-flight background job, not just the offending request.

Hence: resolve, validate every resolved address, walk redirects **manually** re-validating each
hop, and stream the body under a hard ceiling counting WIRE bytes.

**We do not decompress.** The request asks for `Accept-Encoding: identity` and a response that
carries any content coding anyway is refused unread. This started as a bounded decoder, and that
decoder produced four of the seven defects found reviewing this module — a decompression bomb that
allocated before the check, silent truncation of multi-member and of truncated streams, an
unbounded encoding chain, an unbounded member count, and a suffix copy per member. Each fix was
correct and revealed one more axis. Refusing the response instead deletes the whole class: there is
no expansion ratio, no member loop, and no decode budget to get wrong. Per RFC 9110 §12.5.3 a
server should not apply a coding the client did not accept, and the bodies here are PDFs (already
compressed) and HTML pages; the only loss is a deliberately force-compressing server, on a fallback
path that already has two providers ahead of it.

**Known residual — DNS rebinding.** We validate the addresses `getaddrinfo` returns, then httpx
resolves the name again to open the connection. A hostile resolver with a 0-TTL record can answer
public on the first lookup and private on the second. Closing it means pinning the connection to
the validated address (connect by IP while carrying the original host for SNI and certificate
verification), which is a transport-level change with its own failure modes around TLS
verification — tracked as P1-11 rather than half-done here. The exposure is much narrower than the
redirect hole: it needs attacker-controlled authoritative DNS, whereas a redirect needs only a URL.

Note the residual is *only* the two-lookups-of-the-same-name race. A related-looking bypass — the
validated name and the connected name differing outright, via IDNA normalization — is closed in
`assert_public_url` by resolving `httpx.URL(url).raw_host`; see the comment there.
"""
from __future__ import annotations

import ipaddress
import socket
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from .logging_config import get

log = get("safe_fetch")

# Redirect chains longer than this are a loop or an attempt to exhaust the validator; arXiv's
# abs -> pdf -> CDN chain is the longest legitimate one we see and fits well inside it.
MAX_REDIRECTS = 5





# Wall-clock ceiling for one fetch, redirects and body included. Generous next to a real paper
# download, and the only thing standing between a slow-drip server and a permanently pinned job
# thread (see fetch).
MAX_TOTAL_SECONDS = 180.0


class SafeFetchError(Exception):
    """Base for every refusal from this module, so a call site can translate all of them into its
    own domain error with one `except` while still special-casing the ones it wants to."""


class UnsafeURLError(SafeFetchError):
    """The URL — or something it redirected to — is not a public internet destination."""


class FetchTooLargeError(SafeFetchError):
    """The response exceeded the caller's byte ceiling."""


class FetchTimeoutError(SafeFetchError):
    """The whole fetch — redirects plus body — outlasted its deadline. Distinct from httpx's
    per-operation timeout, which a slow-drip server never trips."""


class UnsupportedResponseError(SafeFetchError):
    """The response cannot be handled safely — e.g. a Content-Encoding whose expansion we have no
    way to bound. Distinct from FetchTooLargeError: nothing was oversized, we simply will not
    guess. Reporting it as a size error would tell the caller (and the user) the wrong thing."""


@dataclass(frozen=True)
class FetchResult:
    """What callers actually need from a guarded fetch. Deliberately not an `httpx.Response`: the
    body is streamed, so a Response would need its private `_content` poked to look normal, and
    handing back a half-real Response invites callers to use methods that would re-read a closed
    stream."""

    url: str                    # the FINAL url, after redirects — not what the caller passed in
    status_code: int
    headers: httpx.Headers
    content: bytes

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "")

    @property
    def text(self) -> str:
        """Body decoded per the response charset, falling back to UTF-8 with replacement. Never
        raises on malformed bytes — callers are scraping arbitrary web pages."""
        encoding = self.headers.get("content-type", "")
        charset = ""
        if "charset=" in encoding:
            charset = encoding.split("charset=", 1)[1].split(";")[0].strip()
        try:
            return self.content.decode(charset or "utf-8", errors="replace")
        except LookupError:                      # unknown charset name from a hostile header
            return self.content.decode("utf-8", errors="replace")


def _check_deadline(ends_at: float, url: str) -> float:
    """Seconds left, or raise `FetchTimeoutError`. Returning the remainder lets callers hand it to
    httpx as a per-operation timeout, so work started near the deadline cannot outlive it."""
    remaining = ends_at - time.monotonic()
    if remaining <= 0:
        raise FetchTimeoutError(f"fetch of {url} exceeded its total deadline")
    return remaining


def normalized_host(url: str) -> str:
    """The lowercased host httpx will actually put on the wire, or "" if it cannot be determined.

    The single place any host decision is made, so that "is this arXiv?" and "is this public?"
    can never be answered about two different names. `urlparse().hostname` is NOT that name: it
    skips httpx's IDNA 2008 encoding, so `faß.attacker.example` reads back as itself while httpx
    connects to `xn--fa-hia.attacker.example`. Returning "" on an unparseable host lets callers
    fail closed.

    The trailing dot, if any, is KEPT: httpx connects to `example.com.` verbatim, and that is a
    different DNS question from `example.com` — the absolute form skips the resolver's search
    suffixes, so with an unlucky search domain the two can resolve to different addresses. Callers
    comparing against a known domain strip it themselves; the resolver must see what httpx sends.
    """
    try:
        raw = httpx.URL(url).raw_host
    except (UnicodeError, ValueError, httpx.InvalidURL):
        return ""
    return raw.decode("ascii", errors="replace").lower()


def assert_public_url(url: str) -> None:
    """Raise `UnsafeURLError` unless `url` is http(s) and every address it resolves to is a public
    internet address.

    Two choices worth stating. `is_global` rather than an enumeration of private ranges: the
    enumeration form silently allowed `100.64.0.0/10`, which on a tailnet-joined host addresses
    real internal peers. And *every* resolved address is checked, not just the first — a hostname
    publishing both a public A record and a private AAAA record must be refused, because the
    client, not us, picks which one it connects to.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeURLError(f"only http(s) URLs may be fetched (got {parsed.scheme!r})")
    if not parsed.hostname:
        raise UnsafeURLError("URL has no host")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as e:                      # e.g. "http://host:notaport/"
        raise UnsafeURLError(f"invalid port in {url}") from e
    # Resolve the host EXACTLY as httpx will encode it on the wire (see normalized_host): checking
    # a different spelling of the name than the one we connect to is a bypass, not a nicety.
    host = normalized_host(url)
    if not host:
        raise UnsafeURLError(f"could not normalize the host in {url}")
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise UnsafeURLError(f"could not resolve {host}") from e
    if not infos:
        raise UnsafeURLError(f"could not resolve {host}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise UnsafeURLError(f"refusing to fetch non-public address {ip} (host {host})")


def fetch(url: str, *, max_bytes: int, timeout: float = 60,
          deadline: float = MAX_TOTAL_SECONDS,
          headers: dict[str, str] | None = None) -> FetchResult:
    """GET `url`, re-validating every redirect hop, reading at most `max_bytes` of body.

    Raises `UnsafeURLError` if any hop is not a public destination, `FetchTooLargeError` if the
    body exceeds the ceiling, and `httpx.HTTPError` (including `HTTPStatusError` for a non-2xx
    final response) for transport failures — each caller translates those into its own domain
    error, per the per-layer exception convention.

    `max_bytes` is keyword-only with no default on purpose: every call site already had its own
    natural limit, and a shared default would be wrong for all of them. Forcing the argument makes
    a new caller choose rather than inherit a number that fits somebody else's case.

    `timeout` is httpx's PER-OPERATION budget; `deadline` (default `MAX_TOTAL_SECONDS`) bounds the
    whole call. Both are needed: httpx resets its read timeout on every socket read, so a server
    that dribbles one byte just inside the timeout keeps `iter_raw()` going forever without
    exceeding either the timeout or the byte ceiling. That pins the calling thread, and every
    caller here is a background job in a single-worker process — enough of them and nothing else
    runs. Raises `FetchTimeoutError` when the deadline passes.

    Enforcement is a watchdog thread that closes the client when the deadline passes, plus checks
    between operations. The checks alone are NOT enough: httpx loops on reads internally while
    parsing response headers and while waiting for chunk framing or EOF, resetting its read timeout
    on each one, so a server dripping header bytes never returns control to this function at all.
    Measured against a local socket that emits a header line every 50ms: without the watchdog the
    call was still running after five minutes; with it, `deadline=2, timeout=3` ends at 5.0s.

    So the guarantee is `deadline + timeout`, not `deadline` — the watchdog tears down the client,
    and the read already in flight then ends at its own timeout. A caller that retries
    (`retriever._arxiv_get_bytes`, up to 3 times) spends up to that per attempt.
    """
    ends_at = time.monotonic() + deadline
    current = url
    # Ask for no content coding. Combined with the refusal below this is the whole bomb defence:
    # we never expand anything, so there is no ratio for a server to choose.
    sent = {"Accept-Encoding": "identity", **(headers or {})}
    client = httpx.Client(timeout=timeout, follow_redirects=False)
    # The watchdog is the real enforcement. `_check_deadline` only runs where this function has
    # control, and httpx does not return control while it is looping on reads for headers or
    # framing — so without this, a slow-drip server pins the thread no matter how many checks are
    # sprinkled through the loop. Closing the client tears down the connection under the read.
    watchdog = threading.Timer(max(0.0, ends_at - time.monotonic()), client.close)
    watchdog.daemon = True
    watchdog.start()
    try:
        for _ in range(MAX_REDIRECTS + 1):
            remaining = _check_deadline(ends_at, current)
            assert_public_url(current)
            # Per-hop timeout, shrunk to what is left. Without this the watchdog has a hole: it
            # calls close() once, and a connection still inside httpcore's _connect() at that
            # moment is dropped from the pool without being closed, so the request proceeds and
            # every later close() is a no-op on an already-closed client. A redirect chain can eat
            # the whole deadline and open its last connection in that instant. Handing the hop a
            # read timeout of whatever remains means such a hop cannot outlive the budget: the
            # closer the start is to the deadline, the less patience each read gets.
            with client.stream("GET", current, headers=sent,
                               timeout=min(timeout, remaining)) as r:
                if r.is_redirect:
                    location = r.headers.get("location")
                    if not location:
                        raise UnsafeURLError(f"redirect from {current} carries no Location")
                    # Resolve a relative Location against the hop we actually made, then loop so
                    # the new destination goes through assert_public_url like any other URL. This
                    # re-validation is the entire reason the chain is walked by hand.
                    nxt = str(httpx.URL(current).join(location))
                    log.debug("redirect %s -> %s", current, nxt)
                    current = nxt
                    continue
                # Checked here as well as per-hop, so a response that arrives after the deadline is
                # reported as a timeout rather than as whatever status or size problem it also has.
                _check_deadline(ends_at, current)
                r.raise_for_status()
                encoding = r.headers.get("content-encoding", "").strip()
                if encoding and encoding.lower() != "identity":
                    # Refused BEFORE the body is read: we asked for identity, so this response is
                    # either misconfigured or deliberately forcing compression, and decoding it
                    # safely turned out to need four separate bounds (ratio, chain length, member
                    # count, per-member copy) — see the module docstring.
                    raise UnsupportedResponseError(
                        f"{current} returned Content-Encoding {encoding!r} after we asked for "
                        "identity; this client does not decompress")
                declared = r.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise FetchTooLargeError(
                        f"{current} declares {declared} bytes, over the {max_bytes}-byte limit")
                # iter_raw, NOT iter_bytes: iter_bytes would decode a compressed chunk in full
                # before yielding, so a size check on it runs after the allocation. And no
                # chunk_size: httpx buffers to that size before yielding, which would let a
                # slow-drip server go minutes between deadline checks (measured: 4 checks instead
                # of 200,000 for a 200KB body of one-byte fragments). Retention is bounded by
                # appending into ONE bytearray rather than keeping each fragment as its own bytes,
                # which is what chunk_size was mistakenly added for.
                buf = bytearray()
                for chunk in r.iter_raw():
                    _check_deadline(ends_at, current)
                    if len(buf) + len(chunk) > max_bytes:
                        # Abandon the stream the moment the cap is crossed, so a lying (or absent)
                        # Content-Length cannot get more than the ceiling into memory.
                        raise FetchTooLargeError(
                            f"{current} exceeds the {max_bytes}-byte limit")
                    buf += chunk
                # A close-delimited response (no Content-Length, no chunked framing) ends at EOF,
                # which h11 accepts as a complete message — so the loop can simply stop yielding
                # instead of raising. Without this check that returns SUCCESS with whatever arrived
                # before the deadline: silent truncation, the failure this module has already
                # shipped twice. The mid-body test cannot catch it because Content-Length makes an
                # incomplete body raise on its own.
                _check_deadline(ends_at, current)
                return FetchResult(url=current, status_code=r.status_code,
                                   headers=r.headers, content=bytes(buf))

    except (httpx.HTTPError, RuntimeError) as e:
        # A read torn down by the watchdog surfaces as a transport error (or a closed-pool
        # RuntimeError). Past the deadline, that is a timeout and must be reported as one rather
        # than as a spurious network failure.
        if time.monotonic() >= ends_at:
            raise FetchTimeoutError(f"fetch of {current} exceeded its total deadline") from e
        raise
    finally:
        watchdog.cancel()
        client.close()
    raise UnsafeURLError(f"more than {MAX_REDIRECTS} redirects starting at {url}")
