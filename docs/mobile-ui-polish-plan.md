# Mobile UI polish plan — post-revamp rounds

Follow-up to `docs/mobile-ui-revamp-plan.md` (the Figma revamp, merged as PRs #39–#44),
driven by on-device reviews. **Round 1** (Phases A–E, PRs #45–#49) is merged; **Round 2**
(Phases F–K below, from the 2026-07-09 review) is next. Same working agreement as that
plan: a **driver**
implements phases as PRs into `main`, a **reviewer** (codex, or an Opus subagent when codex
is out of quota) reviews each PR against this doc + `CLAUDE.md`, one review with numbered
findings and a `VERDICT: APPROVE|REQUEST_CHANGES` line, loop until approve, squash-merge.
Binding constraints carry over: no feature removals, `npx tsc --noEmit` + jest clean per PR,
`npx expo export --platform android` bundles, no new deps unless listed here, never commit
`.env`/tokens. Phase B touches the backend deliberately (first plan since the revamp to do
so) — its endpoints must respect the CLAUDE.md invariants and ship with pytest coverage.

## Phase A — density & distinction polish (mobile only)

1. **App title → "Paradigm".** The Library header's "Research Companion" wraps to two lines
   and eats vertical space. Change the `TabHeader` title on `(tabs)/index.tsx` to `Paradigm`
   (one line). Also set `app.json` `name`/display name to Paradigm — note: the launcher label
   only changes on the next dev-client rebuild (see Backlog); the in-app header changes
   immediately. Do NOT change the Expo `slug` (breaks the installed dev client's association).
2. **Project pill slimming.** Once a project is selected, drop the `N papers · M complete`
   subtitle (the progress card right below already shows it); keep the subtitle only for the
   unselected "Tap to choose or create" state. Single-line pill.
3. **Distinct user chat bubble.** Assistant turns stay full-width document bands; user turns
   become a right-aligned floating bubble — max-width ~86%, `elevated` fill, `line2` border,
   `radius.lg` with a tightened bottom-right corner, small right margin. Implementation:
   per-side `wrapperStyle`/`containerStyle` in `paper/[slug].tsx` (the `FULL_WIDTH_ROW`
   comment explains the row-stretch trick — the user side must NOT use it anymore).
4. **Map screen density** (`(tabs)/graph.tsx`):
   - Header title `Reference Graph` → **`Map`** (matches the tab label, one line; keep the
     `N papers · M citations` subtitle).
   - **Stale banner → header affordance.** Remove the "N papers changed / Rebuild" card.
     When `staleCount > 0`, badge the refresh header icon (small amber dot) and make its tap
     open a confirm ("N papers changed since the last build — rebuild now?") that calls
     `build.run(false)`; a plain refetch stays one tap when not stale. The build-progress
     banner (job running) stays — it's transient and informative.
   - **Search behind an icon.** Add a `search` icon to the header actions; the text field
     renders only while toggled on (autofocused, with a clear/close affordance). Filter pills
     stay always-visible.
5. **Graph long-vertical-lines fix** (`hooks/useGraphLayout.ts`). The server temporal layout
   is rescaled onto a fixed 1500×2200 canvas regardless of the visible nodes' real spread, so
   y gets stretched relative to x and time-distant citations render as very long verticals.
   Fix: derive H from the data's own aspect, clamped — e.g.
   `H = W * clamp(yspan/xspan, 0.55, 1.15)` (and keep the 2200 cap). Preserves the monotonic
   temporal ordering (rescale stays per-axis monotonic); just stops inflating y.
6. **Driver-suggested extras** (small, same PR):
   - Discussion header is crowded (back + title + model pill + kebab): cap the model pill to
     an icon + short label (`zap` + first word) or move the current-model readout into the
     picker sheet's title row.
   - "Draft notes" is only discoverable in the kebab menu: add a quiet chip above the
     composer once a discussion is in `in_discussion` state (same handler, still in the menu
     too).

## Phase B — paper removal (backend + mobile)

**Product decision (from the user):** removing a paper keeps its notes for now, with an
appended marker that the paper was removed. A keep-vs-delete choice can come later if wanted;
the confirm dialog copy should say notes are kept.

- **Backend** — `DELETE /api/projects/{pid}/papers/{slug}` in `routers/projects_api.py`:
  - `store.remove_entry(slug)` (new, pure — parse `reading-list.md`, drop the entry; no LLM,
    no network; invariant 3).
  - If the paper has notes: append a short marker section to its notes file
    (`> Removed from the reading list on <ISO date>. Notes retained.`) rather than deleting
    anything. Working-notes synthesis is left untouched.
  - Keep the corpus cache file and session transcript on disk (cheap, and makes re-adding
    the paper later a warm start). The paper simply disappears from the list/state.
  - Commit via `committer` with the pinned git identity (`Remove <title> from reading list`).
    Invariant 4 reading: the human's explicit in-app confirmation IS the approval — same
    standing as notes save; document this in the endpoint docstring.
  - Mark the graph stale the same way paper add does (so Map's stale badge lights up).
  - Fast, deterministic, no LLM ⇒ plain request, not a job (invariant 1 does not apply).
  - pytest: remove unread paper; remove read paper appends the notes marker; slug traversal
    rejected (must go through `projects.project_path`/safe-slug handling); reading-list
    round-trip stays parseable. Regenerate `shared/api-types.ts`.
- **Mobile** — swipe-to-remove in the Library list (`(tabs)/index.tsx`):
  - Wrap `PaperRow` in `ReanimatedSwipeable` (from `react-native-gesture-handler`, already
    linked — no new dep, no dev-client rebuild). Left-swipe reveals a `danger`-tinted trash
    button.
  - Tap trash → `Alert.alert` confirm: title of the paper, "Remove from this project? Its
    notes are kept and marked as removed." → DELETE → invalidate `projectState`/`projects`/
    recent-sessions queries. Inline error surface on failure.
  - Ensure swipe doesn't fight the vertical ScrollView or the row's tap (activeOffsetX).

## Phase C — app-wide paper awareness (papers as linkable entities)

Goal: wherever a project paper is *mentioned* — assistant responses, notes, related-works
reasons — the mention is a live entity that opens a small action sheet for that paper
(Open discussion · View notes · Related works · Show in Map · Open source), so the reader can
hop between readings and the app visibly "knows" its papers.

Already in place: discussion Markdown routes `rc-paper:<slug>` links through
`LinkHandlerContext` into that paper's discussion. Build on it:

1. **`PaperActionsSheet`** (new component, reuses `OptionsSheet` styling): given a slug,
   shows title + state chip + the actions above. Becomes the single tap target for every
   paper mention app-wide (and can replace the bare `router.push` in discussion links so
   taps offer choices instead of hard-navigating).
2. **Notes screen joins the link system**: provide a `LinkHandlerContext` on
   `notes/[target].tsx` so `rc-paper:` links in notes resolve to the sheet.
3. **Deterministic client-side linkification**: a Markdown post-pass that matches known
   project-paper titles (exact/normalized match against `projectState.papers`, longest-first,
   outside code/links) and renders them as paper entities. No LLM, no fuzzy matching — false
   positives are worse than misses; titles are long enough that exact matching is safe.
4. **Prompt nudge (optional, backend `Prompts/`)**: encourage the analyst to emit
   `rc-paper:<slug>` links when referencing project papers in notes blocks, which makes the
   deterministic pass mostly unnecessary over time. Prompt-file change only.

## Phase D — graph performance (static wins first)

Ship the changes that don't need device profiling, then profile only if the Map still feels
choppy on the phone:

1. **Hardware rasterization** (`renderToHardwareTextureAndroid` on the animated canvas):
   pan/zoom becomes a texture transform instead of re-drawing hundreds of Views per frame.
   Gated twice: only while a gesture is live (layer allocated on touch-down, released on
   lift) and only when the full canvas fits a 32 MiB device-pixel layer budget — Android
   allocates the layer for the whole view, so an unbounded canvas would trade jank for OOM.
   Accepted trade: slight blur while pinch-zooming past the captured resolution.
2. **Label level-of-detail**: node labels hide below ~0.5 zoom (unreadable there anyway;
   each is a laid-out Text). Driven by a `useAnimatedReaction` on the UI-thread scale that
   flips one JS state only on threshold crossings — never per frame. Selection always labels.
3. **Arrowhead budget**: arrowheads double the per-edge view count, so graphs over ~120
   visible edges keep arrowheads only on significant edges.

If still choppy after device verification: profile (Perf monitor), then consider moving node
Pressables out of the animated subtree, viewport culling, and — as the last resort — a Skia
canvas (`@shopify/react-native-skia`, which needs the dev-client rebuild batch below).

## Phase E — dev-client rebuild batch (one reinstall)

Everything requiring a native rebuild, grouped so the phone reinstalls once:

- **Launcher identity**: app.json name "Paradigm" (from phase A) plus a new icon set in the
  design language — a mint/violet reference-graph constellation on the scholar-dark canvas
  (generic icon, adaptive foreground/background, themed monochrome, splash mark; generated
  by `scripts/gen_app_icons.py`, pure numpy, rerunnable). Splash + adaptive backgrounds are
  `#0B0D12`.
- **expo-haptics**, wired through the guarded wrapper `mobile/src/lib/haptics.ts`: tab
  switches tick (`selectionAsync`), primary mint buttons give a light impact. The require is
  try/catch-guarded so the SAME bundle hot-loads as a no-op on the current dev client and
  gains feedback once the rebuilt client is installed. Never import expo-haptics directly.
- Skia stays out unless on-device testing shows the phase-D graph work isn't enough.

**Build step (user-run, once, after this phase merges):** from `mobile/` —
`npx expo prebuild --platform android --clean && npx expo run:android` with the phone on USB,
or `npx eas-cli build --profile development --platform android` if using EAS. Install the
resulting build over the old one; the launcher then shows Paradigm with the new icon.
**Round 2 adds one rider to this batch**: `react-native-svg` (for equation rendering,
Phase G) — behind a guarded require like haptics, so the same bundle hot-loads before the
rebuild (unicode-fallback math) and gains SVG equations after.

---

# Round 2 — second on-device review (2026-07-09)

Raw feedback organized into phases F–K. Round-1 constraints carry over unchanged (tsc +
jest + expo export per PR; backend phases add pytest + second-instance smoke on `:8901`;
new deps only where listed; hot-load-safe until the Phase E rebuild). Suggested PR order:
**F → G → H → I → J → K** — quick wins first, then rendering, discussion flow, listening
pipeline, Map gestures, and the design-first player controls last (it has an external
dependency on the codex→Figma step).

## Phase F — chat & player quick wins (mobile only, one PR)

1. **Send → Stop while generating.** The composer send button (`renderSend`,
   `paper/[slug].tsx:733`) becomes a stop button whenever `stream.streaming` — tap stops
   the client-side turn (stop polling/rendering; the composer unlocks immediately). The
   backend job has no cancel today (`app/jobs.py` — threads run to completion); add a
   best-effort `cancelled` flag checked between agent stages so a stopped turn also stops
   burning tokens. The partial transcript is kept, marked as stopped.
2. **Drop the disclaimer.** Remove the "Research Companion can make mistakes" row under
   responses in `paper/[slug].tsx` — pure vertical-space recovery.
3. **Drop "Listening mode"** overline on the player screen (`player.tsx:60`) — the screen
   is self-evident.
4. **Themed scroll-to-bottom.** The bare "V" is the chat library's default
   `scrollToBottomComponent`; replace with our circular icon button (elevated fill, thin
   border, Feather `chevron-down`, mint tint) consistent with the header pills.
5. **Themed long-press + Retry menus.** `onLongPressMessage` (`paper/[slug].tsx:666`)
   uses the library's native `showActionSheetWithOptions`, which ignores our theme; route
   it through our `OptionsSheet` instead (Copy / Edit & regenerate). Audit for any other
   native-menu usage (the response "Retry" affordance included) — `OptionsSheet` becomes
   the only menu idiom in the app.
6. **Remove reading-list category headers.** The Library's group labels
   (`(tabs)/index.tsx:230-233`, `groupPapers`) render hand-written sections that only the
   first project has; new projects have no reliable categorization method (and LLM
   categorization is rejected for now as unpredictable). Render a flat list (keep status
   filters); keep `Paper.group` in the API untouched so a future categorization method
   can light it back up. Backend prompt/flow must not be asked to invent categories.

## Phase G — response content rendering (mobile + small backend)

1. **Equation rendering.** Model responses legitimately contain LaTeX (`\( … \)` inline,
   `\[ … \]`/`$$ … $$` display); the Markdown renderer currently shows raw markup.
   Approach (revised at implementation time from the original KaTeX-in-WebView idea):
   **MathJax → SVG** — `mathjax-full` is pure JS (runs under Hermes) and converts TeX to
   self-contained SVG whose glyphs are paths, rendered natively by `react-native-svg`.
   No WebView-per-formula inside the inverted chat list (the decisive argument), no font
   embedding, crisp at any zoom, `currentColor` theming. `react-native-svg` is the native
   dep and joins the Phase E rebuild batch behind a guarded require (haptics pattern);
   until the rebuild — and on any MathJax failure — a modest pure-JS unicode
   approximation (`lib/math.texToPlain`) renders in serif italics, so math reads as math,
   never as markup. Single-`$` is deliberately not math (prices in prose). The backend
   narrate stage already rewrites canonical prose for the ear; equations reach it as TeX
   and are verbalized by the narration model as before.
2. **Tool-call leakage.** Raw `<search for="…">` tags have appeared inside rendered
   responses. Fix at the source: strip/convert tool syntax when the assistant text is
   finalized into the transcript (backend, where the agent's text is persisted), showing
   at most a muted one-line "Searched: …" status. Add a defensive mobile Markdown pass
   that renders any leaked `<search …>` tag as a muted chip rather than raw text, and
   keep such lines out of narration. pytest covers the stripping.

## Phase H — discussion flow & reading modes (backend + mobile)

1. **Kebab consolidation.** Move model selection and "Draft notes" into the three-dot
   menu (`paper/[slug].tsx` header): the header model chip and the composer-adjacent
   "Draft notes" chip (`:794`) go away. Rename **"Draft notes" → "Finish reading"**
   everywhere user-facing.
2. **Continue after finishing.** Once notes are committed the composer disappears with no
   way back. Add **"Continue discussion"** (kebab + a quiet inline affordance on the
   committed state) that transitions the paper back to the in-discussion state via a
   small backend endpoint — deterministic state change, plain request, committed notes
   stay committed (a later "Finish reading" simply proposes a new draft). pytest: state
   round-trip, notes untouched by reopening.
3. **Reading modes at session start.** On the Start Reading screen, add a mode selector
   (chips above "How should we start?"): **Balanced** (default) · **Background-heavy**
   (unfamiliar area, more context) · **Technical** (assume expertise) · **Detailed**
   (thorough walkthrough). Modes are prompt presets in `Prompts/` that layer onto the
   opening prompt; "Customize prompt" still shows/edits the final text. Also expose a
   quick mode switch mid-session in the kebab (applies to subsequent turns) — the target
   user is listening on the go, so switching must be one tap, not prompt editing.
4. **Related works in discussion view.** Two defects: (a) the sheet content doesn't
   scroll on-device — `RelatedWorksSheet.tsx` nests a ScrollView with `maxHeight: '100%'`
   inside a 75%-height Modal; diagnose the gesture/measure conflict and make the list
   reliably scrollable (bounded height + FlatList if needed); (b) results must include
   papers that are NOT on the reading list — off-list works should appear with their
   "Add to project" action (the UI already renders external works; verify the discussion
   entry point / backend endpoint isn't filtering to project papers and fix wherever the
   filter lives).

## Phase I — listening pipeline: single stitched track + coherent cues (backend + mobile)

1. **Back to one full track.** Segmented incremental playback loses too much: no full
   response duration while playing, playback dies on background/lock state changes, and
   rewind can't cross the current segment's start. Revert playback to the **complete
   stitched file**: keep segment synthesis and incremental progress reporting
   (`app/audio_jobs.py` already stitches the final mp3), but the client
   (`audio/AudioProvider.tsx`) waits for the job's final `url` instead of playing
   segments as they land. (Seamless client-side stitching was considered and rejected as
   a heavier lift than waiting.) Preview cues cover the wait.
2. **Exactly one "ready" handoff.** Today up to ~4 distinct cues can announce the
   response before it plays — disconnected and incoherent. Audit the cue pipeline
   (`app/preview_jobs.py`, `mobile/src/audio/usePreviewCues.ts`): cues play strictly in
   sequence, at most one final handoff line immediately precedes the main track, and
   pending cues are skipped once the stitched track is ready. The transition must feel
   authored, not evented.
3. **Richer, external-context cues.** While the full track renders, cues should deliver
   information *external to the paper* rather than paraphrasing it: agentic lookups on
   author affiliations, the authors' other notable works (related or interestingly not),
   newer versions / publication status, and public discussion of the paper. Cues and the
   main response should be generated aware of each other (share the response outline into
   the cue prompt) so the sequence stays coherent and non-redundant. Extends
   `preview_jobs` prompts + a bounded research step; respects job/polling invariants.
4. **Pronunciation.** Narration says "arXiv" literally; normalize to "archive" (plus a
   small pronunciation map for recurring terms) in the narration text before TTS
   (`app/tts.py` / narrate stage), with a pytest.

## Phase J — Map gesture correctness (mobile only)

1. **Focal-point pinch zoom.** Pinch currently zooms toward the wrong point instead of
   centering on the fingers. Fix `GraphCanvas.tsx` pinch math to anchor at the gesture's
   `focalX/focalY` (adjust translation so the point under the fingers stays fixed while
   scale changes) — standard focal-anchored transform.
2. **Pan momentum.** Pan stops dead on release; add `withDecay` on the translation on
   gesture end (clamped to content bounds) so panning while zoomed behaves like scrolling.

## Phase K — player jump controls (design-first, special workflow)

The player needs clear buttons for both jump kinds — the **±15s duration jump** and the
**sentence jump** (currently the sentence jump is bare tappable text, weird to discover
and hit). Per the user, this one runs design-first:

1. **Fable writes the design prompt**: the app's design philosophy (scholar-dark,
   Manrope/Newsreader, mint action language, pill/circle controls), the player's current
   layout, and the functional spec for the two jump controls.
2. **codex generates the UI proposal from that prompt and builds the frame in Figma.**
3. **Fable implements** from the Figma frame through the normal PR + review loop.

**Status:** steps 1–2 done 2026-07-10. Brief: `docs/player-jump-controls-design-brief.md`;
codex built section `14 · Player Jump Controls` (node 52:1203) on `02 · Mobile Screens`
with three explorations; the recommended frame is **K1 · Semantic inner pair** (52:1204):
one transport row `↺15 · |←¶ · play · ¶→| · 15↻` — sentence prev/next as 52 px
mint-outlined circles (skip glyph + three "text line" marks) flanking the 72 px mint play,
±15 s pills outboard keeping their rotate identity. K2 (segmented rail, 52:1254) and K3
(stacked row, 52:1330) were explored and rejected for vertical weight. Implementation
follows K1; the frames' "Listening mode" header is legacy context — Phase F removes it.

## Round 2 backlog (unscheduled)

- Keep-or-delete notes choice on paper removal, if the retained-notes default proves noisy.
- Skia canvas for the Map, only if it still stutters after Phases D and J on-device.
- Reading-list categorization revisit: define a reliable (predictable, user-approvable)
  method before restoring Library group headers (Phase F.6).

## Verification

- Per PR: `npx tsc --noEmit`, `npx jest`, `npx expo export --platform android` in `mobile/`;
  backend-touching phases (B, and round 2's F.1, G.2, H, I) additionally:
  `.venv/bin/python -m pytest -q` and a second-instance smoke of new/changed endpoints on
  `:8901` (per CLAUDE.md, never the live server).
- Device check per phase via the hot-load flow: backend running + `./tunnel.sh`, Metro via
  `npx expo start --tunnel` in `mobile/` (kill any stale Metro on :8081 first; `npm install`
  if `mobile/package.json` changed), then reload the dev client.
