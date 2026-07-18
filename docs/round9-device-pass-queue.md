# Round-9 queue — 2026-07-17 device-pass notes

Kamil's notes from using the app after the Round-7 features + project-split shipped. This is
the reviewable queue for the next session, alongside the already-queued **Figures in chat
(R.10, signed off — the agreed next implementation)**, **split AI-notes passes (R8.3)**,
**chat jump-navigation (R7.9)**, and the **collaborative icon redo (R7.10, see
docs/icon-design.md)**. Same delivery rules: one focused PR per item off latest `main`, codex
review, gated merge, deploy, ledger. Items needing UI design go through the codex→Figma path.

Grouped by type; rough priority within each group. IDs R9.1–R9.15.

## Bugs

- **R9.14 — Split/rename sheets don't avoid the keyboard.** In the Split-to-new-project sheet
  (and the R7.5 project rename), the name/detail inputs sit under the keyboard when it opens.
  Wrap the sheet content in `KeyboardAvoidingView` (the app already uses
  `react-native-keyboard-controller`); verify on device. Small, do early.
- **R9.7 — Play button glyph off-center.** Check whether the play/pause rectangle is perfectly
  centered in its circle (`mobile/src/app/player.tsx` / NowPlaying controls) — it looks
  slightly off. Fix the alignment.
- **R9.6 — Cue playback repeats "synthesizing" + stops in background.** In full-synthesis
  listening mode the cue track repeats "response has finished and I'm synthesizing it" on a
  loop. It should say the response is **ready to read while audio is still processing**, and
  only speak again when there's actual **progress** to report (no repetition otherwise). Also:
  new cues appear to stop when the app is backgrounded — either keep them playing or add an
  option to. (`mobile/src/audio/*`, preview cue scheduling; background-audio capability.)

## Prompt / correctness

- **R9.9 — Strip bracketed numeric citations `[11]` from responses.** The analyst sometimes
  emits the paper's own reference numbers (`[11]`, `[3]`, …). We don't render the final
  references section, so these dangle. The model must ALWAYS use our own linking for external
  and in-project papers (rc-paper links / the graph), never bare numeric refs. Fix in the
  analysis system prompt (`app/prompts.py`), and consider a tolerant post-process strip in the
  marker parser as a backstop.
- **R9.5 — Preview cues need prior cues in context + must see the real response.** (a) Feed
  previously generated preview cues into the context when generating the next cue (flow, no
  repetition). (b) CONFIRM the cue model is actually shown the response text being generated —
  Kamil wants this verified, not assumed. (`app/preview_jobs.py`, listening-preview prompt.)

## UI polish (mostly Figma-driven)

- **R9.3 — Reply/composer box redesign.** The send button should sit **inside** the box; the
  box should extend **edge to edge** horizontally; and remove the stray **straight separator
  line** that currently runs beyond the composer's rounded shape, dividing it from the chat
  area. Reference: Gemini's composer (Kamil has screenshots of Gemini's + ours). Drive via
  codex→Figma. **NEEDS: Kamil's screenshots** (Gemini reference + current) attached next
  session, or I inspect + mock the current composer myself. (`mobile/src/app/paper/[slug].tsx`
  InputToolbar/composer styles.)
- **R9.8 — `+15` / `-15` skip buttons restyle.** They look inconsistent with the sentence
  (prev/next) control; restyle to match, via Figma. (player controls.)
- **R9.10 — Playback speed control larger.** Make the speed pill bigger / more prominent.
- **R9.11 — Continue Reading: drop paper status, show project name.** The status is almost
  always "Discussing" (noise); replace it with the **project name** (needed for cross-project
  clarity). (`mobile/src/app/(tabs)/index.tsx` ContinueCard.)

## Features

- **R9.1 — Proper draggable bottom sheets.** Our sheets are custom `Modal`s that can't be
  dragged from the top to grow/shrink. Adopt standard bottom-sheet behavior (drag handle +
  snap points + grab-anywhere resize) as the default across sheets. Evaluate
  `@gorhom/bottom-sheet` vs. adding gesture-handler-driven snap points to the existing
  `BottomSheet` component. (Shared component — affects every sheet.)
- **R9.12 — Sort options for the paper list.** With no subcategories, add a **sort** control
  (by name, publication date, date added to project, paper status, …), DISTINCT from the
  existing status filters (which stay). "Date added" = reading-list order (verify it's
  recoverable; if not, may need an added-at stamp). (`mobile/src/app/(tabs)/index.tsx`.)
- **R9.13 — Generalize Split into "Move" + add Delete to multi-select.** Reorganize the
  Library multi-select action menu into standard, recognizable items: a general **Move**
  (which offers *to a new project* — today's split — OR *to an existing project*), and
  **Delete** alongside it. Move-to-existing is a new backend capability (a split variant
  targeting an existing pid instead of scaffolding one); batch-delete reuses the removal flow.
  Extends R8.2. (Design note likely worthwhile before building.)
- **R9.2 — Text selection + comment-on-text + queued comments (the big one).** Kamil
  explicitly wants to revisit selectable response text (previously declined) and go further:
  1. **Select text** in a response.
  2. **Add comment**: Select → "Add comment" → Ok. The view updates to show that span now
     carries a comment (a visible annotation on the text).
  3. Comments **queue** for the next response — the compose area shows "N comments will be
     attached"; repeatable across multiple spans.
  4. On reply, the agent receives each **quoted span + its comment**, alongside anything else
     the user typed. This lets the reader annotate a long response as they read and ask precise
     questions.
  Must feel great — smooth selection, clear affordances. This is a substantial feature:
  selectable/annotatable Markdown rendering, a comment data model on the turn, the queued-
  comment compose UI, and threading quotes+comments into the next turn's context+prompt. **Start
  with a design doc.**

## Confirmed / no-op

- **R9.4 — Default theme = System.** Already the default (ThemeProvider `useState('system')`;
  system resolves OS-light→Light else Dim). No change. Kamil notes he likes the Light theme.
  Verify on the next device pass.

## Refines an existing queued item

- **R8.3 nuance (from Kamil's move-notes question; implemented in R8.3).** He moved *unread* papers and correctly
  wasn't asked about cleaning the working notes. The source-cleanup pass (R8.3 phase 3) should
  be **offered only when the moved papers actually influenced the working notes** — i.e. read
  papers with committed Notes that were synthesized in — not for unread papers. This applies to
  move-to-existing (R9.13) too. Fold into R8.3's design.

## Suggested order for next session

Figures (R.10) is the agreed headline feature. Interleave the quick wins early: R9.14
(keyboard bug), R9.11 (Continue card), R9.9 (numeric refs), R9.7 (play glyph). Then the audio
cluster (R9.5, R9.6, R9.8, R9.10). Then the features that want design docs first (R9.2
text-comments, R9.13 Move, R9.1 bottom sheets, R9.12 sort). R7.10 icon and R8.3 notes-passes
slot in per Kamil's appetite.
