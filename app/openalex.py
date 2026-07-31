"""OpenAlex enrichment: authorships (author names + institutions) for scholarly papers.

Why OpenAlex (U.9 source evaluation): project graph nodes are built with `authors: []` and
nothing fills them — and the authors view needs affiliations too. OpenAlex's works endpoint,
looked up **by arXiv id**, returns both in one call OpenAlex prices at zero (a single work by
id), and the lookup is paper-scoped so there is no author-name ambiguity to resolve. Semantic
Scholar's affiliation fields are mostly empty in practice, and a first-PDF-page LLM pass costs
tokens per paper — that pass remains the future backfill for non-arXiv papers only.

OpenAlex has been usage-priced since 2026-02-24. Identifier lookups like this one still cost
nothing, but SEARCH is $0.001/call against a daily allowance of $0.10 unkeyed or $1 with a free
key — so the key (see `api_key`) is what keeps `citations`' title-search fallback usable.

Shape mirrors citations.py: called from the graph build job only (never a request), a
node-id-keyed cache persisted in the graph store so coverage accumulates across builds, and
best-effort throughout — enrichment must never fail a build. Discover also uses the same
paper-scoped lookup for its bounded arXiv/DOI candidate set. Tests inject a fake client (suite
stays network-free)."""
from __future__ import annotations

import os
import re
import time
from urllib.parse import quote

import httpx

from . import config, logging_config, store

log = logging_config.get("openalex")

BASE = "https://api.openalex.org"
TIMEOUT_S = 30.0
_PACE_S = 0.15


def _headers() -> dict:
    """OpenAlex asks polite-pool users to identify themselves. The contact is deployment
    configuration (RC_CONTACT_EMAIL), never a hardcoded personal address in the repo."""
    contact = os.environ.get("RC_CONTACT_EMAIL", "").strip()
    ua = f"research-companion (mailto:{contact})" if contact else "research-companion"
    return {"User-Agent": ua}


def api_key() -> str:
    """The OpenAlex key. Mirrors `semantic_scholar.api_key`: environment first, then the
    instance settings document (an operator key — one deployment, one OpenAlex account)."""
    return (
        os.environ.get("OPENALEX_API_KEY")
        or config.load_settings().get("openalex_api_key")
        or ""
    ).strip()


class _ApiKeyAuth(httpx.Auth):
    """Stamps `api_key` onto the outgoing request URL.

    Client-level `params=` is NOT enough, which is the whole reason this class exists: httpx
    merges client params UNDERNEATH request params, so a call site that passes its own
    `api_key` — including an empty one — silently replaces the configured key and puts us back
    on the unkeyed allowance, where 429 is indistinguishable from OpenAlex having no data.
    `auth_flow` runs after that merge, so it is the only attachment point that always wins.
    """

    def __init__(self, key: str) -> None:
        self._key = key

    def auth_flow(self, request):
        request.url = request.url.copy_set_param("api_key", self._key)
        yield request


def make_client(*, timeout: float = TIMEOUT_S) -> httpx.Client:
    """The one way to build an OpenAlex client: polite-pool identification plus the API key,
    attached so that no call site — present or future — can drop it. Unkeyed, this is an
    ordinary client; OpenAlex answers with a 10x smaller daily allowance rather than a refusal.
    """
    key = api_key()
    return httpx.Client(timeout=timeout, headers=_headers(),
                        auth=_ApiKeyAuth(key) if key else None)


def _work_lookup_id(*, arxiv_id: str | None = None, doi: str | None = None) -> str | None:
    if arxiv_id:
        base_id = store.arxiv_base_id(arxiv_id)
        if base_id:
            return f"doi:10.48550/arXiv.{base_id}"
    clean_doi = (doi or "").strip()
    clean_doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", clean_doi, flags=re.IGNORECASE)
    return f"doi:{clean_doi}" if clean_doi else None


