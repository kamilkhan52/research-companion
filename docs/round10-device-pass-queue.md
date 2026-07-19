# Round-10 queue — 2026-07-18 device-pass notes

Kamil's follow-up after testing the merged R8.3/R9.1 build. This is the execution ledger for
the next implementation program. Keep changes in focused PRs, preserve the background-job and
human-approval invariants in `CLAUDE.md`, and defer only work whose visual target genuinely
depends on screenshots Kamil has not attached yet.

## Verified in this pass

- R9.1 sheet motion, scrolling, and toast layering feel good after the provider hotfix.
- R9.7 play glyph alignment looks correct.
- R9.11 Continue Reading no longer shows noisy paper status.
- System theme behavior and the current palettes are functional.

## Immediate interaction defects

- **R10.1 — Android Back dismisses only the active sheet.** Hardware Back currently closes
  the sheet and also navigates the scene underneath. Consume the event while any Gorhom sheet
  is presented; the first Back lowers the sheet, a subsequent Back navigates normally.
- **R10.2 — Keyboard focus expands sheets automatically.** Focusing create/rename/split inputs
  opens the keyboard but leaves the sheet at its short content detent. It must rise/expand far
  enough to keep the focused input and actions visible, including a Projects sheet with four
  or more rows. Preserve manual drag and scrolling with the keyboard open.
