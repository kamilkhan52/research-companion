# Canonical per-paper pass — design (R12.9, subsumes R12.11/D06)

**Status:** design only, no code. Written for a fresh implementing agent (GPT-5.6-sol).
**This plan is a starting point, not a spec to execute verbatim.** It encodes the current
architecture accurately (file/line references were true at authoring) and a recommended shape,
but the implementing agent is expected to **revise it** where the code has moved or a cleaner
seam exists — update this doc as you go so it stays the source of truth. Open questions are
called out inline; resolve them with Kamil or with a defensible default and note the choice.

## The problem (I2 + D05 + D06)

One paper's full text is analyzed by **several independent LLM/enrichment passes that fire at
different times and persist to different caches**, so the per-paper picture the app shows can be
internally inconsistent ("divergent per-surface passes"):

| Pass | Trigger (today) | Persists to | Producer |
|---|---|---|---|
| First-page **affiliations** | retrieval completion (`figures.warm_async` sibling) | `.state/paper-metadata.json` | `affiliation_jobs.warm_async` → `affiliations.py` |
| **Figures** | retrieval completion | `.state/figures/` | `figures.warm_async` |
| **Cover** (page-1 PNG) | retrieval completion | `.state/covers/<slug>.png` | `cover_jobs.render_from_pdf` |
| **References + citing contexts + significance** | **Map build only** | `.state/reference-graph.json` (per-paper `extractions`) | `graph.extract_references_for_paper` |
| Provider metadata (S2/OpenAlex identity, citation counts) | Map build | reference-graph cache | `graph.fetch_semantic_scholar_metadata` / `merge_reference_sources` |
| The **opening summary** itself | first discussion turn | transcript | `agent` / `agent_harness` via `assembler.build_context` |

Two concrete failures this caused on the 2026-07-21 device pass:

- **D05:** affiliations arrived *late* / diverged from what the Map build later showed — two
  passes over the same first page at different times.
- **D06 (this is R12.11):** the opening summary could not explain how *later project papers cite
  the opened paper*, because the incoming-citation **contexts** (the verbatim citing sentences)
  only exist after a full **Map build** extracts the *citing* papers' references. The mechanism
  to consume them already exists — `assembler.build_context` calls
  `graph.project_citers_for(slug)` (assembler.py:100) and renders each citer's `contexts` into
  the opening prompt (assembler.py:119). It returned empty because the graph edges for the tested
  paper had no `contexts` (the citing papers weren't full-text-extracted, or the extraction
  didn't capture the citing sentence, or `match_project_paper` didn't link them).

## The key insight (what makes this tractable)

Most of the hard machinery **already exists and is already deterministic**:

