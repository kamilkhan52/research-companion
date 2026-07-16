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

import hashlib
import threading

from . import config, graph_store, llm, logging_config, store

log = logging_config.get("affiliations")

# The author/affiliation block sits at the very top of the retrieved text (title, authors,
# institutions, abstract). This is plenty to cover multi-institution author lists while
# keeping the call cheap.
FIRST_PAGE_CHARS = 3000

# Wall-clock deadline per extraction, enforced from the caller (same reasoning as graph
# extraction's hard deadline): a provider that accepts the request but stalls while sending
# keep-alives can reset the HTTP read timeout forever, and this call runs synchronously in
# the build's final enrichment phase — without this, the graph job never settles and rebuilds
# only join the stuck job. Each call gets its own DAEMON thread (not a bounded pool): a
# stalled thread can't be killed, so pooled workers would be consumed permanently and
# ThreadPoolExecutor's interpreter-exit join would hang server shutdown on them; a daemon
# thread just dies with the process and nothing ever waits on it.
HARD_DEADLINE_S = 120.0

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


def _first_page(slug: str) -> str:
    """The paper's opening block. Graph-only papers (no git-backed corpus file) keep their
    retrieved text in the graph store — they're exactly the ones OpenAlex can't cover (often
    no reading-list arXiv id), so that fallback matters most for them."""
    return (store.read_full_text(slug)
            or graph_store.read_retrieved_text(slug))[:FIRST_PAGE_CHARS].strip()


def _cache_key(node: dict) -> str | None:
    """A record is only valid for the paper it was read from: key by the versionless arXiv
    id, else by the first-page text's own identity — a graph-only slug can have its stored
    text replaced by a different confirmed paper (retrieval_sources) without any id or force
    changing, and a slug-only key would then republish the old paper's people. None = no
    identity at all (nothing to extract from either)."""
    base = store.arxiv_base_id(node.get("arxiv_id") or "")
    if base:
        return base
    text = _first_page(node["slug"])
    if not text:
        return None
    return "text:" + hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:16]


def extract(slug: str, *, complete=None, text: str | None = None) -> list[dict] | None:
    """[{name, affiliation}] read off the paper's own first page, or None when there is no
    cached text / the model call fails (both retried on the next build). An empty list means
    the pass RAN and found nothing — that IS cached, so a paper with a truly bare header
    isn't re-billed every build."""
    text = _first_page(slug) if text is None else text
    if not text:
        return None
    complete = complete or llm.complete
    try:
        raw = complete([{"role": "user", "content": _PROMPT.format(text=text)}],
                       temperature=0, max_tokens=800, timeout=60,
                       operation="affiliations")
    except llm.LLMError as e:
        log.info("affiliation extraction failed for %s: %s", slug, str(e)[:120])
        return None
    return _parse(raw)


# Stalled workers can't be killed; they're daemons so they die with the process, but a
# provider that stalls forever must not accumulate one live thread per rebuild either — the
# guard below skips the pass while any previous orphan is still alive.
_orphans: list[threading.Thread] = []
_orphans_lock = threading.Lock()


def _orphan_alive() -> bool:
    with _orphans_lock:
        _orphans[:] = [t for t in _orphans if t.is_alive()]
        return bool(_orphans)


def _extract_with_deadline(slug: str, complete) -> tuple[bool, list[dict] | None]:
    """Run one extraction under the wall-clock deadline: (timed_out, ships). The worker
    thread doesn't inherit contextvars, so the project is rebound (invariant 2) or usage
    lands on the wrong ledger. In-thread failures land as a retryable miss, never an
    exception on the build thread. A timed-out worker is remembered so later passes don't
    stack new threads on top of a provider that never returns."""
    pid = config.active_project_id()
    result: dict = {}

    def _do():
        token = config.set_active_project(pid)
        try:
            result["ships"] = extract(slug, complete=complete)
        except Exception as e:  # noqa: BLE001 — retryable miss, logged, never raised
            log.info("affiliation extraction errored for %s: %s", slug, str(e)[:120])
        finally:
            config.reset_active_project(token)

    worker = threading.Thread(target=_do, daemon=True, name="affiliations")
    worker.start()
    worker.join(HARD_DEADLINE_S)
    if worker.is_alive():
        with _orphans_lock:
            _orphans.append(worker)
        log.info("affiliation extraction timed out for %s", slug)
        return True, None
    return False, result.get("ships")


def annotate_project_affiliations(nodes: list[dict], openalex_cache: dict, cache: dict, *,
                                  complete=None, force: bool = False,
                                  persist=None) -> None:
    """Fill the affiliation gaps OpenAlex left, one LLM pass per uncovered project paper,
    then apply the cache to nodes. Never raises — enrichment must never fail a build.
    (Tests stub _extract_missing, mirroring citations._fetch_missing, so builds stay
    LLM-free; the apply step still runs for real.)"""
    try:
        _extract_missing(nodes, openalex_cache, cache, complete=complete, force=force,
                         persist=persist)
    except Exception:  # enrichment only — never fail the build
        pass
    apply_cached(nodes, cache)


def _extract_missing(nodes: list[dict], openalex_cache: dict, cache: dict, *,
                     complete=None, force: bool = False, persist=None) -> None:
    """Run the LLM pass for project papers the provider left without any institution.

    Provider-first: a node whose OpenAlex authorships carry ANY affiliation is skipped — the
    provider record wins and no tokens are spent. Cache entries are keyed to the node's
    versionless arXiv id (falling back to the slug) so an identity correction invalidates
    them, mirroring openalex.annotate_project_authors. `force=True` re-extracts everything.
    `persist` (when given) is called after each successful cache write, so a paid extraction
    survives a mid-pass restart instead of being billed again next build. The first timeout
    aborts the pass — a stalled provider must not cost the deadline once per paper — and a
    still-alive orphan from a previous pass skips this one entirely."""
    if _orphan_alive():
        log.info("a previous affiliation call is still stalled — skipping enrichment "
                 "this build")
        return
    for node in nodes:
        if node.get("kind") != "project" or not node.get("slug"):
            continue
        provider_ships = (openalex_cache.get(node["id"]) or {}).get("authorships") or []
        if any(s.get("affiliation") for s in provider_ships):
            continue  # provider-first: OpenAlex has institution data for this paper
        key = _cache_key(node)
        if key is None:
            continue  # no identity and no text — nothing to extract from
        hit = cache.get(node["id"])
        if not force and hit and hit.get("key") == key:
            continue
        timed_out, ships = _extract_with_deadline(node["slug"], complete)
        if timed_out:
            log.info("provider stalled — skipping affiliation enrichment this build")
            break
        if ships is None:
            if hit and hit.get("key") != key:
                cache.pop(node["id"], None)  # never keep another paper's affiliations
            continue
        cache[node["id"]] = {"status": "done", "key": key, "authorships": ships}
        if persist is not None:
            try:
                persist()
            except Exception:
                log.warning("could not persist affiliation cache for %s", node["id"])


def apply_cached(nodes: list[dict], cache: dict) -> None:
    """Fill `authors` on project nodes the provider missed entirely, from records keyed to
    the node's current identity — so those papers' people reach the board at all."""
    for node in nodes:
        if node.get("kind") != "project" or node.get("authors") or not node.get("slug"):
            continue
        hit = cache.get(node["id"])
        if not hit:
            continue
        key = _cache_key(node)
        if hit.get("key") != key:
            continue
        node["authors"] = [s["name"] for s in hit.get("authorships") or [] if s.get("name")]
