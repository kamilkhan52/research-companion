# Mobile UI polish plan — post-revamp round 1

Follow-up to `docs/mobile-ui-revamp-plan.md` (the Figma revamp, merged as PRs #39–#44),
driven by the first on-device review. Same working agreement as that plan: a **driver**
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

## Backlog (spec'd later, not scheduled)
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
- Keep-or-delete notes choice on paper removal, if the retained-notes default proves noisy.

## Verification

- Per PR: `npx tsc --noEmit`, `npx jest`, `npx expo export --platform android` in `mobile/`;
  Phase B additionally: `.venv/bin/python -m pytest -q` and a second-instance smoke of the
  DELETE endpoint on `:8901` (per CLAUDE.md, never the live server).
- Device check per phase via the hot-load flow: backend running + `./tunnel.sh`, Metro via
  `npx expo start --tunnel` in `mobile/` (kill any stale Metro on :8081 first; `npm install`
  if `mobile/package.json` changed), then reload the dev client.