def work_authorships_for(
    *,
    arxiv_id: str | None = None,
    doi: str | None = None,
    client: httpx.Client,
) -> list[dict] | None:
    """[{name, affiliation}] for one identified work, or None when the lookup misses."""
    lookup = _work_lookup_id(arxiv_id=arxiv_id, doi=doi)
    if not lookup:
        return None
    r = client.get(
        f"{BASE}/works/{quote(lookup, safe=':./')}",
        params={"select": "authorships"},
        headers=_headers(),
    )
    if r.status_code != 200:
        return None
    out = []
    for a in (r.json().get("authorships") or []):
        name = ((a.get("author") or {}).get("display_name") or "").strip()
        if not name:
            continue
        institutions = a.get("institutions") or []
        affiliation = str((institutions[0].get("display_name") if institutions else "") or "")
        out.append({"name": name, "affiliation": affiliation})
    return out


def work_authorships(arxiv_id: str, *, client: httpx.Client) -> list[dict] | None:
    """[{name, affiliation}] for one arXiv work, or None when the lookup fails/misses.
    `affiliation` is the first institution's display name ("" when OpenAlex has none —
    patchy coverage is expected and the UI omits unknowns rather than showing 'Unknown')."""
    # OpenAlex's single-work endpoint does NOT accept an `arxiv:` key (it 404s) — but arXiv
    # mints a DOI `10.48550/arXiv.<id>` for every paper, and the DOI lookup works. Use the
    # canonical VERSIONLESS id (a `v3` suffix this repo preserves elsewhere would miss, and
    # since misses aren't cached it would retry forever).
    return work_authorships_for(arxiv_id=arxiv_id, client=client)



def concurrency() -> int:
    """How many discovery authorship lookups run at once. Bounded 1-12; 1 keeps the serial loop."""
    try:
        n = int(os.environ.get("RC_DISCOVERY_RECALL_CONCURRENCY", "8"))
    except ValueError:
        n = 8
    return max(1, min(12, n))


def _annotate_discovery_parallel(candidates: list[dict], *, client: httpx.Client) -> None:
    """The same lookup, fanned out. These are single-work-by-id calls, which OpenAlex prices at
    zero, so the only cost of doing them one at a time was wall-clock — 83s for 60 candidates on
    a real run, against a funnel whose other stages had already been parallelised down to tens of
    seconds. Failures stay best-effort: a candidate simply keeps no affiliations."""
    from . import jobs

    targets = [c for c in candidates
               if c.get("arxiv_id") or c.get("doi")]
    if not targets:
        return

    def one(candidate: dict):
        return work_authorships_for(arxiv_id=candidate.get("arxiv_id"),
                                    doi=candidate.get("doi"), client=client)

    # The first lookup is a serial PROBE, which preserves the property the serial loop had: a
    # transport outage aborts the pass after ONE request instead of paying a timeout per paper.
    # Fanning out blindly would turn an outage into `len(targets)/workers` rounds of timeouts.
    try:
        first = one(targets[0])
    except httpx.HTTPError:
        log.info("openalex unreachable — skipping discovery enrichment")
        return
    rest = jobs.run_parallel(targets[1:], one, max_workers=concurrency(),
                             thread_name_prefix="discover-authorships")

    for candidate, ships in zip(targets, [first, *rest], strict=True):
        if isinstance(ships, Exception) or ships is None:
            continue
        candidate["authorships"] = ships
        if not candidate.get("authors"):
            candidate["authors"] = [ship["name"] for ship in ships]
        candidate["affiliations"] = list(dict.fromkeys(
            ship["affiliation"] for ship in ships if ship.get("affiliation")))


