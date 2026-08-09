# Canonical-title confirmation & paper rename — design (R12.13 / D12)

**Status:** implemented on `r12-13-canonical-title` (2026-07-22).
This began as an implementation plan; the decisions and code seams below now describe the
shipped R12.13 behavior. Historical file/line references remain useful root-cause context.

> ⚠️ "Canonical title" here is the **paper's display title** discovered by the retrieval
> resolver (`matched_title`) and the human confirmation around renaming it. This is a **different
> concern** from the canonical per-paper *data* record in
> `docs/canonical-paper-pass-design.md` (R12.9). Don't conflate them.

## What failed (D12, 2026-07-21 OnePlus pass)

Four coupled sub-issues, from most to least important:

1. **Live discussion detaches on canonical-title approval.** After the paper summary generated
   and the title update was approved, the Library eventually showed the new title, but reopening
   the paper showed the **Reading Mode selection** (ComposeFirst) and the existing thread
   "appeared lost/detached."
2. **Mid-string rename cursor jump.** In manual Rename, deleting/typing in the *middle* of the
   title moves the cursor one position left after every keypress. Editing from the *end* is fine.
3. **"Keep it" doesn't persist.** After intentionally keeping a manual title that differs from
   the resolver's canonical title, **every** discussion open re-prompts to change it back.
   "Keep it" should persist once and suppress the same future prompt.
4. **Delete availability** from both the menu and swipe was not re-verified (minor; just confirm).

## Root-cause map (grounded in the code)

**The backend rename is already clean.** `store.rename_entry(slug, title)` (store.py:714)
renames "without changing its stable slug or any session paths" — it edits the reading-list title
line and the corpus `# ` heading only; identity comments, Notes, full text, and **all
session/transcript paths are untouched** (they key on the stable slug). It is deterministic,
offline, and does **not** commit (the caller owns human confirmation + the bounded git commit —
invariant 4). The PATCH route is `updatePaper` → `PATCH /papers/{slug}` (endpoints.ts:247).

