"""OpenAlex enrichment: authorships (author names + institutions) for project papers.

Why OpenAlex (U.9 source evaluation): project graph nodes are built with `authors: []` and
nothing fills them — and the authors view needs affiliations too. OpenAlex's works endpoint,
looked up **by arXiv id**, returns both in one free, keyless call, and the lookup is
paper-scoped so there is no author-name ambiguity to resolve. Semantic Scholar's affiliation
fields are mostly empty in practice, and a first-PDF-page LLM pass costs tokens per paper —
that pass remains the future backfill for non-arXiv papers only.

Shape mirrors citations.py: called from the graph build job only (never a request), a
node-id-keyed cache persisted in the graph store so coverage accumulates across builds, and
best-effort throughout — enrichment must never fail a build. Tests inject a fake client
(suite stays network-free)."""
from __future__ import annotations

import os
import time

import httpx

from . import logging_config, store

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


def work_authorships(arxiv_id: str, *, client: httpx.Client) -> list[dict] | None:
    """[{name, affiliation}] for one arXiv work, or None when the lookup fails/misses.
    `affiliation` is the first institution's display name ("" when OpenAlex has none —
    patchy coverage is expected and the UI omits unknowns rather than showing 'Unknown')."""
    # OpenAlex keys arXiv works by the canonical VERSIONLESS id; a `2401.12345v3` (a suffix
    # this repo deliberately preserves elsewhere) would miss and, since misses aren't cached,
    # retry forever.
    base_id = store.arxiv_base_id(arxiv_id)
    if not base_id:
        return None
    r = client.get(f"{BASE}/works/arxiv:{base_id}",
                   params={"select": "authorships"}, headers=_headers())
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


def annotate_project_authors(nodes: list[dict], cache: dict, *,
                             client: httpx.Client | None = None, sleep=time.sleep,
                             fetch: bool = True) -> None:
    """Fill `authors` on project nodes from OpenAlex authorships, fetching what the cache
    (node id -> {status, authorships}) doesn't already hold and updating it (persisted by
    the caller via the graph store). `fetch=False` applies the cache only — skeleton
    snapshots must stay network-free. Never raises."""
    if fetch:
        own = client is None
        client = client or httpx.Client(timeout=TIMEOUT_S)
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
                if hit and hit.get("arxiv_id") == base:
                    continue
                try:
                    ships = work_authorships(node["arxiv_id"], client=client)
                except httpx.HTTPError:
                    ships = None
                if ships is None:
                    # A miss is retried next build (papers do land on OpenAlex late);
                    # nothing new is written so the retry is automatic.
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
