# Canonical-title confirmation & paper rename — design (R12.13 / D12)

**Status:** design only, no code. Written for a fresh implementing agent (GPT-5.6-sol).
**This plan is a starting point — revise it as you implement** and keep it updated. File/line
references were accurate at authoring; verify before relying on them.

> ⚠️ "Canonical title" here is the **paper's display title** discovered by the retrieval
> resolver (`matched_title`) and the human confirmation around renaming it. This is a **different
> concern** from the canonical per-paper *data* record in
> `docs/canonical-paper-pass-design.md` (R12.9). Don't conflate them.

## What failed (D12, 2026-07-21 OnePlus pass)

Four coupled sub-issues, from most to least important:

1. **Live discussion detaches on canonical-title approval.** After the first response generated
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

## Open questions

1. Kept-marker home — committed reading-list comment (recommended, travels on move/split) vs
   `paper-metadata.json`? Confirm the marker survives `rename_entry` and split/move copy.
2. Should accepting the resolver's canonical title *rename* immediately, or only mark-kept and
   leave the title for the user? (D12 says "shown and offered as a confirmation — not silently
   applied," so: offer both "Use canonical title" and "Keep mine," and set the marker either way.)
3. Does any web-client path share this rename UI, or is this mobile-only for now? (Backend PATCH
   is client-agnostic; the UI fixes are mobile.)

Related: [[round12-queue]] (R12.13/D12), `docs/round12-queue.md`, R12.2 last-opened-thread resume
(#204), `docs/canonical-paper-pass-design.md` (the *other* canonical — data, not title).
