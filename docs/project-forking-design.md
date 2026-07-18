# Project splitting — design (U.24, revised 2026-07-17)

**The use case (Kamil, 2026-07-17):** papers get added to a project because they seem
interesting; over time many are interesting but not relevant to the core theme. The user
then selects those papers and **splits them into a new project — moving the papers and any
work done**. Optionally they can **wipe the analysis those papers contributed to the current
project**, and whether the papers are **removed from the current project at all is also the
user's choice**.

This revises the 2026-07-15 draft ("forking"). What changed since it was written and shapes
this revision: per-paper graph work is now a real paid cache worth carrying (extraction
records, retrieved texts, covers — and builds parallelize, R7.11); project management UI
exists (the R7.5 settings panel — a natural second entry point); the jobs layer grew the
`any_running_for_project` sweep and admission tombstones (R7.5) that a split must use; and
new projects now feed goals into discovery, author profiles, and lab research, so the split
sheet should capture the new project's theme. Naming is settled: **Split** (the old doc's
open question #1) — it matches the mental model even when the user chooses to keep copies.

No code ships with this document.

## The three user choices

1. **Remove from source?** (default **on** — the typical case is *moving* off-theme papers
   out). Off = the new project gets copies and the source keeps everything.
2. **Wipe their contribution to the source's working notes?** (only offered when removing;
   default off). An LLM pass proposes the rewrite; the user approves it like any notes
   proposal. Per-paper Notes need no wiping — they live inside the paper's corpus file and
   leave with it.
3. **Draft the new project's working notes with AI?** (default on). Synthesized from the
   migrated papers' Notes, delivered as a proposal in the new project.

## What travels

| Artifact | Move (remove on) | Copy (remove off) |
|---|---|---|
| Reading-list block (title, status, `<!-- arxiv/year/slug/cites -->`, abstract) | verbatim, under its source group heading | same |
| Corpus file incl. committed `## Notes` | moves | copies |
| Session transcript + retry branches (`sessions/<slug>*`, committed history) | moves (it is work done on that paper) | stays in source — duplicating a live discussion would fork its history |
| Per-paper graph caches (`.state/reference-graph.json` record, `.state/graph-corpus/<slug>.txt`, cover PNG) | copied either way — cheap files that save a paid re-extraction on the new project's first build | same |
| Working notes | never move automatically — phases 2/3 below propose changes for humans to approve | same |
| Usage ledger, whole-graph snapshot, session index | stay; the graph and index rebuild lazily like any new project | same |

`<!-- cites -->` entries pointing at papers that did **not** move are dropped from the
migrated copy (they would dangle); with remove-on, cites in *remaining* source papers that
point at departed slugs are dropped the same way. Status markers are preserved as-is — the
paper's Notes travel with it, so a `read` paper arrives genuinely read (the old draft's
"strip notes → reset to unread" coupling is gone along with the migrate-notes toggle it
served; "moving the work done" means notes always travel).

## Flow

Phase 1 is synchronous and deterministic; 2 and 3 are independent LLM background jobs.

