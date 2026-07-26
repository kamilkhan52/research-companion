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

from . import config, graph_store, llm, logging_config, paper_metadata, store
from .jobs import Job, JobRegistry, new_id

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
    """A record is only valid for the exact text it was read from: key by the versionless
    arXiv id (when known) PLUS the first-page text's hash. The text part matters in both
    directions — a graph-only slug can have its stored text replaced by a different confirmed
    paper (retrieval_sources) without any id changing, and an arXiv paper's corpus can hold a
    placeholder ("(full text not cached)") when the pass runs, whose bogus result must not
    outlive the real PDF's arrival. None = no text at all (nothing to extract from)."""
    text = _first_page(node["slug"])
    if not text:
        return None
    base = store.arxiv_base_id(node.get("arxiv_id") or "")
    digest = hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:16]
    return f"{base or 'text'}:{digest}"


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
_orphan_registry: JobRegistry[Job] = JobRegistry(
    "affiliation-orphans",
    max_finished=10,
)


def _orphan_alive() -> bool:
    with _orphans_lock:
        _orphans[:] = [t for t in _orphans if t.is_alive()]
        return bool(_orphans)


def _track_orphan(worker: threading.Thread) -> bool:
    """Keep a timed-out child visible to project move/delete admission until it exits.

    Python cannot stop a stuck thread. The child can still return through ``llm.complete`` and
    record usage under the project, so forgetting it when the graph/affiliation parent settles
    would let a move or delete pull its directory away first. A tiny project-bound registry job
    owns that remaining lifetime. If admission loses an unlikely deletion race, the caller
    keeps its own parent alive by joining the child instead.
    """
    orphan_id = new_id()
    try:
        _orphan_registry.start_or_join(
            orphan_id,
            lambda: Job(id=orphan_id),
            lambda _job: worker.join(),
            allow_busy=True,
        )
    except RuntimeError:
        return False
    return True


def _extract_with_deadline(slug: str, complete) -> tuple[bool, list[dict] | None]:
    """Run one extraction under the wall-clock deadline: (timed_out, ships). The worker
    thread doesn't inherit contextvars, so project AND user are rebound (invariant 2, via
    `config.bound_scope`) — without the project, usage lands on the wrong ledger; without the
    user, `llm.complete` takes its default model from the instance settings rather than from the
    preferences of whoever asked for the work. In-thread failures land as a retryable miss, never an
    exception on the build thread. A timed-out worker is remembered so later passes don't
    stack new threads on top of a provider that never returns."""
    pid = config.active_project_id()
    uid = config.active_user_id()
    result: dict = {}

    def _do():
        with config.bound_scope(pid, uid):
            try:
                result["ships"] = extract(slug, complete=complete)
            except Exception as e:  # noqa: BLE001 — retryable miss, logged, never raised
                log.info("affiliation extraction errored for %s: %s", slug, str(e)[:120])

    worker = threading.Thread(target=_do, daemon=True, name="affiliations")
    worker.start()
    worker.join(HARD_DEADLINE_S)
    if worker.is_alive():
        with _orphans_lock:
            _orphans.append(worker)
        if not _track_orphan(worker):
            # A deletion tombstone can reject the follow-on lifecycle job. Do not let the
            # current project-bound parent settle while its child can still touch that project.
            worker.join()
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
    them, mirroring openalex.annotate_project_authors. `force=True` re-extracts graph-only cache
    entries, but a fresh canonical first-read record remains authoritative (P4).
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
        key = _cache_key(node)
        prefetched = paper_metadata.affiliation_record(node["slug"])
        prefetched_fresh = (
            key is not None
            and prefetched
            and prefetched.get("status") == "done"
            and prefetched.get("key") == key
        )
        if prefetched_fresh:
            cache[node["id"]] = {
                "status": "done",
                "key": key,
                "authorships": prefetched.get("authorships") or [],
            }
        hit = cache.get(node["id"])
        provider_ships = (openalex_cache.get(node["id"]) or {}).get("authorships") or []
        if any(s.get("affiliation") for s in provider_ships):
            # Provider-first: OpenAlex has institution data for this paper — but never leave
            # behind a record the current identity can't verify, because author_board still
            # merges LLM records for the authors the provider lacks.
            if hit is not None and hit.get("key") != _cache_key(node):
                cache.pop(node["id"], None)
            continue
        if key is None:
            if hit is not None:
                cache.pop(node["id"], None)  # no text = no identity — never keep a record
            continue
        if prefetched_fresh:
            # The canonical first-read result is authoritative even on a force Map refresh;
            # force still refreshes providers/layout, but never buys a divergent second pass.
            continue
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
        # Retrieval can replace the paper text while this paid call is in flight. Serialize the
        # final fingerprint check with full-text persistence and every independent-cache write;
        # an old result then cannot replace a newer pending/result record.
        with config.project_write_guard(config.active_project_id()), \
                config.paper_identity_guard(node["slug"]):
            if _cache_key(node) != key:
                continue
            paper_metadata.set_affiliation_record(
                node["slug"],
                {"status": "done", "key": key, "authorships": ships, "error": None},
            )
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


