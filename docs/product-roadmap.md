# Product experience roadmap

This is the durable execution ledger for the next Research Companion product phases. It records
the decisions made from real app use, the order in which work ships, and the acceptance bar for
each PR. Keep it current as PRs are opened, reviewed, and merged.

## Delivery rules

- Branch every item from the latest `main`; do not stack feature branches.
- Keep each PR focused. CI, reviewer feedback, and merge complete before the next item begins.
- Long or LLM-backed work remains a background job plus polling; background jobs rebind project
  context before touching project data. The other invariants in `CLAUDE.md` remain mandatory.
- Backend tests are network-free. Mobile changes require automated tests, TypeScript, and a real
  Android/iOS acceptance pass where native audio, gestures, or rendering are involved.
- Update the table below and the relevant acceptance record in the same PR that completes work.
- Status values in this file are authoritative only on merged `main`. Before merge, GitHub is the
  authority for live review and CI state. A PR's final pre-merge commit sets its own row to
  `Complete`, so the ledger becomes correct atomically when that commit lands.
- Post every actionable review finding directly on its PR. When review finds no actionable issue
  and CI passes, mark the PR ready and merge it without waiting for a separate merge request.

## Status

| Order | Workstream | PR | Status |
|---:|---|---|---|
| 0.1 | Persist this roadmap | [#12](https://github.com/kamilkhan52/research-companion/pull/12) | Complete |
| 0.2 | Mobile Jest/Router test foundation + CI gate | [#13](https://github.com/kamilkhan52/research-companion/pull/13) | Complete |
| 1.1 | Obsidian vault configuration, migration, and prompt loader | — | Planned |
| 1.2 | Centralize every model prompt + prompt status UI | — | Planned |
| 1.3 | Self-contained figure/table/section descriptions | — | Planned |
| 2.1 | Device Listening mode + automatic queued audio | — | Planned |
| 2.2 | Grounded preview cues from the live response | — | Planned |
| 2.3 | Progressive TTS segments + sentence/headset controls | — | Planned |
| 3.1 | Recent sessions and activity timestamps | — | Planned |
| 3.2 | Authored-draft safety and reconciliation | — | Planned |
| 3.3 | Playback position restoration | — | Planned |
| 3.4 | Responsive drawer and project/navigation layout | — | Planned |
| 4.1 | Discussion composer, icons, overflow actions, one-shot model | — | Planned |
| 4.2 | Real sheets, centralized motion, developer tuning | — | Planned |
| 5.1 | Retrieve missing project papers during graph builds | — | Planned |
| 6.1 | Native Markdown + equation rendering | — | Planned |
| 6.2 | arXiv HTML figure extraction and response figure cards | — | Planned |

## Locked product decisions

- A dedicated Obsidian vault is authoritative. It contains `Prompts/` and the actual
  `Projects/` root; it is not a mirror of another project directory.
- Vault prompt files override legacy settings. A missing file falls back to the existing
  settings override or bundled default. An invalid edit keeps the persisted last-valid version
  active and surfaces an explicit warning; the app never overwrites an invalid file.
- Every model-facing prompt is exposed, including analysis, narration, notes, discovery, graph
  extraction, PDF hunt, tool guidance, TTS, default reading method, and listening previews.
- Listening mode is a per-device toggle and is off by default. It automatically prepares and
  plays responses in order and never interrupts current playback.
- Preview cues are model-written but grounded only in completed source sentences from the real
  response. Default cadence is at least 10 seconds apart, with at most three cues.
- All user-authored text is persisted locally until server acceptance or an explicit save.
- Composer model selection applies to one response only and never silently changes the default.
- Navigation becomes an overlay drawer on phones and a permanent rail on wider layouts.
- Rich visuals begin with arXiv HTML. PDF figure extraction and pixel-level visual interpretation
  are deferred; descriptions must remain grounded in captions and surrounding text.

## Phase 0 — testable delivery foundation

### 0.1 Persist the roadmap

Add this document and reference it from the agent guidance. No product behavior changes.

Acceptance:

- The roadmap contains the agreed scope, PR sequence, public contracts, defaults, and tests.
- From the copy on `main`, a new session can identify the next item and latest merged item without
  consulting feature branches.

### 0.2 Mobile automated tests

Add `jest-expo`, React Native Testing Library, and
[Expo Router's testing utilities](https://docs.expo.dev/router/reference/testing/). Keep tests
outside the route directory. Add a CI job/script that runs them alongside `tsc --noEmit`.

Initial tests must prove:

- the app can render an in-memory route with mocked providers;
- AsyncStorage-backed stores can load, persist, and clear values;
- TrackPlayer and API modules have reusable deterministic mocks;
- one existing query/hook and one screen interaction run without native services.

Verification record ([PR #13](https://github.com/kamilkhan52/research-companion/pull/13)):

- clean `npm ci`, four Jest suites/four tests, and `tsc --noEmit` pass;
- Expo's dependency check reports the installed test packages aligned with SDK 56;
- no device pass is required because this phase changes only test and CI infrastructure, not
  runtime mobile behavior or native configuration.

## Phase 1 — Obsidian prompt foundation

### 1.1 Vault paths, migration, and live loader

Add `RC_VAULT_ROOT`. When set, it supplies `<vault>/Prompts` and `<vault>/Projects` unless
`RC_PROMPTS_DIR` or `RC_PROJECTS_ROOT` explicitly overrides that path. Unset configuration keeps
today's paths and behavior.

Provide a dry-run-first migration command. Apply mode copies existing project directories,
including nested `.git`, refuses a non-empty destination, validates project counts and Git HEADs,
seeds missing prompt files from the current effective values, and never deletes the source.

Represent each prompt with a registry entry: stable key, relative Markdown path, bundled default,
required placeholders, required protocol literals, and scope. Files contain exact prompt text—no
frontmatter is injected into model input.

On access, check filesystem version metadata and load changed files immediately. Persist the last
valid content under app state. Invalid files use that last-valid value (or legacy/default if none),
log the validation error, and report it through the API.

### 1.2 Complete prompt inventory and developer status

Move embedded graph extraction, retrieval hunt, analyst/notes tool guidance, and default reading
method text into the registry. Tool function schemas remain code because they are executable
interfaces, not editable prose.

Extend prompt status with `source`, `path`, `valid`, `error`, `modified_at`, and `effective_hash`.
When a vault is configured, API writes to vault-managed prompts return HTTP 409. Developer Settings
shows the exact server path and validation state and can refresh status; it does not edit files.

### 1.3 Self-contained research responses

Update analysis and narration defaults with this invariant: the researcher may never separately
read the paper. A relevant figure, diagram, table, algorithm, equation, or section is described at
the point of use from available text/captions. If visual details are unavailable, state that limit
and explain the surrounding argument; never say to inspect it “later” and never invent content.

Acceptance for Phase 1:

- Editing a valid file in Obsidian changes the next model call without restarting the backend.
- Removing a required marker/placeholder leaves the last-valid prompt active and displays a useful
  path-specific error.
- Every raw LLM system/instruction prompt resolves through the registry.
- Prompt tests cover precedence, restart persistence, concurrent reads, invalid edits, and migration.

## Phase 2 — Listening mode and pipelined audio

### 2.1 Listening mode and automatic queue

Persist `rc.listeningMode` on the device and expose a quick discussion-header toggle. Add
`delivery_mode: "reading" | "listening"` to turn requests. Listening turns retain canonical text
but automatically begin server-side audio preparation after analysis. The client queues final
narrations and never interrupts a playing track.

### 2.2 Grounded preview cues

While canonical text streams, assign stable IDs to completed sentences. At most every 10 seconds,
submit only new completed sentences and previous cue text to a configurable `preview_model`
(default: narration model). The preview prompt returns JSON with a short spoken preview and its
source sentence IDs.

Reject unknown IDs, unseen numeric claims, malformed JSON, or output over 240 characters. Generate
cue speech in a separate background job so analysis never blocks. Play cues only while otherwise
idle; suppress late cues once final narration starts. Cap each response at three cues. Attribute
preview LLM/TTS usage to the initiating project.

### 2.3 Progressive final narration

Persist each TTS segment separately and publish segment metadata as soon as it is ready. TrackPlayer
starts segment one while later segments synthesize and retains the combined final file for replay.
Move sentence parsing into shared playback code. Previous/next seeks sentence boundaries; remote
previous/next does the same and falls back to ±15 seconds when sentence metadata is unavailable.
Explicit ±15-second controls remain.

Instrument analysis first-token, cue-ready, analysis-complete, narration-complete, first-segment,
and playback-start timestamps. A multi-segment response passes only when playback begins before the
last segment finishes.

## Phase 3 — continuity and navigation

### 3.1 Recent sessions and activity timestamps

Serialize session-index read/modify/write operations and update `updated_at` for every user and
assistant record. Add a cross-project recent-sessions endpoint containing project, paper, state,
and activity time.

### 3.2 Authored-draft safety and reconciliation

Persist reply, request-changes, message-edit, opening/source, notes, and discovery drafts under
project/screen-specific AsyncStorage keys. Debounce writes and clear only after server acceptance or
save. If a POST response is lost, reconcile the draft against the refetched transcript before
offering another send.

### 3.3 Playback position restoration

Use project ID + paper slug + assistant index as the stable audio identity. Save progress from the
TrackPlayer playback service so background listening is captured, following
[TrackPlayer's background-progress guidance](https://rntp.dev/docs/3.1/guides/saving-progress).
Restore the item and position; autoplay only when Listening mode is active.

### 3.4 Responsive navigation shell

Use [Expo Router's SDK 56 Drawer](https://docs.expo.dev/router/advanced/drawer/): overlay/swipe
drawer on phones, permanent rail on wider layouts. Contents: Continue, projects, current project's
papers, Library, Discover, Notes, Graph, Settings. Show the latest unfinished session as a
prominent home Continue card and first drawer item.

Move Discover/Notes/Graph out of the cramped project row. Give the project name full width and use
an anchored dropdown/popover for switching projects.

## Phase 4 — discussion and interaction redesign

### 4.1 Modern discussion controls

Replace Listen/Copy labels with accessible icons. Add a three-dot action menu for retry,
regenerate, and retry with model. Add optional one-shot `model` fields throughout turn requests;
the server passes them to the job without saving global settings.

Build a rounded unified composer with the send icon inside the input. Move Draft Notes to a labeled
checkmark action in the discussion header. Retain visible error/retry states and keyboard behavior.

### 4.2 Sheets and motion

Replace Modal components that show drag handles with the native
[`@expo/ui` BottomSheet](https://docs.expo.dev/versions/v56.0.0/sdk/ui/universal/bottomsheet/) and
real swipe-down dismissal. Keep project selection as a dropdown rather than a sheet.

Centralize app-owned motion durations. Default duration scale is `0.67` (about 1.5× faster), respect
system reduced motion, and expose motion scale plus cue cadence in Developer Settings. Native route
animations use the closest faster platform-supported transition rather than pretending all native
durations are tunable.

## Phase 5 — complete graph inputs

Parse and retain arXiv/source metadata in reading-list entries. Extend graph jobs with retrieval and
extraction phases: confidently matched missing papers are fetched without creating a discussion;
ambiguous papers are reported as needing source confirmation and can be resolved in Graph.

Continue after per-paper failures. Report total project papers separately from ready/analyzable
papers using “N of M ready” language. Preserve incremental extraction caches and job resumability.

## Phase 6 — equations and figures

### 6.1 Native scholarly Markdown

Replace the custom parser with stable
[`react-native-enriched-markdown` 0.7.x](https://github.com/software-mansion/react-native-enriched-markdown)
for native GFM, streaming, selection, links, tables, code, and inline/block LaTeX. Keep the old
renderer behind a temporary fallback until a new native build passes Android and iOS fixtures.

### 6.2 arXiv HTML figures

When arXiv HTML exists, cache a derived figure manifest and authenticated image assets under the
project's `.state`. Add optional figure metadata to assistant transcript entries. Render a figure
card—image, number, caption, source—immediately after the first paragraph that references it.

No visual-model interpretation is added here. Figure descriptions remain grounded in captions and
surrounding paper text; PDF-only papers keep the text/caption behavior.

## Public contract changes

- Environment: `RC_VAULT_ROOT`, `RC_PROMPTS_DIR`.
- Settings: `preview_model`; local Listening, cue cadence, and motion settings.
- Prompt status: source/path/validity/error/modified time/effective hash.
- Turn requests: optional `delivery_mode` and one-shot `model`.
- Chat/audio snapshots: phase, preview cues, final audio job, generated segments, timing data.
- New recent-session and paper-source retrieval endpoints.
- Transcript assistant entries: optional figure metadata.

Regenerate `shared/api-types.ts` whenever an endpoint changes and update the handwritten mobile
types in the same PR.

## Cross-phase verification

- Backend: full Ruff + pytest; no live network in tests.
- Mobile: Jest, Expo Router tests, `tsc --noEmit`, and Expo export/prebuild where native modules
  change.
- Audio: fake-LLM/TTS job tests plus real-device background, lock-screen, headset, queue, and resume
  checks on Android and iOS.
- Rendering: long streamed Markdown, malformed/valid LaTeX, tables, code, links, and referenced or
  missing figures.
- Each phase records its automated results and manual acceptance evidence in this document before
  merge.