1. **Split (plain POST — fast, no LLM, no network).**
   `POST /api/projects/{pid}/split` with
   `{name, goals?, slugs: [...], remove_from_source: bool, draft_new_notes: bool, cleanup_source_notes: bool}`:
   - **Guards:** every requested slug must resolve to a parsed entry of the source's
     current reading list before anything is touched — slugs are caller-supplied and the
     path helpers (`corpus_path`, session/cover paths) compose paths without validating, so
     the reading list is the trust boundary (400 on any unknown slug; the same posture as
     `projects._safe_pid` for pids). And refuse (409) while any background job is running
     for the source project (`jobs.any_running_for_project`, the R7.5 sweep) — a chat turn
     or graph build mid-move would write into files being relocated. The new project's pid
     is admission-checked the moment it exists, like any project.
   - `projects.create_project(name)` scaffolds the new repo (existing path, pinned git
     identity); `goals` lands in its `project.json` so discovery, author profiles, and lab
     research inherit the new theme immediately.
   - File migration per the table above, implemented in a new `app/project_split.py` that
     binds the active-project contextvar per side as it works (the `recent_sessions`
     precedent) — `store.py` stays pure and single-project.
   - **Commits:** the new project gets one scaffold-class commit ("Split N papers from
     <source>") — the same class of app-made commit as project creation. With remove-on, the
     source gets one batched commit through the existing committed-removal semantics
     (`remove_entry` + `append_removed_marker` is not used here — the corpus file leaves
     entirely, so there is nothing to mark; the reading-list edit + file deletions are one
     commit, "Split N papers to <name>"). Both commits happen only after the user's explicit
     in-app confirmation — the same invariant-4 posture as `DELETE /papers/{slug}`, which
     already git-commits directly on confirmed quick actions.
   - The response returns the new pid; the client switches projects (the R7.5 machinery).
2. **New project's working notes (background job + approval)** — when `draft_new_notes`:
   an LLM pass synthesizes a `working-notes.md` proposal from the migrated papers' Notes
   (the assembler already gathers these). Normal proposal → review → approve via
   `committer.py`; nothing reaches the record unapproved (invariant 4).
3. **Source cleanup (background job + approval)** — when `cleanup_source_notes` (implies
   remove-on): an LLM pass proposes the source's working notes with the departed papers'
   contributions removed. Working-notes content is synthesized without per-paper
   attribution, so titles alone can't identify what to remove — phase 1 therefore
   **snapshots the departed papers' Notes blocks before migration** and stages that
   snapshot for this job (`.state/`, working data, never committed). The prompt gets the
   departed titles AND their notes as the reference for what to excise, and forbids
   inventing content — remove and reflow only.

Phases 2–3 are `notes_jobs`-shaped (invariant 1), rebind their project's contextvar
(invariant 2), can run in parallel, and can each be skipped or re-run. Each captures a
**base revision** (hash of that project's `working-notes.md` at job start) that rides on the
proposal; approval rejects with a conflict if the live file changed meanwhile — the same
optimistic-concurrency shape as U.14's `proposal_revision`.

## UI (mobile first)

- **Library multi-select:** long-press a paper row → checkboxes (the chat long-press
  vocabulary). Action bar: **"Split to new project…"**.
- **The sheet:** new-project name; optional one-line goals ("what is this project about?" —
  prefills discovery and grounds profile/lab passes); toggles per the three choices above;
  a summary line stating plainly what will happen ("Move 6 papers and their notes,
  discussions and caches to '<name>'; propose a cleanup of this project's working notes").
  Confirm → POST → switch to the new project with the notes-draft job visible in the
  existing job-status UI. Completion toasts ride the R6.5 toast machinery.
- **Second entry point:** the R7.5 project-settings panel gains "Split project…", which
  routes to the Library in selection mode.
- Web follows only if trivial (the endpoint is client-agnostic).

## Deliberate boundaries

- **No transcript duplication on copy** — a discussion is a conversation in one project's
  context; only a move relocates it, and only wholesale.
- **No AI merge of two projects** (the reverse) — out of scope until splitting earns it.
- **No partial-notes surgery on per-paper Notes** — they are the paper's record and travel
  atomically with it. Only working notes get LLM-mediated rewrites, always via approval.
- The old draft's "archive source papers" option (open question #2) is dropped — the
  clarified use case is thematic relocation, not thinning.

## Later: sharing projects as reading lists (U.25 vision — recorded, not scheduled)

Unchanged from the first draft, and still a reason to build the migration path cleanly: a
project IS a self-contained markdown git repo, so a published "reading list" is a snapshot
of `reading-list.md` (optionally with Notes), and importing one is a split-shaped copy into
a fresh local project. Marketplace concerns (publishing, discovery, identity, versioning,
notes-privacy) stay future work and should not shape v1 beyond keeping `project_split.py`'s
copy path reusable.

## R9.13 — generalize Split into "Move" (new OR existing project)

The device pass asked for the Library multi-select menu to read as standard actions: a general
**Move** (to a *new* project — today's split — OR an *existing* one) plus **Delete** alongside
it. The backend gains a move-to-existing variant; the deterministic phase-1 machinery is
otherwise identical to the split, so this is an extraction, not a rewrite.

**Backend (`project_split.py`).** Factor the population + source-removal out of
`split_project` into a shared core, then add `move_to_existing(source_pid, dest_pid, slugs, *,
remove_from_source=True)`. The differences from the new-project path, all load-bearing:

- **Destination validation:** `dest_pid` must exist, differ from the source, and not be
  deleting/busy — checked, then reserved with `mark_project_busy(dest_pid)` for the population
  window (same reason the split marks the fresh pid busy: a client refresh + graph/retrieval
  job mid-population would read a half-written reading list).
- **Slug-collision refusal:** if any moved slug already exists in the destination's reading
  list, refuse the whole move with a clear error (a duplicate entry would corrupt the list).
  All-or-nothing — no partial move.
- **Cite-keep set:** the split keeps `set(slugs)` (cross-refs to non-moved papers drop). A move
  into a populated project keeps `slugs ∪ destination's existing slugs`, so a moved paper's
  cite to a paper *already in the destination* survives as a live edge.
- **Commit by pathspec, not `add -A`:** the destination has unrelated (possibly dirty) files,
  so its commit stages exactly the paths we wrote — `reading-list.md` + each moved
  `corpus/<slug>.md` + (on move) `sessions/<slug>.jsonl`. The scaffold path keeps `add -A`
  (everything in a fresh repo is split-owned). `.state/*` (covers, graph caches, branches) is
  gitignored in both.
- **Same locks + source removal:** hold each moved slug's `mutation_lock` across snapshot +
  removal (unchanged), and reuse `_remove_from_source` verbatim.

The route: `POST /api/projects/{pid}/move` with `{dest_pid, slugs, remove_from_source}`,
guarded exactly like `/split` (deleting/busy 409s, jobs sweep). `/split` stays for
move-to-new. Mobile: the multi-select bar's single "Split" action becomes a **Move** action
opening a small chooser (New project… → the existing Split sheet; or pick an existing project
→ confirm) plus a **Delete** action reusing the per-paper removal flow in a batch.

**R8.3 nuance carries over:** the source working-notes cleanup pass (a later PR) is offered
only when the moved papers actually influenced the working notes — for a move to an existing
project just as for a split. The move endpoint returns the same `departed_notes` map to feed it.

**Concurrency — what the move guards, and a known residual.** The move reserves BOTH projects
busy, sweeps background jobs on both, holds each moved slug's `mutation_lock` across
snapshot+removal, and (this PR) gates the synchronous `add`/`remove`/`start`/`start_stream`/
`approve` routes on the busy flag at entry (retroactively hardening the split too). It also refuses a destination
that already has the slug's data (reading-list entry OR retained on-disk records) and validates
every slug against the source's entries before any path building. **Residual, matching the
shipped split (#147):** the busy flag is checked at each synchronous route's *entry*, and no
lock is held across a writer's whole operation, so a request that passed its check can still be
mid-flight when the move starts (e.g. a `/start` retrieval that began just before the
reservation, or a destination `/approve` whose `git add -A` commit overlaps the population
window). Fully closing this needs a **project-wide synchronous-writer mutation lock (or
in-flight registry)** applied uniformly to split and move — a cross-cutting hardening tracked
separately, not scoped into the move feature. For the single-household, single-worker
deployment (invariant 6) the interleaving requires two conflicting record mutations on one
project inside the sub-second population window, so it is deferred, not ignored.

## Open questions for Kamil

1. **Defaults check:** remove-from-source defaults **on** (move semantics, per "moving the
   papers and any work done") — right call, or default to the safer copy?
2. **Transcripts on move:** this draft moves them (they are work done). If you'd rather
   discussions always stay archived in the source, phase 1 gets simpler still.
3. **Wipe scope:** is the source cleanup pass (phase 3) working-notes-only, as specced? Or
   did "wipe any analysis contributed" also mean e.g. the source's graph caches for the
   departed papers (those are dropped automatically on the next build either way)?
