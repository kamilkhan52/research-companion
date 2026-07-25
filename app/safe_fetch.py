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
hop, and stream the body under a hard ceiling — counting WIRE bytes and decoding separately, since
`iter_bytes()` expands a compressed chunk in full before any size check could run.

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
import zlib
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from .logging_config import get

log = get("safe_fetch")

# Redirect chains longer than this are a loop or an attempt to exhaust the validator; arXiv's
# abs -> pdf -> CDN chain is the longest legitimate one we see and fits well inside it.
MAX_REDIRECTS = 5


class SafeFetchError(Exception):
    """Base for every refusal from this module, so a call site can translate all of them into its
    own domain error with one `except` while still special-casing the ones it wants to."""


class UnsafeURLError(SafeFetchError):
    """The URL — or something it redirected to — is not a public internet destination."""


class FetchTooLargeError(SafeFetchError):
    """The response exceeded the caller's byte ceiling."""


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
    # Resolve the host EXACTLY as httpx will encode it on the wire, not as urlparse hands it back.
    # The two disagree on internationalized names: httpx/httpcore apply IDNA 2008, so
    # "faß.attacker.example" goes out as "xn--fa-hia.attacker.example", while socket.getaddrinfo
    # applies the older `idna` codec and would validate "fass.attacker.example" — a DIFFERENT name.
    # Someone controlling the parent zone could point the name we check at a public address and the
    # name httpx connects to at 127.0.0.1, defeating the guard outright and without needing any DNS
    # rebinding. Taking raw_host removes the disagreement by construction.
    try:
        host = httpx.URL(url).raw_host.decode("ascii")
    except (UnicodeError, ValueError, httpx.InvalidURL) as e:
        # An unencodable host is refused rather than guessed at — fail closed.
        raise UnsafeURLError(f"could not normalize host in {url}: {e}") from e
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


def _decode_body(raw: bytes, content_encoding: str, *, max_bytes: int, url: str) -> bytes:
    """Undo `Content-Encoding` under a hard output bound.

    Decoding is done here rather than by httpx so that expansion is bounded: `zlib`'s
    `decompress(data, max_length)` stops producing output at the limit, so a bomb costs
    `max_bytes`, not however far it wanted to expand. Encodings are listed in the order they were
    applied, so they are undone in reverse. Anything other than gzip/deflate/identity is refused —
    we send `Accept-Encoding: identity`, so a different encoding means the server ignored us, and
    guessing at an unbounded decoder is exactly what this function exists to avoid.
    """
    encodings = [e.strip().lower() for e in content_encoding.split(",") if e.strip()]
    for enc in reversed(encodings):
        if enc == "identity":
            continue
        if enc not in ("gzip", "x-gzip", "deflate"):
            raise UnsupportedResponseError(
                f"{url} used unsupported Content-Encoding {enc!r} (we requested identity)")
        # 16+MAX_WBITS: gzip framing. For deflate, accept both the zlib-wrapped form and the raw
        # form some servers send.
        wbits_options = (16 + zlib.MAX_WBITS,) if enc in ("gzip", "x-gzip") \
            else (zlib.MAX_WBITS, -zlib.MAX_WBITS)
        for i, wbits in enumerate(wbits_options):
            try:
                raw = _inflate(raw, wbits, max_bytes=max_bytes, url=url)
                break
            except zlib.error:
                if i == len(wbits_options) - 1:
                    raise UnsupportedResponseError(
                        f"{url} sent malformed {enc} content") from None
    return raw


def _inflate(data: bytes, wbits: int, *, max_bytes: int, url: str) -> bytes:
    """Inflate `data`, never producing more than `max_bytes`, handling MULTI-MEMBER streams.

    The member loop is not a nicety: `zlib.decompressobj` stops at the end of the first member and
    leaves the rest in `unused_data`, so a single decompress call on a legitimate concatenated gzip
    body (which RFC 1952 allows, and `cat a.gz b.gz` produces) returns only the first member's
    bytes. Silently truncating a paper mid-download is worse than failing.
    """
    out = bytearray()
    remaining = data
    while remaining:
        obj = zlib.decompressobj(wbits)
        # Budget the whole output, not each member, so many small members cannot add up past it.
        chunk = obj.decompress(remaining, max_bytes + 1 - len(out))
        out += chunk
        if len(out) > max_bytes or obj.unconsumed_tail:
            raise FetchTooLargeError(f"{url} decompresses past the {max_bytes}-byte limit")
        if not obj.eof:
            break                      # stream ended mid-member; take what decoded cleanly
        nxt = obj.unused_data
        if len(nxt) >= len(remaining):
            break                      # no forward progress — refuse to spin
        remaining = nxt
    return bytes(out)


def fetch(url: str, *, max_bytes: int, timeout: float = 60,
          headers: dict[str, str] | None = None) -> FetchResult:
    """GET `url`, re-validating every redirect hop, reading at most `max_bytes` of body.

    Raises `UnsafeURLError` if any hop is not a public destination, `FetchTooLargeError` if the
    body exceeds the ceiling, and `httpx.HTTPError` (including `HTTPStatusError` for a non-2xx
    final response) for transport failures — each caller translates those into its own domain
    error, per the per-layer exception convention.

    `max_bytes` is keyword-only with no default on purpose: every call site already had its own
    natural limit, and a shared default would be wrong for all of them. Forcing the argument makes
    a new caller choose rather than inherit a number that fits somebody else's case.
    """
    current = url
    # Ask for no compression: a decompression bomb is only a threat if the server gets to choose
    # the expansion ratio. Callers may still override it, and a server may ignore it, so
    # _decode_body remains the actual guarantee — this just avoids the situation.
    sent = {"Accept-Encoding": "identity", **(headers or {})}
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            assert_public_url(current)
            with client.stream("GET", current, headers=sent) as r:
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
                r.raise_for_status()
                declared = r.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise FetchTooLargeError(
                        f"{current} declares {declared} bytes, over the {max_bytes}-byte limit")
                # iter_raw, NOT iter_bytes: iter_bytes decompresses each wire chunk in full before
                # yielding it, so the size check would run only AFTER the allocation. Measured: a
                # 485-byte body with `Content-Encoding: gzip, gzip` yields ONE 200,000,000-byte
                # chunk — the ceiling raises afterwards, having already allocated 200 MB, which in
                # a single-worker process (invariant 6) is the outage this ceiling exists to
                # prevent. Counting wire bytes bounds what the socket can hand us; decoding is done
                # separately, under its own bound.
                chunks: list[bytes] = []
                total = 0
                for chunk in r.iter_raw():
                    total += len(chunk)
                    if total > max_bytes:
                        # Abandon the stream the moment the cap is crossed, so a lying (or absent)
                        # Content-Length cannot get more than the ceiling into memory.
                        raise FetchTooLargeError(
                            f"{current} exceeds the {max_bytes}-byte limit")
                    chunks.append(chunk)
                body = _decode_body(b"".join(chunks), r.headers.get("content-encoding", ""),
                                    max_bytes=max_bytes, url=current)
                return FetchResult(url=current, status_code=r.status_code,
                                   headers=r.headers, content=body)
    raise UnsafeURLError(f"more than {MAX_REDIRECTS} redirects starting at {url}")