- **R10.3 — Sequential migration-notes approval.** Moving read papers with committed Notes
  currently creates a recoverable proposal that is discovered later in Working Notes. The
  migration flow should process selected papers sequentially and present each notes
  integration for review/commit at the migration point. Keep proposals durable and
  human-approved; never make the migration HTTP request wait on the LLM.
  **Implemented in [#172](https://github.com/kamilkhan52/research-companion/pull/172):**
  relocation now opens Working Notes
  immediately, generates one paper-scoped background proposal at a time, and advances only
  after Apply or Discard. Each Apply commits before the next proposal reads the updated notes.
- **R10.4 — Graph Build first-tap feedback.** The first Build Graph tap on a new project appears
  inert. The UI must immediately show a starting/running state and remain idempotent if tapped
  again; verify whether the job already starts and fix client invalidation/transition rather
  than starting duplicates.
  **Implemented in [#173](https://github.com/kamilkhan52/research-companion/pull/173):**
  starts are scoped to the active project, so a pending request from the prior project cannot
  consume the new project's first tap or apply a late snapshot to its UI.
- **R10.5 — Progress connector lines never paint over completed circles.** Discover still draws
  a connector through/over a checkmark circle even though Map was locally fixed. Repair the
  shared progress-step primitive or introduce one, then use it everywhere.
  **Implemented in [#173](https://github.com/kamilkhan52/research-companion/pull/173):**
  Map and Discover now share one progress timeline whose connectors render in a single
  background layer before every dot/check.

## Map

- **R10.6 — Show 50 more nodes at a time.** Change Map's visible-node increment from 20 to 50.
- **R10.7 — Clarify citation-count labels.** Replace ambiguous `Cites N` with the truthful
  metric name. If the value is the paper's overall citation count, use `N total citations`;
  keep `Cited in project` and `Significant citation` semantically distinct.
- **R10.8 — Put count/navigation controls inside the plot.** Remove the redundant `N matches`
  beside filters. Overlay `Showing n of N` and its controls inside the graph canvas, like Reset
  view, so the plot regains the horizontal strip.
  **R10.6–R10.8 implemented in
  [#173](https://github.com/kamilkhan52/research-companion/pull/173):** Map pages 50 at a time;
  outgoing graph edges are labeled `References in map`, provider-wide impact is `Total
  citations`; and the count/± controls now overlay the plot with the redundant match text
  removed.

## Discover and empty-project onboarding

- **R10.9 — Generic Discover input placeholder.** Remove the overly specific example; use
  brief field copy such as `Type a topic or question`.
  **Implemented in [#173](https://github.com/kamilkhan52/research-companion/pull/173).**
- **R10.10 — Prominent empty-project Add Papers hub.** An empty Library should present a
  designed add surface offering (a) add a specific paper and (b) explore Discover. Adding a
  paper must not feel owned by the Discover tab or appear as one long text button.
- **R10.11 — Improve discovery quality and ranking.** Audit whether candidate recall is
  over-dependent on arXiv keyword search. Rank with an LLM pass grounded in topical relevance,
  paper credibility, and credible institution/lab signals, reusing Map ranking/enrichment
  logic where it is genuinely shared. Evaluate with fixed project/query fixtures before
  changing production ranking.

## Library sorting, paper identity, and actions

- **R10.12 — Hierarchical sort menu with direction.** Selecting Alphabetical, Publication
  date, or Date added reveals a clean second level underneath with a preselected direction.
  Alphabetical defaults A→Z; both date sorts default oldest→newest because the expected reading
  order is chronological. The user can choose the revealed option or Back out of the menu.
- **R10.13 — Canonicalize a title after resolution, with confirmation.** When a title query
  resolves to a paper, show what was found and offer to replace incomplete/mistyped input with
  the canonical title. Do not silently rewrite the reading-list record.
  **Implemented in [#184](https://github.com/kamilkhan52/research-companion/pull/184)
  (in review):** durable retrieval snapshots carry the matched source title; both first-read
  and auto-analysis re-entry ask before a stable-slug rename.
- **R10.14 — Paper edit menu.** Provide basic Rename/Delete and any justified identity/source
  actions from a standard paper menu. Existing swipe-delete stays; investigate a swipe in the
  opposite direction only if it remains discoverable and does not conflict with navigation.
  **Implemented in [#184](https://github.com/kamilkhan52/research-companion/pull/184)
  (in review):** the paper overflow offers Rename and Delete; rename commits only the bounded
  reading-list/corpus paths and preserves the slug, Notes, and discussion history.
- **R10.15 — Fetch status, explicit Fetch, and recovery.** Replace “the analyst will fetch…”
  prose with a compact source status and Fetch action. Starting reading still auto-fetches.
  Show resolution progress/results cleanly, scroll first-read progress to the current stage,
  expose failures, and offer PDF link or PDF upload using existing confirmation/retrieval
  paths where possible.
  **Implemented in [#184](https://github.com/kamilkhan52/research-companion/pull/184)
  (in review):** mobile uses durable retrieval jobs and reattachment instead of retrieval SSE;
  the source card exposes Fetch, Fetch & Start, live progress, terminal errors, candidate/link
  recovery, and native PDF upload. Upload extraction is itself a guarded background job.
- **R10.16 — Multi-select action redesign.** The current horizontal bar crowds `N selected`
  vertically and oversizes Move/Delete. Use a standard compact selection action surface with
  explicit **Move** and **Copy**; only Move implies source removal. Notes handling remains an
  explicit follow-up for read papers. Screenshot-informed visual tuning can follow, but the
  information architecture is approved now.

## Cross-project paper and migration architecture

- **R10.17 — Verify and preserve all paper work on move/copy.** Moving/copying a read paper must
  include every chat/thread, branches, committed Notes, corpus/source data, and per-paper graph
  cache. Reproduce the reported Reading Modes reset and fix any contract/cache/navigation
  issue that makes copied session history appear absent.
  **Implemented in [#172](https://github.com/kamilkhan52/research-companion/pull/172):**
  both Move and Copy carry transcript,
  retry branches, and session metadata; Move then removes the source while Copy leaves two
  independent histories. A committed-paper regression test covers the reported Reading Modes
  fallback.
- **R10.18 — App-wide duplicate awareness and reuse.** Before adding a paper already present
  elsewhere, offer Cancel, reuse/copy into this project, or move it, with explicit Notes/chat
  handling. Design around a stable cross-project paper identity and shared reusable source
  artifacts without weakening each project's independent git-backed record or approval flow.
  **Implemented:** deterministic arXiv/DOI/source/exact-title identity preflight now covers
  every add surface. The chooser defaults to Copy, makes Move explicit, shows reusable full
  text/Notes/discussion work, and opens the sequential Notes-integration review immediately
  when requested. Reuse materializes independent project records through the existing
  transactional move/copy engine; see `docs/cross-project-paper-identity.md`.

## Discussion, audio, figures, and threads

- **R9.2 approved — sentence annotations.** Implement the four phases in
  `docs/text-comments-design.md`. Long-press keeps the existing action menu; **Comment on this**
  enters sentence selection. Native arbitrary character-range selection remains unavailable.
- **R10.19 — First-turn and retry configuration.** Retry First Response should expose the same
  reading/prompt modes as initial entry. Add per-discussion model selection beside prompt type;
  keep the default compact, reveal model choices only under Change default model, and show
  descriptions dynamically instead of crowding the first screen.
- **R10.20 — Preview cues continue until playable audio is ready.** In stitched-full and
  segmented modes, cues must bridge from analysis generation through the actual audio-ready
  boundary, without repetition. Text completion alone must not stop them.
- **R10.21 — Multiple threads per paper.** Let the reader start a clean thread with arbitrary
  text once the source is available, switch among independent threads, retain the main chat's
  tools, and synthesize concluded insights from all threads into the notes proposal. Requires
  a session/thread storage design before implementation.
- **R10.22 — Figures are prefetched and explicitly prompted.** Confirm retrieval warms the
  figure manifest/assets. Give the analysis model concise, correct instructions for referring
  to available figures in the syntax the renderer recognizes; the initial analysis should use
  one or two genuinely central figures when available, never force irrelevant ones.
  **Implemented in
  [#176](https://github.com/kamilkhan52/research-companion/pull/176):** both new retrievals
  and already-fetched first-read starts launch the registered background figure warm; ready
  numbered figures/captions enter the reading context; the analysis and opening prompts
  specify the exact `Figure N` inline-card contract and the one-or-two-central-figures rule.
- **R10.23 — Edit-message view matches backend rewind.** While editing a user turn, hide that
  original user bubble and every subsequent assistant turn. Show only the assistant response
  preceding the edited turn plus the editable draft, exactly matching the server's branch
  rewind semantics. **Implemented in
  [#175](https://github.com/kamilkhan52/research-companion/pull/175):** the client cuts its
  cached transcript at the edited user turn as soon as Edit begins, keeps the persisted draft
  in the composer through job acceptance, and renders only the replacement optimistic turn
  while the regenerated response is running.
- **R10.24 — Mini-player transition.** Hide the bottom Now Playing bar when the full player is
  open, with a clean transition; reliably restore it when minimized or navigated back.
  **Implemented in [#174](https://github.com/kamilkhan52/research-companion/pull/174):**
  the full-player route suppresses only the redundant root mini-player; navigating back
  restores it without changing playback state.

## Density, bounded lists, and Figma-authorized work

- **R10.25 — Compact layout option.** Prefer a user-selectable **Tight** density over a blind
  global 20% font reduction: reduce the most common body/title scale and vertical spacing
  while preserving accessibility and math/chat legibility. Prepare the token/layout direction
  in Figma; final tuning may use Kamil's later screenshots.
- **Authors & Labs — bound initial results.** Add a sensible initial limit and Show More
  increments so the screen is scannable.
  **Implemented in [#174](https://github.com/kamilkhan52/research-companion/pull/174):**
  Authors starts at 10; researched Labs starts at 5; both Lab cards and unmapped authors reveal
  additional ranked pages explicitly.
- **R7.10 direction replaced — Paradigm “P” icon.** Design an original, aesthetically strong
  P-shaped mark grounded in the app's editorial/research philosophy and themes, carry it
  through the Figma workflow, select with Kamil if materially different finalists remain,
  then implement all platform icon assets.
- **R9.8 authorized — skip controls.** Complete the Figma restyle of `−15/+15` to harmonize
  with sentence navigation, then implement it.
- **Palette refinement authorized.** Refine Light/Dim/Black variables in Figma and implement
  the chosen token values. Preserve semantic contrast and verify sheets, graphs, annotations,
  progress indicators, and audio controls in all modes.

## Screenshot-dependent follow-up

Kamil will attach screenshots later. Do not let that block functional work above. Hold only
pixel-specific tuning that depends on the missing reference, especially the final compact
multi-select composition and density/font comparison.
