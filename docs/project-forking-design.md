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
| Session transcript + retry branches (`sessions/<slug>*`, committed history) | moves (it is work done on that paper) | copies into an independent destination history; source history remains intact |
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
R8.2 shipped phase 1; R8.3 ships the two proposal jobs and their controls.

1. **Split (plain POST — fast, no LLM, no network).**
   `POST /api/projects/{pid}/split` with
   `{name, goals?, slugs: [...], remove_from_source: bool,
   draft_destination_notes: bool, cleanup_source_notes: bool}`:
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
2. **Destination working notes (background jobs + sequential approval)** — when
   `draft_destination_notes`: the client immediately enters Working Notes and reviews one
   migrated paper at a time. Each background job integrates only that paper's committed Notes
   into the destination's then-current `working-notes.md`; Apply commits it before the next
   paper starts, while Discard advances without writing. For a new project the first pass
   builds on the starter document; for an existing project every pass preserves and extends
   the current synthesis. Nothing reaches the record unapproved (invariant 4).
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
optimistic-concurrency shape as U.14's `proposal_revision`. Completed proposals remain
recoverable through the latest-job endpoint until the user applies or discards them.

## UI (mobile first)

- **Library multi-select:** long-press a paper row → checkboxes (the chat long-press
  vocabulary). Action bar: **"Split to new project…"**.
- **The sheet:** new-project name; optional one-line goals ("what is this project about?" —
  prefills discovery and grounds profile/lab passes); toggles per the three choices above;
  a summary line stating plainly what will happen ("Move 6 papers and their notes,
  discussions and caches to '<name>'; propose a cleanup of this project's working notes").
  Confirm → POST → switch to the new project with the notes-draft job visible in the
  existing job-status UI. Completion toasts ride the R6.5 toast machinery.
- The two AI toggles appear only when at least one selected paper has committed Notes. This is
  the practical evidence that the paper was read and could have influenced working notes;
  unread metadata-only papers do not trigger a misleading cleanup offer. Source cleanup is
  additionally hidden for copy operations and safely skips when the source has no working notes.
- **Second entry point:** the R7.5 project-settings panel gains "Split project…", which
  routes to the Library in selection mode.
- Web follows only if trivial (the endpoint is client-agnostic).

## Deliberate boundaries

- **Copy duplicates paper work into an independent destination record** — transcript,
  retry branches, session state, Notes, corpus, and per-paper graph caches all travel. The
  source remains untouched; subsequent conversations and commits diverge per project.
- **No AI merge of two projects** (the reverse) — out of scope until splitting earns it.
- **No partial-notes surgery on per-paper Notes** — they are the paper's record and travel
  atomically with it. Only working notes get LLM-mediated rewrites, always via approval.
- The old draft's "archive source papers" option (open question #2) is dropped — the
  clarified use case is thematic relocation, not thinning.

## R9.13 — move into an EXISTING project (not just a new one)

The device pass asked for the Library multi-select menu to read as standard actions: a general
**Move** (to a *new* project — the split — OR an *existing* one) plus **Delete**. The backend
gains `project_split.move_to_existing` + `POST /api/projects/{pid}/move`, the deterministic
sibling of the split. It reuses the shared gather/populate/remove helpers; the differences are
all load-bearing:

- **Destination validation + slug-collision refusal.** The destination must exist and differ
  from the source. A slug is refused if the destination already has its data — a reading-list
  entry, **retained session metadata**, OR retained on-disk records (the removal endpoint keeps
  a removed paper's corpus/transcript/branches on disk, so a slug absent from the reading list
  can still own work; writing over it would destroy the destination's history). All-or-nothing.
- **Slug validation before path-building.** `slugs` is client input, fed into corpus/transcript
  path helpers by the collision check, so every slug is checked against the source's current
  entries up front — a non-entry value (including a `../x` traversal) is rejected before any
  filesystem access.
- **Cite-keep set** = moved slugs ∪ the destination's existing reading-list slugs, so a moved
  paper's cite to a paper already in the destination survives as a live edge.
- **Pathspec commit** (not `add -A`) into the populated destination — it has unrelated files.
- **Graph staleness (forward).** `graph.status` now flags a project paper with no node in an
  existing built graph (guarding on graph *existence*, so an empty-node graph still counts):
  a moved paper carries a fresh copied extraction, so without this it looked up to date yet was
  silently missing from the destination's Map with no rebuild offered.

**Concurrency (with the task-#75 lock, which this builds on).** The `/move` route reserves BOTH
projects busy and sweeps jobs on both; `move_to_existing` then takes each project's
**exclusive write lock** (sorted, so two moves can't deadlock), draining any synchronous writer
already in flight — the same protection the split gained, now on both sides. All synchronous
record-writers (add/remove/approve/notes-save/upload_paper) hold the shared side of that lock, so
none can start or be mid-commit while a move holds the exclusive side; retrieval itself persists
through the guarded background-job path.

**Transactional move (rollback on failure).** A move writes+commits the destination, then
removes+commits the source across two git repos. On any failure the destination is rolled back
to its pre-move state — undo its commit (`reset --soft` to the captured HEAD, *not* `--hard`,
which would discard the destination's own uncommitted work), delete the moved-in files (all new
there), restore the reading-list bytes + graph caches — so a retry isn't blocked by the
collision check. A source-removal failure additionally restores the source (its data is safe in
the destination regardless, since population precedes removal).

## Later: sharing projects as reading lists (U.25 vision — recorded, not scheduled)

Unchanged from the first draft, and still a reason to build the migration path cleanly: a
project IS a self-contained markdown git repo, so a published "reading list" is a snapshot
of `reading-list.md` (optionally with Notes), and importing one is a split-shaped copy into
a fresh local project. Marketplace concerns (publishing, discovery, identity, versioning,
notes-privacy) stay future work and should not shape v1 beyond keeping `project_split.py`'s
copy path reusable.

## Decisions now implemented

- Remove-from-source defaults on; copy remains available.
- Transcripts and session state travel on both Move and Copy; Copy leaves an independent source
  history in place.
- Cleanup is working-notes-only, always an AI proposal requiring explicit apply.