def annotate_discovery_authorships(
    candidates: list[dict],
    *,
    client: httpx.Client | None = None,
    sleep=time.sleep,
) -> None:
    """Best-effort author/institution metadata for a bounded discovery candidate set.

    This reuses Map's paper-scoped OpenAlex lookup rather than guessing institutions from author
    names. A transport outage aborts after one request; missing metadata never penalizes ranking.
    """
    own = client is None
    client = client or make_client(timeout=TIMEOUT_S)
    if concurrency() > 1:
        _annotate_discovery_parallel(candidates, client=client)
        if own:
            client.close()
        return
    try:
        for candidate in candidates:
            if not candidate.get("arxiv_id") and not candidate.get("doi"):
                continue
            try:
                ships = work_authorships_for(
                    arxiv_id=candidate.get("arxiv_id"),
                    doi=candidate.get("doi"),
                    client=client,
                )
            except httpx.HTTPError:
                log.info("openalex unreachable — skipping discovery enrichment")
                break
            if ships is not None:
                candidate["authorships"] = ships
                if not candidate.get("authors"):
                    candidate["authors"] = [ship["name"] for ship in ships]
                candidate["affiliations"] = list(dict.fromkeys(
                    ship["affiliation"] for ship in ships if ship.get("affiliation")
                ))
            sleep(_PACE_S)
    except Exception:
        pass
    finally:
        if own:
            client.close()


def annotate_project_authors(nodes: list[dict], cache: dict, *,
                             client: httpx.Client | None = None, sleep=time.sleep,
                             fetch: bool = True, force: bool = False) -> None:
    """Fill `authors` on project nodes from OpenAlex authorships, fetching what the cache
    (node id -> {status, authorships}) doesn't already hold and updating it (persisted by
    the caller via the graph store). `fetch=False` applies the cache only — skeleton
    snapshots must stay network-free. `force=True` (a full rebuild-from-scratch) re-fetches
    every project node even on a cache hit, so authors/affiliations that OpenAlex has gained
    since the last build get picked up. Never raises."""
    if fetch:
        own = client is None
        client = client or make_client(timeout=TIMEOUT_S)
        try:
            for node in nodes:
                if node.get("kind") != "project" or not node.get("arxiv_id"):
                    continue
                base = store.arxiv_base_id(node["arxiv_id"])
                hit = cache.get(node["id"])
                # A hit only counts when it was fetched for the SAME (versionless) arXiv id:
                # retrieval can correct a misidentified entry's id (annotate_entry
                # authoritative) while the slug/node id stays put — the old paper's authors
                # must not survive that. A stale record whose refetch misses is DROPPED, so
                # the unconditional apply pass below can't publish the previous paper's
                # authors on an identity correction.
                if not force and hit and hit.get("arxiv_id") == base:
                    continue
                try:
                    ships = work_authorships(node["arxiv_id"], client=client)
                except httpx.HTTPError:
                    # Transport-level failure = OpenAlex is unreachable/slow. Abort the whole
                    # pass rather than eating a full timeout on every remaining paper (a
                    # 20-paper project would otherwise add ~10 min to a build during an
                    # outage). A stale-id record stays until a live pass can replace it.
                    log.info("openalex unreachable — skipping author enrichment this build")
                    break
                if ships is None:
                    # A miss (paper not on OpenAlex yet) is retried next build; nothing new
                    # is written so the retry is automatic.
                    log.debug("openalex miss for %s", node["id"])
                    if hit and hit.get("arxiv_id") != base:
                        cache.pop(node["id"], None)  # never keep another paper's authors
                else:
                    cache[node["id"]] = {"status": "done", "arxiv_id": base,
                                         "authorships": ships}
                sleep(_PACE_S)
        except Exception:
            pass  # enrichment only — never fail the build
        finally:
            if own:
                client.close()
    for node in nodes:
        if node.get("kind") != "project":
            continue
        hit = cache.get(node["id"])
        # Only apply a record whose id matches the node's current (versionless) id — on the
        # fetch=False skeleton path a corrected-but-not-yet-refetched entry would otherwise
        # show the previous paper's authors.
        if not hit or node.get("authors"):
            continue
        if node.get("arxiv_id") and hit.get("arxiv_id") != store.arxiv_base_id(node["arxiv_id"]):
            continue
        node["authors"] = [s["name"] for s in hit.get("authorships") or []]