- `graph.extract_references_for_paper(slug, title, full_text, model)` (graph.py:225) is *the one
  LLM call* — it returns a paper's bibliography with per-reference `contexts` (verbatim body
  excerpts showing how it cites each work) and a `significant` flag. Its result is cached per
  paper, **fingerprinted by `content_hash`** of the full text (graph.py:231's `_result`).
- **Graph *construction* is already a pure, no-LLM function of those cached extractions** —
  graph.py:534 "graph construction (pure function of cached extractions; no LLM)". Cross-paper
  matching (`match_project_paper`, `titles_match`, `external_ref_key`) turns each paper's own
  bibliography into project→project edges deterministically.
- `paper_metadata.py` already exists precisely to hold "small derived per-paper metadata that
  becomes available outside a full Map build," guarded and fingerprinted, explicitly so "a later
  Map build reuses the same fingerprinted record instead of paying for the extraction again."
- `graph.covered_by_fresh_extraction` (graph.py:1085) already answers "which papers have a fresh
  cached extraction" without calling the LLM.

So the expensive work is **already cacheable and already reused** — it's just **triggered at the
wrong time** (Map build) for one of the passes, and **scattered across two caches**. R12.9 is
mostly a *sequencing + consolidation* change, not new extraction science.

## The core move

**Run the reference/context extraction as part of a single canonical pass at first full-text
availability — the same moment affiliations/figures/cover already warm — instead of deferring it
to Map build.** Then every surface reads from one fingerprinted canonical record, and a Map
"build" degrades to deterministic assembly (+ optional provider enrichment) over records that
already exist.

Concretely:

1. **Define one canonical per-paper record** keyed by slug and fingerprinted by full-text
   `content_hash`. It aggregates what today lives in `paper-metadata.json` (affiliations) and the
   reference-graph `extractions` (bibliography + contexts + significance), plus figure/cover
   availability pointers. Recommended home: **extend `paper_metadata.py`** (it already owns the
   fingerprinted, guarded, atomic-write cache and the "reuse across Map build" contract) rather
   than inventing a new file. Bump its `_VERSION` and add an `extractions`/`references` section
   alongside `affiliations`. Keep it **gitignored working state** (like the reference graph and
   covers) — it is recomputable from committed full text, so it is not part of invariant-4 record.

2. **One coordinator on first full-text availability.** Today `retrieval_jobs._persist` fires
   `figures.warm_async(slug)` + `affiliation_jobs.warm_async(slug)` (retrieval_jobs.py:263-264;
   also 80-81 on the streaming path). Add the reference extraction to that same warm fan-out (a
   `graph_extract_jobs.warm_async(slug)` or fold into a single `canonical_pass` coordinator).
   The pass must also fire for papers whose full text arrives by other routes (PDF upload, manual
   fetch) — audit every `store.write_full_text` caller, not just `retrieval_jobs`.

3. **Map build consumes, never re-extracts.** With per-paper reference extractions produced at
   first read, `graph_jobs` becomes: ensure every project paper has a fresh canonical extraction
   (trigger the pass for any that are stale/missing — this is the only place that still might do
   LLM work, for papers added before this feature), then run the existing pure construction +
   provider enrichment. `covered_by_fresh_extraction` already tells it what's missing.

4. **D06/R12.11 falls out for free** once each paper's references+contexts are extracted at its
   own first read: by the time a *later* paper is opened, the *earlier* cited papers already have
   edges, and the later citing papers get their contexts at *their* first read. `project_citers_for`
   then returns populated `contexts` without requiring a manual full Map build first. **Verify
   this against a live repro** — see "R12.11 acceptance" below.

5. **Concise progress steps during first read.** The pass is several sub-jobs; surface a short,
   truthful, template-driven step line ("Reading first page… · Mapping references… · Finding
   figures…"), reusing the existing job-snapshot polling (invariant 1). Do **not** invent a new
   progress protocol — piggyback on the retrieval/opening job the client already polls. Keep the
   phrasing template-driven per the D02 secondary-polish note (no fabricated specifics).

## Invariants this must respect (CLAUDE.md)

- **Invariant 1** — every LLM/minutes-long sub-pass stays a background job + poll; the canonical
  pass is a fan-out of jobs, never a blocking call. Follow `affiliation_jobs`/`graph_jobs` shape.
- **Invariant 2** — each job runner rebinds `config.set_active_project(pid)` before touching
  store/caches and resets in `finally`. The warm-fan-out coordinator spawns per-project jobs.
- **Invariant 3** — `store.py` stays pure/deterministic; no LLM or network moves into it. The
  canonical record lives in a `.state` cache module, not the store.
- **Invariant 4** — nothing here commits to git without approval. The canonical record is
  gitignored working state derived from the already-committed full text; it never enters the git
  record. (Notes still flow through the approval path unchanged.)
- **Invariant 6** — single worker; the cache stays in-process guarded (`paper_metadata._lock`
  precedent) and atomic-written.

## Fingerprinting & races (the load-bearing details)

- The record is keyed `(slug, content_hash)`. A pass writing an older extraction after newer full
  text landed must **no-op** — `paper_metadata.set_affiliation_record` already implements exactly
  this with `expected_key` (paper_metadata.py:~58); mirror it for the references section. This is
  the same "slow older extraction is harmless" guard the existing code documents.
- The reference-graph cache is "rewritten throughout a long graph build," which is *why*
  `paper_metadata.py` exists as an independent cache (see its module docstring). Keep the
  canonical record independent of the reference-graph file's write cycle for the same reason;
  the Map build *reads* canonical records and *writes* the assembled graph.
- Concurrency: a first-read pass and a Map build can run together. The Map build must treat
  missing/stale canonical records as "extract now," and a canonical pass completing mid-build
  must not corrupt the build's snapshot — build off a captured set, like graph jobs already do.

## Migration / backfill

Papers added before this ships have affiliations in `paper-metadata.json` and references only in
`reference-graph.json` (if a Map was ever built). On first access after upgrade, treat a paper
with no canonical references section as stale and trigger the pass; if a reference-graph
extraction already exists for it, **import it into the canonical record** rather than re-paying
for the LLM call (its `content_hash` tells you if it still matches the current full text).

## R12.11 acceptance (do this with live data, not a unit test)

D06/R12.11 is a **data-coverage** bug, not a wiring bug — the assembler→prompt path is correct.
So the acceptance test is a live repro, which is why it was flagged "needs Kamil / live-data":

1. In a project where later papers genuinely cite an earlier one, read the earlier paper, then
   read 2-3 later citing papers (so their canonical extractions run).
2. Open the earlier paper fresh and confirm the opening summary explains the incoming citations,
   distinguishing substantive vs background, grounded only in the extracted `contexts`.
3. If it's still empty, instrument *where* it breaks: does `project_citers_for` return rows?
   (matching failed → look at `match_project_paper`/`titles_match`/`external_ref_key`.) Do the
   rows have empty `contexts`? (extraction didn't capture citing sentences → look at the
   `graph_extraction` prompt in prompts.py and `_clean_reference`'s `contexts` handling,
   graph.py:219.) **Do not blind-patch the extraction prompt** without a repro showing which link
   fails — that was the explicit prior guidance.

## Deliberate boundaries / non-goals

- **Not** collapsing the *analysis turn* (the opening summary generation) into the canonical
  pass. The turn stays a separate discussion turn (marker protocol, invariant 5); it *consumes*
  the canonical record via the assembler. The canonical pass is enrichment/extraction only.
- **Not** changing the marker output protocol or making anything JSON (invariant 5).
- **Not** committing the canonical record to git — it's recomputable working state.
- Provider (Semantic Scholar / OpenAlex) enrichment stays a Map-build-time concern; it needs the
  whole project set and external calls. Only the *full-text-derived* extraction moves earlier.

## Open questions for the implementing agent

1. **One coordinator job vs. independent warm jobs?** A single `canonical_pass` job that owns the
   step-progress line is cleaner for the "concise progress" UX, but independent jobs
   (`figures`/`affiliations`/`references`) parallelize and already exist. Recommendation: keep the
   independent jobs, add a thin coordinator that *reports aggregate progress* by polling their
   snapshots — but confirm the progress UX reads well before committing to it.
2. **Should first-read reference extraction run for every paper, or lazily on first Map/open?**
   Eager (at retrieval) makes D06 "just work" but spends tokens on papers that may never be
   Mapped. Lazy-but-early (on first *open* of the discussion) is cheaper and still beats
   Map-build timing. Recommendation: trigger on first full-text availability *of a paper that
   gets opened for reading*, not merely added — but measure token cost with Kamil's usage in mind
   ([[round12-queue]] I1 notes agentic cost is only partly trackable).
3. **Schema:** exact shape of the unified record — reuse the reference-graph `extractions` entry
   shape verbatim (so import is a copy) or normalize? Recommend reuse to minimize translation.
4. Where does figure/cover *availability* belong — in the canonical record as pointers, or left
   in their own caches with the record only referencing slugs? (Leaning: leave the binaries in
   `.state/figures`/`.state/covers`, record only readiness flags.)

## Suggested phasing

- **P1:** Unified canonical record in `paper_metadata.py` (schema + fingerprint + reference
  section + backfill import from reference-graph). No behavior change yet — Map build writes both.
- **P2:** Move reference extraction to first-read warm fan-out; Map build switches to
  consume-or-extract-if-missing. Add aggregate progress steps.
- **P3:** Live D06/R12.11 acceptance with Kamil; fix whichever matching/context link is thin.
- **P4:** Retire the now-redundant second affiliation pass; single source of truth confirmed.

Related: [[round12-queue]] (I2, R12.9, R12.11/D06), `docs/round12-queue.md`,
`docs/canonical-title-identity-design.md` (R12.13 — a *different* "canonical title" concern, do
not conflate), CLAUDE.md invariants 1-6.