def _top_affiliations(
    slug: str,
    graph_data: dict,
    prefetched_records: dict[str, dict],
    limit: int,
) -> list[str]:
    paper = store.get_paper(slug)
    if paper is None:
        return []
    node = {
        "id": slug,
        "kind": "project",
        "slug": slug,
        "arxiv_id": paper.arxiv_id or None,
    }
    key = _cache_key(node)
    provider = (graph_data.get("openalex", {}).get(slug) or {})
    if (
        paper.arxiv_id
        and provider.get("arxiv_id") != store.arxiv_base_id(paper.arxiv_id)
    ):
        provider = {}
    llm_record = graph_data.get("llm_affiliations", {}).get(slug) or {}
    if key is None or llm_record.get("key") != key:
        llm_record = {}
    prefetched = prefetched_records.get(slug) or {}
    if key is None or prefetched.get("key") != key or prefetched.get("status") != "done":
        prefetched = {}

    # Provider wins for an author it covers; the first-page pass fills the remaining authors.
    by_author: dict[str, str] = {}
    for record in (provider, llm_record, prefetched):
        for ship in record.get("authorships") or []:
            name = " ".join(str(ship.get("name") or "").split()).casefold()
            affiliation = " ".join(str(ship.get("affiliation") or "").split())
            if name and affiliation:
                by_author.setdefault(name, affiliation)

    counts: dict[str, tuple[str, int]] = {}
    for affiliation in by_author.values():
        normalized = affiliation.casefold()
        display, count = counts.get(normalized, (affiliation, 0))
        counts[normalized] = (display, count + 1)
    ranked = sorted(counts.values(), key=lambda item: (-item[1], item[0].casefold()))
    return [display for display, _ in ranked[:max(0, limit)]]


def top_affiliations(
    slug: str,
    limit: int = 2,
    *,
    graph_data: dict | None = None,
    prefetched_records: dict[str, dict] | None = None,
) -> list[str]:
    """The most common current affiliations for one paper, provider-first and space-bounded."""
    return _top_affiliations(
        slug,
        graph_data if graph_data is not None else graph_store.load(),
        prefetched_records if prefetched_records is not None
        else paper_metadata.affiliation_records(),
        limit,
    )


def paper_summary(slug: str) -> dict:
    """API-facing, bounded affiliation metadata for Library and Discussion headers."""
    return paper_summaries([slug]).get(
        slug,
        {"affiliations": [], "affiliation_status": "idle"},
    )


def paper_summaries(slugs: list[str]) -> dict[str, dict]:
    """Bulk variant used by project state: read each potentially large cache only once."""
    graph_data = graph_store.load()
    prefetched = paper_metadata.affiliation_records()
    out = {}
    for slug in slugs:
        top = _top_affiliations(slug, graph_data, prefetched, 2)
        record = prefetched.get(slug) or {}
        status = "done" if top else (record.get("status") or "idle")
        out[slug] = {"affiliations": top, "affiliation_status": status}
    return out
