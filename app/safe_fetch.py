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
hop, and stream the body under a hard ceiling.

**Known residual — DNS rebinding.** We validate the addresses `getaddrinfo` returns, then httpx
resolves the name again to open the connection. A hostile resolver with a 0-TTL record can answer
public on the first lookup and private on the second. Closing it means pinning the connection to
the validated address (connect by IP while carrying the original host for SNI and certificate
verification), which is a transport-level change with its own failure modes around TLS
verification — tracked as a separate item rather than half-done here. The exposure is much
narrower than the redirect hole: it needs attacker-controlled authoritative DNS, whereas a
redirect needs only a URL.
"""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from .logging_config import get

log = get("safe_fetch")

# Redirect chains longer than this are a loop or an attempt to exhaust the validator; arXiv's
# abs -> pdf -> CDN chain is the longest legitimate one we see and fits well inside it.
MAX_REDIRECTS = 5


class UnsafeURLError(Exception):
    """The URL — or something it redirected to — is not a public internet destination."""


class FetchTooLargeError(Exception):
    """The response exceeded the caller's byte ceiling."""


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
    host = parsed.hostname
    if not host:
        raise UnsafeURLError("URL has no host")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as e:                      # e.g. "http://host:notaport/"
        raise UnsafeURLError(f"invalid port in {url}") from e
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
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            assert_public_url(current)
            with client.stream("GET", current, headers=headers or {}) as r:
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
                chunks: list[bytes] = []
                total = 0
                for chunk in r.iter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        # Abandon the stream the moment the cap is crossed, so a lying (or absent)
                        # Content-Length cannot get more than the ceiling into memory.
                        raise FetchTooLargeError(
                            f"{current} exceeds the {max_bytes}-byte limit")
                    chunks.append(chunk)
                return FetchResult(url=current, status_code=r.status_code,
                                   headers=r.headers, content=b"".join(chunks))
    raise UnsafeURLError(f"more than {MAX_REDIRECTS} redirects starting at {url}")
