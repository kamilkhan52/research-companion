# Cross-project paper identity and reuse

Round-10 item R10.18 makes paper additions aware of the rest of the app without turning
projects into coupled views over one mutable global record.

## Record model

Each project remains a self-contained git repository. A copied paper receives an independent
destination copy of its reading-list block, corpus/full text, committed Notes, discussion
transcript and retry branches, session metadata, cover, and graph/retrieval caches. Later edits,
chats, and approvals diverge normally.

There are deliberately no cross-project symlinks or shared mutable corpus files. They would
make a commit in one project change what another project reads without that project's human
approval. The existing `project_split.move_to_existing` transaction is the reuse primitive:
it already reserves both projects, validates paths and collisions, rebinds project context,
copies all work before a Move removes the source, commits bounded pathspecs, and rolls back a
failed destination write.

## Stable identity

`app/paper_identity.py` performs a deterministic, read-only scan:

1. versionless arXiv id;
2. normalized DOI, including `doi.org` URLs;
3. normalized source URL with query and fragment removed;
4. exact Unicode/case/punctuation-normalized title only when at least one side lacks a strong
   id.

The title rule is intentionally not fuzzy. If both records have different known strong ids,
an identical title does not merge them. This favors a missed convenience prompt over
incorrectly moving a different paper and its research record.

The service does no network or LLM work and writes nothing. It rebinds the active-project
context for each registry-derived project id and restores it after every read, preserving the
same single-project assumptions as `store`, `sessions`, and `graph_store`.

## Add flow

Every mobile add surface goes through `useAddPaper`:

1. `POST /api/projects/{pid}/paper-matches` runs the read-only preflight.
2. With no match, the existing metadata-only add proceeds and offers paper summary.
3. With a match, the add mutation pauses behind the global `ExistingPaperOfferHost`.
4. The sheet shows which project owns each copy and whether full text, committed Notes, and
   discussion history are reusable.
5. **Copy** is the safe default. **Move** is explicit and removes the source only after the
   destination transaction succeeds.
6. When committed Notes exist, the user can request destination working-notes integration and,
   for Move, optional source cleanup. The paper-by-paper proposal queue opens immediately.
7. Cancel leaves every project unchanged.

The add endpoint repeats the cross-project check and returns a structured 409 for older clients
or a match that appears after preflight. A current client refreshes once and still presents the
same chooser instead of silently adding.

## Why source artifacts are copied, not globally referenced

A future content-addressed download/extraction cache could deduplicate large immutable source
bytes below the project layer, provided project corpus files remain materialized snapshots and
cache eviction cannot change a project record. That optimization is separate from identity and
is not required for reuse: today's copied caches already avoid repeat retrieval and paid graph
extraction while preserving project isolation.
