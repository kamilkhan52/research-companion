# Project forking — design (U.24)

Kamil's framing (2026-07-15): a project can grow too large and *feel* like it should be
multiple projects. The user selects papers from an existing project and adds them all to a
new one; chooses whether to migrate the per-paper notes; and the working notes of **both**
projects get updated — the source's to remove content about the departed papers, the new
project's to be synthesized from the imported notes. His instinct: a basic implementation of
"create project from selected papers + AI-assisted notes migration" is the right v1.

This document is the reviewable plan for that v1. No code ships with it.

## What v1 does

One flow, three phases — only the first is synchronous:

1. **Fork (plain POST, fast, deterministic).** `POST /api/projects/{pid}/fork` with
   `{name, slugs: [...], migrate_notes: bool, remove_from_source: bool}`:
   - `projects.create_project(name)` scaffolds the new repo (existing code path).
   - Each selected entry's reading-list **block is copied verbatim** (title, status marker,
     `<!-- arxiv/year/slug/cites -->` comments, abstract paragraph) under its source group
     heading, so identity/metadata survive exactly. `<!-- cites -->` references to papers
     that did NOT move are dropped from the copy (they'd dangle).
   - Corpus files for the selected slugs are copied; with `migrate_notes=false` the
     `## Notes` block is stripped from the copy (full text is cache, notes are the record).
   - The new project gets one initial git commit ("Forked N papers from <source>") — the
     same class of app-made commit as project scaffolding itself.
   - Session transcripts, audio caches, and graph caches do **not** move: transcripts stay
     the source project's history; caches rebuild lazily like any new project.
   - `remove_from_source=true` reuses the existing per-paper removal flow (notes kept +
     removal marker, committed) — same semantics as removing a paper by hand today.
2. **New project's working notes (background job + approval).** An LLM pass synthesizes a
   `working-notes.md` proposal from the imported per-paper Notes (assembler already knows how
   to gather these). It lands as a **proposed** synthesis the user reviews and approves in
   the new project — the normal `committer.py` path; nothing reaches the record unapproved
   (invariant 4).
3. **Source project's working notes (background job + approval).** A second LLM pass
   proposes a rewrite of the source's working notes with the migrated papers' contributions
   removed (prompt lists the departed titles; the model must not invent content, only
   remove/reflow). Also a proposal → review → approve, in the source project.

Phases 2–3 are `notes_jobs`-shaped background jobs (invariant 1) with the active-project
contextvar bound to their respective projects (invariant 2) — they are independent, can run
in parallel, and either can be skipped or re-run.

## UI (mobile first)

- Library gains a multi-select mode (long-press a paper row → checkboxes; the same gesture
  vocabulary as the chat long-press menu). Action bar: **"Fork to new project…"**.
- The sheet: project-name field, toggles for *Migrate notes* (default on), *Remove from
  source* (default off), *Draft working notes with AI* (default on). Confirm → POST fork →
  navigate to the new project with the notes-drafting job running (existing job-status UI).
- Web follows only if trivial (the fork endpoint is client-agnostic).

## Deliberate v1 boundaries

- **Copy, not move, by default.** Removal is opt-in and uses the existing committed-removal
  flow; nothing destructive happens implicitly.
- **No transcript migration.** Discussions are conversations *in a project's context*; the
  new project starts fresh conversations with the notes as context. (Revisit if it stings.)
- **No AI merge of two projects** (the reverse operation) — out of scope until forking earns
  its keep.

## Later: sharing projects as reading lists (U.25 vision — recorded, not scheduled)

Over time Kamil wants projects shareable as **reading lists** — optionally including notes —
in a marketplace where explorers browse lists others built. The storage model is already the
right shape: a project IS a self-contained markdown git repo, so a "published list" is a
snapshot of `reading-list.md` (plus, optionally, per-paper Notes blocks), and importing one is
a fork-shaped copy into a fresh local project (the same machinery as U.24 phase 1 — which is
part of why v1 forking is worth building well). What a marketplace adds — publishing,
discovery/browse, identity, versioned updates, and a notes-privacy story (share list-only vs
list+notes) — is deliberately future work, not in the first release; it should not shape v1
beyond keeping the fork/copy path clean and reusable.

## Open questions for Kamil

1. Naming: "Fork" (this doc), "Split", or "Move to new project"? Fork implies the source
   stays whole — accurate for the copy default.
2. Should the fork ALSO offer "archive source papers" (mark read + collapse) instead of
   full removal, for the "project got too big" case where you want the source thinned but
   not rewritten?
3. Is the AI source-cleanup pass (phase 3) worth it in v1, or defer — approving a large
   working-notes rewrite is the heaviest review this app asks of anyone.
