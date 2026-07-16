"""LLM affiliation extraction — the fallback when no metadata provider has institution data
(R6.4, provider-first then LLM).

OpenAlex work authorships fill author names and affiliations when OpenAlex has them, but arXiv
preprints usually carry no institution data there, so the Labs board collapsed into
"Independent / unknown". The affiliations ARE printed on the paper itself — the retrieved full
text's head is the title/author/affiliation block — so this pass shows that head to the
analysis model and asks for an author → institution mapping.

Same enrichment contract as citations.py / openalex.py: called from the graph build job only
(never a request; the job thread has the project contextvar bound), a node-id-keyed cache
persisted in the graph store so coverage accumulates across builds, best-effort throughout —
this must never fail a build. Output is line-based ("Name | Institution"), not JSON, parsed
tolerantly. Tests inject a fake completion function (suite stays network-free)."""
from __future__ import annotations

import concurrent.futures

from . import config, llm, logging_config, store

log = logging_config.get("affiliations")

# The author/affiliation block sits at the very top of the retrieved text (title, authors,
# institutions, abstract). This is plenty to cover multi-institution author lists while
# keeping the call cheap.
FIRST_PAGE_CHARS = 3000

# Wall-clock deadline per extraction, enforced from the caller (same reasoning as graph
# extraction's hard deadline): a provider that accepts the request but stalls while sending
# keep-alives can reset the HTTP read timeout forever, and this call runs synchronously in
# the build's final enrichment phase — without this, the graph job never settles and rebuilds
# only join the stuck job. The stalled thread can't be killed, but nothing waits on it.
HARD_DEADLINE_S = 120.0
_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=2,
                                                  thread_name_prefix="affiliations")

_PROMPT = """Below is the opening of a research paper (title, author list with affiliation \
markers, abstract). Map each listed author to their institutional affiliation as printed.

Rules:
- Output exactly one line per author, in the form: Author Name | Institution
- Use the institution's common name (e.g. "MIT", "Google DeepMind", "Imperial College London").
- If several institutions are marked for an author, use the first.
- If an author's affiliation is not determinable from the text, end the line after the bar.
- Output ONLY these lines — no commentary, no headers.

Paper opening:
---
{text}
---"""


def _parse(raw: str) -> list[dict]:
    """Tolerant line parser: keep 'Name | Institution' lines, drop anything else."""
    out = []
    for line in (raw or "").splitlines():
        if "|" not in line:
            continue
        name, _, affiliation = line.partition("|")
        name = name.strip().strip("-*•").strip()
        if not name or len(name) > 80:
            continue
        out.append({"name": name, "affiliation": affiliation.strip()[:120]})
    return out


def extract(slug: str, *, complete=None) -> list[dict] | None:
    """[{name, affiliation}] read off the paper's own first page, or None when there is no
    cached text / the model call fails (both retried on the next build). An empty list means
    the pass RAN and found nothing — that IS cached, so a paper with a truly bare header
    isn't re-billed every build."""
    text = store.read_full_text(slug)[:FIRST_PAGE_CHARS].strip()
    if not text:
        return None
    complete = complete or llm.complete
    # The call runs in a worker thread so the deadline is wall-clock; threads don't inherit
    # contextvars, so rebind the project (invariant 2) or usage lands on the wrong ledger.
    pid = config.active_project_id()

    def _do():
        token = config.set_active_project(pid)
        try:
            return complete([{"role": "user", "content": _PROMPT.format(text=text)}],
                            temperature=0, max_tokens=800, timeout=60,
                            operation="affiliations")
        finally:
            config.reset_active_project(token)

    try:
        raw = _EXECUTOR.submit(_do).result(timeout=HARD_DEADLINE_S)
    except concurrent.futures.TimeoutError:
        log.info("affiliation extraction timed out for %s", slug)
        return None
    except llm.LLMError as e:
        log.info("affiliation extraction failed for %s: %s", slug, str(e)[:120])
        return None
    return _parse(raw)


def annotate_project_affiliations(nodes: list[dict], openalex_cache: dict, cache: dict, *,
                                  complete=None, force: bool = False) -> None:
    """Fill the affiliation gaps OpenAlex left, one LLM pass per uncovered project paper,
    then apply the cache to nodes. Never raises — enrichment must never fail a build.
    (Tests stub _extract_missing, mirroring citations._fetch_missing, so builds stay
    LLM-free; the apply step still runs for real.)"""
    try:
        _extract_missing(nodes, openalex_cache, cache, complete=complete, force=force)
    except Exception:  # enrichment only — never fail the build
        pass
    apply_cached(nodes, cache)


def _extract_missing(nodes: list[dict], openalex_cache: dict, cache: dict, *,
                     complete=None, force: bool = False) -> None:
    """Run the LLM pass for project papers the provider left without any institution.

    Provider-first: a node whose OpenAlex authorships carry ANY affiliation is skipped — the
    provider record wins and no tokens are spent. Cache entries are keyed to the node's
    versionless arXiv id (falling back to the slug) so an identity correction invalidates
    them, mirroring openalex.annotate_project_authors. `force=True` re-extracts everything."""
    for node in nodes:
        if node.get("kind") != "project" or not node.get("slug"):
            continue
        provider_ships = (openalex_cache.get(node["id"]) or {}).get("authorships") or []
        if any(s.get("affiliation") for s in provider_ships):
            continue  # provider-first: OpenAlex has institution data for this paper
        key = store.arxiv_base_id(node.get("arxiv_id") or "") or node["slug"]
        hit = cache.get(node["id"])
        if not force and hit and hit.get("key") == key:
            continue
        ships = extract(node["slug"], complete=complete)
        if ships is None:
            if hit and hit.get("key") != key:
                cache.pop(node["id"], None)  # never keep another paper's affiliations
            continue
        cache[node["id"]] = {"status": "done", "key": key, "authorships": ships}


def apply_cached(nodes: list[dict], cache: dict) -> None:
    """Fill `authors` on project nodes the provider missed entirely, from records keyed to
    the node's current identity — so those papers' people reach the board at all."""
    for node in nodes:
        if node.get("kind") != "project" or node.get("authors") or not node.get("slug"):
            continue
        hit = cache.get(node["id"])
        if not hit:
            continue
        key = store.arxiv_base_id(node.get("arxiv_id") or "") or node["slug"]
        if hit.get("key") != key:
            continue
        node["authors"] = [s["name"] for s in hit.get("authorships") or [] if s.get("name")]