So **sub-issue 1 is a client-side navigation/keying bug, not data loss.** The thread still exists
server-side under the same slug. The screen re-mounts into ComposeFirst instead of resuming the
last-opened thread after the title changes. Two things to reconcile:
- R12.2 (shipped #204) makes resume open the **last-opened thread**. The canonical-title-update
  path likely bypasses that resume logic — after `updatePaper` the client refetches and the
  session/thread selection resets. Trace how `hasSession` / thread id survives a `session.data`
  refetch triggered by the title change (`[slug].tsx` `onRenamed` at :503 calls back into the
  screen). The fix is to **preserve the active thread id across the title update** and route
  re-entry through the same last-opened-thread resume R12.2 introduced.
- The session summary's carried-over requirement states this exactly: *"Preserve active
  discussion identity/state across explicit paper addition and canonical-title updates; opening an
  already-started analysis must show its live/existing thread."* Treat that as the acceptance bar.

**Sub-issue 2 (cursor jump)** is the classic React Native controlled-`TextInput` selection reset:
the value is fed from state and re-normalized on each `onChangeText`, so RN re-anchors the caret.
The rename UI is `RenamePaperSheet` in `mobile/src/app/paper/[slug].tsx` (opened via `renameOpen`,
:323/:497). Fixes, in order of preference:
- **Don't transform the value on each keystroke.** Store the raw input verbatim; defer whitespace
  collapsing/validation to submit (the backend already normalizes — store.py:721 `re.sub(r"\s+"`).
  A controlled input whose `value` exactly echoes the last `onChangeText` text does not jump.
- If any transform is unavoidable, manage `selection` explicitly and restore the caret.
- Verify with a mid-string edit on device; this is device-only behavior (won't show in jest).

**Sub-issue 3 (persist "Keep it")** — there is **no persisted suppression today**. The re-prompt
is `[slug].tsx:349-368`: on re-entry it calls `getLatestRetrievalJob`, reads the resolver's
`matched_title`, and if `comparableTitle(found) !== comparableTitle(currentTitle)` it
`setSuggestedTitle(found)` — unconditionally, every time. To make "Keep it" stick, persist a
per-paper decision and consult it here:
- **Where to persist:** a durable per-paper flag. Options: (a) a reading-list identity comment on
  the entry (like the existing `<!-- arxiv/year/slug -->` comments parsed in store.py) —
  committed, human-meaningful, travels with the paper on split/move; (b) the gitignored
  `paper-metadata.json` cache — cheap but not carried by split/move and lost on cache wipe.
  **Recommendation: (a)** a `<!-- title-kept -->` (or `title-confirmed`) marker, so a kept title
  is part of the paper's committed identity and survives move/split (which copies the reading-list
  block verbatim — see `docs/project-forking-design.md`). Confirm the marker round-trips through
  `store._parse_entries` and is preserved by `rename_entry`.
- **Semantics:** set it when the user either accepts the resolver title OR explicitly keeps a
  differing one ("Keep it"). Once set, `[slug].tsx` skips `setSuggestedTitle`. Adding a *new*
  paper or a genuinely new resolver identity is unaffected (new slug / no marker yet).
- Backend surface: extend the PATCH (or add a tiny `POST /papers/{slug}/title-kept`) to write the
  marker within the bounded commit. Keep it invariant-4 clean (human-confirmed → commit).

**Sub-issue 4:** verify Delete is present in both the paper menu and the swipe action after these
changes; the menu action list is in `[slug].tsx` (the `rename`/actions block near :743).

## Invariants (CLAUDE.md)

- **Invariant 4** — the rename and the "kept" marker both reach git only on human confirmation,
  via the existing committed-quick-action path (like `DELETE /papers/{slug}`). No silent rewrites
  (the resolver already "never rewrites the reading-list title silently" — retrieval_jobs.py:30).
- **Invariant 2/6** — writes go through `store` under `_RL_LOCK`; keep single-writer discipline.
- Commits use the pinned git identity via the existing committer/projects `_git` path.

## Suggested phasing

- **P1 (highest value):** fix sub-issue 1 — preserve active thread identity across title update;
  re-entry resumes the live thread (reuse R12.2 last-opened-thread resume). Backend is already
  correct, so this is client navigation/state.
- **P2:** fix the cursor jump (sub-issue 2) — untransformed controlled input.
- **P3:** persist "Keep it" (sub-issue 3) via a committed per-paper marker + consult it in the
  re-prompt effect.
- **P4:** re-verify Delete (sub-issue 4).

## Implementation record (2026-07-22)

### P1 — preserve the active discussion

The title-update callbacks now merge the PATCH response into the cache entry for
`keys.session(pid, slug, activeThread)`, preserving that snapshot's transcript, lifecycle state,
and `thread_id`, and then invalidate that exact active-thread key. Previously they used the
main-shaped query prefix without applying the PATCH response to the active snapshot first. The
render decision also treats
durable `in_discussion`, `notes_drafted`, and `committed` states as an existing discussion even
if a refetch temporarily has an empty transcript, so title refresh cannot route a live first turn
back through ComposeFirst. The stable slug and R12.2 last-opened-thread record remain unchanged.

### P2 — raw controlled rename input

At implementation time the branch tip already used a raw `setDraft` callback (the design's
per-keystroke normalization had moved), so the control was kept deliberately raw and made
explicit: `onChangeText` echoes native input byte-for-byte, and the submitted value is also raw.
A normalized value is used only to decide whether Save is valid/no-op; the deterministic backend
remains the normalization authority. This is correct-by-construction for a mid-string caret and
has a regression test that observes the raw controlled value and request payload; native caret
behavior still needs the planned device pass.

### P3 — durable title decision

The chosen marker is `<!-- title-confirmed -->`, rather than `title-kept`, because the same fact
is recorded after either **Update title** or **Keep mine**. `_parse_entries` exposes it as
`Paper.title_confirmed`; `store.confirm_entry_title` inserts it under `_RL_LOCK`; `rename_entry`
leaves it untouched; and split/copy/move carry it in the existing verbatim entry block.

The existing `PATCH /papers/{slug}` accepts an optional `title` and `title_confirmed`. Rename plus
confirmation is one bounded transaction/commit; Keep mine sends only `title_confirmed`. Both are
explicit user actions and commit through `committer._git` with only `reading-list.md` and, for an
actual rename, that paper's corpus path staged. The marker is consulted by both title-suggestion
surfaces: the post-session canonical sheet and the ComposeFirst retrieval card. This second
surface was beyond the original root-cause line reference but shared the same local-only Keep
behavior, so it was brought onto the same persistence seam.

### P4 — delete verification

Delete remains available in the paper overflow menu as **Delete from project**, backed by the
existing confirmation, and each non-selection Library row still exposes its right-swipe trash
action. The overflow action has interaction-test coverage; the existing backend removal suite
continues to cover the committed deletion behavior.

## Resolved questions

1. **Marker home:** committed reading-list identity comment. Tests cover parse round-trip,
   survival across rename, and travel through both new-project split and existing-project move.
2. **Acceptance behavior:** Update title renames immediately only after the user presses it;
   Keep mine preserves the existing title. Both set the same confirmation marker. Resolver output
   never silently rewrites the title.
3. **Client scope:** the interaction fixes are mobile-only for R12.13. The PATCH contract and
   `Paper.title_confirmed` response are client-agnostic; no current web rename surface shares this
   UI.

Related: [`device-review-ledger.md`](device-review-ledger.md) (DR-012), last-opened-thread resume
([#204](https://github.com/kamilkhan52/research-companion/pull/204)),
`docs/canonical-paper-pass-design.md` (the *other* canonical — data, not title).
