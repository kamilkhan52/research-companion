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

## Active device acceptance

Use [`device-review-ledger.md`](device-review-ledger.md) as the canonical intake and lifecycle
record for every observation Kamil raises during continuous device use. It gives each item a stable
id and distinguishes open work, partial implementation, merged-but-unverified behavior, explicit
deferrals, and device-confirmed closure.

Use [`current-device-test-checklist.md`](current-device-test-checklist.md) and its focused follow-up
files for executable acceptance scenarios. Checklists record what was tried on a physical device;
the feedback ledger records what remains owed. Historical Round queues are implementation records,
not competing sources of current truth.

## Status

| Order | Workstream | PR | Status |
|---:|---|---|---|
| 0.1 | Persist this roadmap | [#12](https://github.com/kamilkhan52/research-companion/pull/12) | Complete |
| 0.2 | Mobile Jest/Router test foundation + CI gate | [#13](https://github.com/kamilkhan52/research-companion/pull/13) | Complete |
| 1.1 | Obsidian vault configuration, migration, and prompt loader | [#14](https://github.com/kamilkhan52/research-companion/pull/14) | Complete |
| 1.2 | Centralize every model prompt + prompt status UI | [#16](https://github.com/kamilkhan52/research-companion/pull/16) | Complete |
| 1.3 | Self-contained figure/table/section descriptions | [#17](https://github.com/kamilkhan52/research-companion/pull/17) | Complete |
| 2.1 | Device Listening mode + automatic queued audio | [#19](https://github.com/kamilkhan52/research-companion/pull/19) | Complete — Android passed; iOS deferred |
| 2.2 | Grounded preview cues from the live response | [#22](https://github.com/kamilkhan52/research-companion/pull/22) | Complete — Android passed; iOS deferred |
| 2.2a | Contextual cue continuity during narration prep | [#30](https://github.com/kamilkhan52/research-companion/pull/30) | Merged — initial Android pass; final cue handoff pending |
| 2.2b | Retrieval-phase spoken cues (arXiv hunt) | — | Deferred |
| 2.3 | Progressive TTS segments + sentence/headset controls | [#28](https://github.com/kamilkhan52/research-companion/pull/28), [#75](https://github.com/kamilkhan52/research-companion/pull/75) | Complete — Android transcript/sentence controls passed; direct-seek confirmation pending |
| 3.1 | Recent sessions and activity timestamps | [#32](https://github.com/kamilkhan52/research-companion/pull/32), [#76](https://github.com/kamilkhan52/research-companion/pull/76) | Complete — Continue Reading session prefetch added; device timing confirmation pending |
| 3.2 | Authored-draft safety and reconciliation | [#31](https://github.com/kamilkhan52/research-companion/pull/31) | Merged |
| 3.3 | Playback position restoration | [#71](https://github.com/kamilkhan52/research-companion/pull/71) | Complete — Android passed |
| 3.4 | Responsive drawer and project/navigation layout | [#40](https://github.com/kamilkhan52/research-companion/pull/40) | Superseded by the shipped bottom-tab navigation shell |
| 4.0 | Discussion thread on a maintained chat library | [#33](https://github.com/kamilkhan52/research-companion/pull/33) | Complete — Android passed |
| 4.1 | Full-width bubbles, overflow menu, retry-with-model, top model picker | [#34](https://github.com/kamilkhan52/research-companion/pull/34) | Complete — Android passed |
| 4.2 | Real sheets, centralized motion, developer tuning | [#68](https://github.com/kamilkhan52/research-companion/pull/68) | Partial — shared swipe-dismiss sheets shipped; global motion tuning deferred |
| 4.3 | Reading-mode prompt templates, full-paper access, and assistant activity | [#72](https://github.com/kamilkhan52/research-companion/pull/72) | Complete |
| 4.4 | Stable Map pinch-release positioning | [#70](https://github.com/kamilkhan52/research-companion/pull/70) | Complete |
| 5.0 | Semantic Scholar graph metadata foundation | [#77](https://github.com/kamilkhan52/research-companion/pull/77) | Complete |
| 5.0a | Semantic Scholar graph metadata cache and merge | [#78](https://github.com/kamilkhan52/research-companion/pull/78) | Complete |
| 5.1 | Retrieve missing project papers during graph builds | [#79](https://github.com/kamilkhan52/research-companion/pull/79) | Complete |
| 5.2 | Fast graph-skeleton lifecycle and completeness state | [#80](https://github.com/kamilkhan52/research-companion/pull/80) | Complete |
| 6.1 | Native Markdown + equation rendering | [#53](https://github.com/kamilkhan52/research-companion/pull/53), [#65](https://github.com/kamilkhan52/research-companion/pull/65), [#73](https://github.com/kamilkhan52/research-companion/pull/73) | Partial — TeX/SVG and responsive scale/scroll shipped; parser replacement deferred |
| 6.2 | arXiv HTML figure extraction and response figure cards | — | Deferred |
| W.1 | Web rebuild: Vite + React foundation + CI | [#20](https://github.com/kamilkhan52/research-companion/pull/20) | Complete |
| W.2 | Web rebuild: Library | [#21](https://github.com/kamilkhan52/research-companion/pull/21) | Complete |
| W.3 | Web rebuild: Graph (high-perf canvas) | [#23](https://github.com/kamilkhan52/research-companion/pull/23) | Merged |
| W.4 | Web rebuild: Discussion + notes review | [#24](https://github.com/kamilkhan52/research-companion/pull/24) | Merged |
| W.5 | Web rebuild: Discovery + Notes | [#25](https://github.com/kamilkhan52/research-companion/pull/25) | Merged |
| W.6 | Web rebuild: Settings + Audio + Player | [#26](https://github.com/kamilkhan52/research-companion/pull/26) | Complete |
| W.7 | Web rebuild: Auth + Polish | [#27](https://github.com/kamilkhan52/research-companion/pull/27) | Complete |
| W.8 | Web/mobile product parity and loose-link repair | [#58](https://github.com/kamilkhan52/research-companion/pull/58) | Complete |
| U.1 | Map stat tiles: label-first layout + unambiguous stat labels | [#81](https://github.com/kamilkhan52/research-companion/pull/81) | Complete — Android passed |
| U.2 | Fix literal `---` artifacts in notes/discussion rendering | [#82](https://github.com/kamilkhan52/research-companion/pull/82) | Complete — Android passed |
| U.3 | Keep paper-link icon on the same line as the title's first word | [#82](https://github.com/kamilkhan52/research-companion/pull/82) | Complete — Android passed |
| U.4 | Cancel control for in-flight audio synthesis jobs | [#83](https://github.com/kamilkhan52/research-companion/pull/83) | Complete — device confirmation pending |
| U.5 | Recommendations reflect live project membership (Discover + Map) | [#85](https://github.com/kamilkhan52/research-companion/pull/85) | Complete — Android passed |
| U.6 | Map build status UI: staged progress + marquee for long titles | [#86](https://github.com/kamilkhan52/research-companion/pull/86) | Complete — device changes requested (→ U.11) |
| U.7 | Agent-cited external papers tappable/addable from discussion | [#87](https://github.com/kamilkhan52/research-companion/pull/87) | Complete — partial on device; consistency → U.7b |
| U.8 | Graph layout rules rework (litmaps-informed) | [#88](https://github.com/kamilkhan52/research-companion/pull/88) | Complete — Android passed |
| U.9 | Author/affiliation view — v1 (OpenAlex authorships + ranked board) | [#107](https://github.com/kamilkhan52/research-companion/pull/107) [#108](https://github.com/kamilkhan52/research-companion/pull/108) | Complete — signed off (in-project authors, 3/2/1, factor explainer); awaits device pass |
| U.7b | Web-paper link consistency: prompt example + client repair | [#90](https://github.com/kamilkhan52/research-companion/pull/90) | Complete — improved on device; residual issues were renderer bugs (→ U.15) |
| U.10 | Map retrieval-errors: small dismissible indicator + details sheet | [#91](https://github.com/kamilkhan52/research-companion/pull/91) | Complete — Android passed |
| U.11 | Fast-map-ready de-emphasis + tappable build-stage explainers | [#92](https://github.com/kamilkhan52/research-companion/pull/92) | Complete — Android passed |
| U.12 | Long-press assistant response opens the actions menu | [#94](https://github.com/kamilkhan52/research-companion/pull/94) | Complete — Android passed |
| U.13 | Composer input growth keeps rounded corners bounded | [#93](https://github.com/kamilkhan52/research-companion/pull/93) | Complete — Android passed |
| U.14 | Retry forks the conversation + minimal branch selector | [#95](https://github.com/kamilkhan52/research-companion/pull/95) | Complete — Android passed |
| U.15 | Long-form markdown rendering: glued headings, bold links, tables, ordinals | [#97](https://github.com/kamilkhan52/research-companion/pull/97) [#100](https://github.com/kamilkhan52/research-companion/pull/100) | Complete — Android passed (incl. U.15b table fit/scroll) |
| U.16 | Screen content behind Android status bar until messages load | [#98](https://github.com/kamilkhan52/research-companion/pull/98) | Complete — Android passed |
| U.17 | Publication year surfaced in UI + agent context | [#99](https://github.com/kamilkhan52/research-companion/pull/99) | Complete — Android passed |
| U.18 | Retrieval records paper identity; year backfill for existing entries | [#101](https://github.com/kamilkhan52/research-companion/pull/101) | Complete — real-vault backfill run (22/23 dated; `park` needs a manual pin) |
| U.19 | Map membership updates live at read time + incremental-rebuild wording | [#102](https://github.com/kamilkhan52/research-companion/pull/102) | Complete |
| U.20 | Map timeline: project-node years + gap-fill from citing bibliographies | [#101](https://github.com/kamilkhan52/research-companion/pull/101) | Complete — dated nodes are strictly older-left→newer-right; undated inherit neighbor X |
| U.21 | TopBar titles auto-scroll on overflow (truncation audit) | [#103](https://github.com/kamilkhan52/research-companion/pull/103) | Complete |
| U.22 | Provider quota/key/rate failures read in the app's voice | [#104](https://github.com/kamilkhan52/research-companion/pull/104) | Complete |
| U.23 | Audio-loading card: eq bars, warm copy, real progress (Figma 64:157) | [#106](https://github.com/kamilkhan52/research-companion/pull/106) | Complete |
| U.24 | Project forking — v1 design (`docs/project-forking-design.md`) | [#105](https://github.com/kamilkhan52/research-companion/pull/105) | Design ready — 3 open questions for Kamil; implementation after sign-off |
| U.25 | Marketplace/sharing vision recorded (design doc §Later; not scheduled) | [#105](https://github.com/kamilkhan52/research-companion/pull/105) | Recorded |
| U.26 | Loading skeleton screens for initial, empty-cache fetches | — | Deferred until the post-subscription polish pass; implement before launch rehearsal/store screenshots |

### U.26 — Loading skeleton screens (deferred)

The familiar boxes that preview where content will appear are called **skeleton screens** or
**skeleton loaders**. Add them after the credits/subscription flows have settled the final screen
shapes, but before M10 launch rehearsal and store screenshots. This is presentation work only; it
must not change query, cache, or background-job behavior.

Use the smallest native implementation first:

- one shared themed `Skeleton` primitive built from React Native `Animated.View`;
- a gentle opacity pulse driven with `useNativeDriver: true`, rather than a gradient/shimmer
  dependency;
- static placeholders when `AccessibilityInfo.isReduceMotionEnabled()` is true, and placeholders
  hidden from the accessibility tree while the containing screen exposes a useful loading state;
- skeleton geometry that closely matches the real title, metadata, card, and row layout so content
  does not jump when it arrives;
- show skeletons only for an initial load with no usable cached data. Keep stale content visible
  during background refreshes, and use a short delay before mounting skeletons so quick cached
  responses do not flash.

Start with Library/project cards, Discover results, Notes lists, Settings/account data, and the
paper header/session bootstrap. Do not skeletonize deliberate empty states, long-running job
progress, chat generation, narration generation, or graph-building stages; those already carry
meaningful status and progress UI.

Implementation references: React Native's
[`Animated` API](https://reactnative.dev/docs/animations) and
[`AccessibilityInfo`](https://reactnative.dev/docs/accessibilityinfo). Expo's
[`LinearGradient`](https://docs.expo.dev/versions/latest/sdk/linear-gradient/) remains an optional
later shimmer treatment, not a prerequisite.

## Round-5 UX sweep (2026-07-15 device pass)

Kamil's round-5 on-device feedback: eleven items plus one approved micro-fix, same delivery
rules (one focused PR per item off `main`, codex review, gated merge, `git pull` deploy). Plan
context in `~/.claude/plans/parallel-discovering-raven.md`.

| Item | Change | PR | Status |
|------|--------|----|--------|
| R.0 | Tidy leaked author-name spacing on the board (`Quoc V . Le` → `Quoc V. Le`) | [#109](https://github.com/kamilkhan52/research-companion/pull/109) | Complete — deployed |
| R.9 | Composer placeholder `Ask about this paper…` → `Reply` | [#110](https://github.com/kamilkhan52/research-companion/pull/110) | Device-verified 2026-07-17 |
| R.3 | Marquee scrolls once then rests at the tail (was frozen); smaller TopBar title | [#111](https://github.com/kamilkhan52/research-companion/pull/111) | Device-verified 2026-07-17 |
| R.8 | Reusable ephemeral toast (`Added to library`, `Settings saved`); imperative bridge | [#112](https://github.com/kamilkhan52/research-companion/pull/112) | Device-verified 2026-07-17 |
| R.1 | Discover reframe: neutral copy (Explore/Results) + prompt reframe (drops new-project/foundational bias) | [#113](https://github.com/kamilkhan52/research-companion/pull/113) | Device-verified 2026-07-17 |
| R.7 | Continue-reading prefetch also warms the opening draft (no-spinner resume); session staleTime; settings-save invalidates cached opening drafts | [#114](https://github.com/kamilkhan52/research-companion/pull/114) | Device-verified 2026-07-17 |
| R.5 + R.6 | Force rebuild-from-scratch (dev-gated `RC_DEV`) threads `force` into OpenAlex enrichment so affiliations refresh; Labs empty-state copy | [#115](https://github.com/kamilkhan52/research-companion/pull/115) | Complete — awaits device pass (set `RC_DEV=1` on the backend to see the option) |
| R.4 | Settings reorg (Connection→Models→Audio→Map→Agent→Usage→Developer); prompt content viewing + dev-gated (`RC_DEV`) in-app editing | [#116](https://github.com/kamilkhan52/research-companion/pull/116) | Complete — awaits device pass; web prompt-editing surface is a small follow-up (web currently reads only) |
| R.11 | End-of-chat notes review: full-screen view + inline edit of the proposed notes & synthesis before commit (guarded by `proposal_revision`) | [#117](https://github.com/kamilkhan52/research-companion/pull/117) | Device-verified 2026-07-17 |
| R.10 | Paper figures in chat — v1 design (`docs/chat-figures-design.md`); figures-first (arXiv HTML), SVG deferred | [#118](https://github.com/kamilkhan52/research-companion/pull/118) | **Complete** — shipped in phases R.10a–R.10c (#154/#155/#156); device pass pending — tracked as [DR-018](device-review-ledger.md) |
| R.10a | Figures phase 1 (backend): `app/figures.py` — deterministic arXiv/ar5iv HTML → figure manifest (number/caption/asset), SSRF-guarded image cache under `.state/figures/`, identity-keyed + cool-down on misses; retrieval-time warm + graph-build enrichment backfill (deadline + orphan guard, per-paper persist) | [#154](https://github.com/kamilkhan52/research-companion/pull/154) | Complete |
| R.10b | Figures phase 2 (serving): `GET .../papers/{slug}/figures` (manifest) + `.../figures/{asset}` (bytes, slug+filename trust boundary + current-manifest identity check); `shared/api-types.ts` regen; mobile `getPaperFigures`/`figureAssetSource` (fetched_ts cache-bust) + `FigureManifest`/`PaperFigure` types | [#155](https://github.com/kamilkhan52/research-companion/pull/155) | Complete |
| R.10c | Figures phases 3+4 (mobile render): pure `lib/figures` resolver (`figureNumbersInText`/`planFigurePlacement` — "Figure N"/plurals/subfigures, first-mention-wins) + `FigureCard` (cached image, caption, source, load-fail degrade) wired into `Markdown` (render-time resolution against the live manifest via `usePaperFigures`) in the committed discussion | [#156](https://github.com/kamilkhan52/research-companion/pull/156) | Complete |
| R.2 | Light/Dark/Dim theming — engineering design (`docs/theming-design.md`): token contract + ThemeProvider/useTheme + migration plan; palette hex via codex→Figma | [#119](https://github.com/kamilkhan52/research-companion/pull/119) | Complete — implemented in T.1–T.6 below; palette refinement and local Figma audit shipped |

## Round-6 UX sweep (2026-07-16 device pass)

Kamil's round-6 on-device feedback: eight items, same delivery rules. Decisions: Labs
affiliations go provider-first then LLM-from-PDF-first-page fallback (R6.4); agentic turns show
the final answer plus a collapsed, expandable activity trail, with the bubble matching the
narrated audio exactly (R6.8).

| Item | Change | PR | Status |
|------|--------|----|--------|
| R6.2 | Build-stepper connector segments render in one layer behind the step dots (was painting over completed checkmarks on Android) | [#120](https://github.com/kamilkhan52/research-companion/pull/120) | Device-verified 2026-07-17 |
| R6.1 | Marquee measures intrinsic text width inside an explicit wide strip (Yoga at-most constraint made absolute text wrap at container width, so overflow was never detected and titles sat frozen) | [#121](https://github.com/kamilkhan52/research-companion/pull/121) | Device-verified 2026-07-17 — behavior tuned further in R7.1 |
| R6.7 | Cross-model retries record the generating model on the turn (`record_assistant(model=…)`, only when it differs from the settings default) and the bubble shows a subtle model badge | [#122](https://github.com/kamilkhan52/research-companion/pull/122) | Device-verified 2026-07-17 |
| R6.5 | Quiet job-done toasts: "Reference map ready" when a graph build settles; "Audio ready" when a manual audio prep that took >5s starts playing (listening mode stays silent — it auto-plays) | [#123](https://github.com/kamilkhan52/research-companion/pull/123) | Device-verified 2026-07-17 |
| R6.3 | Significant view keeps both endpoints of significant edges (the citing project papers have cited-by 0, so the old node-only filter dropped every edge source — the "nodes but no edges" map; live 3D DRAM data goes 0 → 18 visible edges on page 1) | [#124](https://github.com/kamilkhan52/research-companion/pull/124) | Device-verified 2026-07-17 — skeleton-stage follow-up in R7.2 |
| R6.6 | Playback speed: 1×/1.25×/1.5×/1.75×/2× pill in the player header, persisted on device, applied live and re-applied per track | [#125](https://github.com/kamilkhan52/research-companion/pull/125) | Device-verified 2026-07-17 |
| R6.8 | Agentic chat fidelity: segment boundaries separate pre-tool commentary from the answer (bubble = recorded canonical = narration); commentary + tool calls persist as a collapsed, expandable trail on the finished message; empty final output falls back to the last segment's text | [#126](https://github.com/kamilkhan52/research-companion/pull/126) | Device-verified 2026-07-17 |
| R6.4 | Labs affiliations, provider-first then LLM: papers OpenAlex leaves without institution data get affiliations read off their own first page by the analysis model (`app/affiliations.py`, cached per node in the graph store, force-aware); board merges both caches with provider precedence | [#127](https://github.com/kamilkhan52/research-companion/pull/127) | Device-verified 2026-07-17 — lab-centric rethink queued (R7 next round) |

## Round-7 fixes (2026-07-17 device pass on the themed build)

Kamil's follow-up comments after verifying Round-6 + theming. Fix batch first (rows below);
the larger asks (project settings, add-paper initial analysis, author profiles, lab-centric
Labs, chat navigation, "Scholiast" icon) are queued as the next planned round.

| Item | Change | PR | Status |
|------|--------|----|--------|
| R7.1 | Marquee glide 1.5× faster (24→36 px/s); after the single pass it holds at the tail, then resets to the start and stays — no loop | [#136](https://github.com/kamilkhan52/research-companion/pull/136) | Complete |
| R7.2 | Skeleton-stage filter correction fires only on the stage transition, so tapping Significant while the full build runs sticks (was re-asserted every render, snapping back to All); an empty Significant view on a skeleton explains it's waiting on enrichment | [#137](https://github.com/kamilkhan52/research-companion/pull/137) | Complete |
| R7.3 | Chat's second, motionless scrollbar thumb (the RN inverted-list "stuck indicator" ghost) suppressed via a 1px `scrollIndicatorInsets` on the messages list; the real moving indicator is untouched | [#138](https://github.com/kamilkhan52/research-companion/pull/138) | Complete — confirm the ghost is gone on device |
| R7.4 | Completed-vs-ongoing color rule: "Discussing" state chips go amber (ongoing) while "Read" stays mint (done), and the row's "Resume" action + chevron follow amber; applies across all three palettes via `stateMetaFor` | [#139](https://github.com/kamilkhan52/research-companion/pull/139) | Complete |
| R7.5 | Project settings: per-project panel in the switcher (rename, favorite, delete); favorites sort first with a star; delete is a server-side soft delete into a recoverable `.trash` dir (never rm -rf), confirmed on-device, and hands the active selection to the next project | [#140](https://github.com/kamilkhan52/research-companion/pull/140) | Complete |
| R7.8 | Add-paper initial analysis: after any add, an offer sheet asks to start the paper summary (pick a Reading Mode / Not now); the server chains retrieval → session start → first turn (→ audio in listening mode) as durable background jobs (`auto_analyze` on /retrieval/jobs, chat job id on the snapshot); a client-side watcher toasts "Paper summary ready" | [#141](https://github.com/kamilkhan52/research-companion/pull/141) | Complete |
| R7.6 | Authors view: referenced-but-not-in-project papers open the same external-reference menu as chats (arXiv/DOI/URL carried onto board entries); one-paragraph LLM author profiles relating the author to the project — generous context in (goals, reading list, their papers + abstracts, cited works, affiliation), brief grounded paragraph out; background job + per-author fingerprinted cache, merged into the board at read time | [#142](https://github.com/kamilkhan52/research-companion/pull/142) | Complete |
| R7.11 | Map build: LLM reference extraction (the dominant paid phase) fans out over a bounded pool (`RC_GRAPH_EXTRACT_CONCURRENCY`, default 4) — workers run only the LLM call with the project contextvar rebound; all store writes, per-paper persistence, and progress events stay on the generator thread; interruption persists finished results and orphans stalled calls without blocking | [#143](https://github.com/kamilkhan52/research-companion/pull/143) | Complete |
| R7.7 | Lab-centric Labs view: an explicit "Research labs" web pass (Pydantic AI agent, web_search+web_fetch, graph model, top 10 authors, evidence-required, honest not-found) maps authors to their actual research groups; findings cache per author in `.state/lab_research.json` (fingerprinted, errors retried next run); Labs mode shows ranked lab cards (institution, focus, members, counts, link) above the affiliation grouping for unmapped authors | [#144](https://github.com/kamilkhan52/research-companion/pull/144) | Complete |
| R7.10 | "Scholiast" icon: philosophy-grounded concept doc (`docs/icon-design.md`), now redirected to an original theme-aligned **P** mark with Figma workflow + platform implementation | [#182](https://github.com/kamilkhan52/research-companion/pull/182), [#194](https://github.com/kamilkhan52/research-companion/pull/194) | Complete — final editable local-Figma board and all platform assets use only the warm-paper P on flat ink; a native rebuild/reinstall is required to see the launcher icon |
| R8.1 | Project splitting design revised (U.24 → "Split"): move papers + work done (corpus/notes, transcripts, per-paper graph caches) to a new project; remove-from-source and source-notes wipe are user choices; jobs-sweep guard, batched commits, notes passes as proposals | [#146](https://github.com/kamilkhan52/research-companion/pull/146) | Doc revised — awaiting sign-off, then implementation |
| R8.2 | Project split — phase 1 (deterministic): `POST /api/projects/{pid}/split` moves/copies selected papers + their work (reading-list block w/ dangling cites dropped, corpus+Notes, transcripts+branches, per-paper graph caches) into a new project; jobs-sweep guard + slug validation + batched commits both sides; Library long-press multi-select → Split sheet (name, goals, move/copy) | [#147](https://github.com/kamilkhan52/research-companion/pull/147) | Complete — AI working-notes passes (phases 2–3) follow |
| R8.3 | Split/move AI working-notes passes: destination synthesis + optional source cleanup from departed committed Notes; background jobs, project context rebind, recoverable proposals, base-revision conflict gate, explicit apply/discard; controls only when selected papers have Notes | [#168](https://github.com/kamilkhan52/research-companion/pull/168) | Complete |

## Round-9 device-pass queue (2026-07-17) — shipped; detail doc removed 2026-07-25

Kamil's notes from using the shipped Round-7 + split build. Full detail in
the summary rows below (IDs R9.1–R9.15); the per-item queue doc was deleted once the round
closed, since this table is the durable record.

| Item | Change | Type | Status |
|------|--------|------|--------|
| R9.14 | Split/rename sheets avoid the keyboard (inputs hidden underneath) | bug | [#151](https://github.com/kamilkhan52/research-companion/pull/151) — keyboard-controller KAV in Split + Projects sheets |
| R9.7 | Play button glyph centering | bug | [#153](https://github.com/kamilkhan52/research-companion/pull/153) — optical nudge on the play triangle (both players) |
| R9.6 | Cue playback: stop repeating "synthesizing", report only on progress, keep/allow background playback | bug/UX | [#160](https://github.com/kamilkhan52/research-companion/pull/160), [#192](https://github.com/kamilkhan52/research-companion/pull/192) — synthesis cues are progress-gated; Android now continues playback after backgrounding/removal from recents, and iOS declares the playback/spoken-audio session plus background-audio mode. Android device acceptance and the next native iOS build remain. — tracked as [DR-019](device-review-ledger.md) |
| R9.9 | Strip bracketed numeric refs `[11]` from responses; always use our own paper linking | prompt | [#150](https://github.com/kamilkhan52/research-companion/pull/150) — merged; prompt-only ban (no parser strip) |
| R9.5 | Preview cues: prior cues into context + verify the cue model sees the real generated response | audio | [#160](https://github.com/kamilkhan52/research-companion/pull/160) — analysis-phase cues now feed the last 8 spoken cues (like the coordinator); confirmed the cue model already receives the live response sentences (`live_response` grounded sources) |
| R9.3 | Reply/composer redesign: button inside, full-width, remove stray separator line (Gemini ref) | [#166](https://github.com/kamilkhan52/research-companion/pull/166) — one floating rounded card (send button inside the primary row, transparent container = no strip); device pass pending — tracked as [DR-020](device-review-ledger.md) |
| R9.8 | `+15/-15` skip buttons restyle to match the sentence control | [#182](https://github.com/kamilkhan52/research-companion/pull/182) | Selected K1 Figma state + implementation complete |
| R9.10 | Playback speed control larger/more prominent | polish | [#158](https://github.com/kamilkhan52/research-companion/pull/158) — speed pill (bg+border, 15px), mint outline when non-default |
| R9.11 | Continue Reading: drop paper status, show project name | polish | [#152](https://github.com/kamilkhan52/research-companion/pull/152) |
| R9.1 | Proper draggable bottom sheets (drag-to-resize/snap points) as standard | feature | [#169](https://github.com/kamilkhan52/research-companion/pull/169) — shared `@gorhom/bottom-sheet` v5 surface across every bottom-anchored workflow |
| R9.12 | Paper sort options (name/pub date/date added/status), distinct from filters | feature | [#159](https://github.com/kamilkhan52/research-companion/pull/159) — client-side sort (added order = reading-list), Sort control opens OptionsSheet |
| R9.13 | Generalize Split → "Move" (new OR existing project) + Delete in multi-select menu | feature | Backend [#164](https://github.com/kamilkhan52/research-companion/pull/164) (move_to_existing + POST /move on the #75 lock, transactional). UI [#165](https://github.com/kamilkhan52/research-companion/pull/165) — multi-select bar → **Move** (destination chooser: New project… → split sheet, or an existing project → MoveToProjectSheet) + **Delete** (batch remove) |
| R9.2 | Select text → comment on spans → queue comments → attach quotes+comments to next response | feature | Design [#167](https://github.com/kamilkhan52/research-companion/pull/167) (`docs/text-comments-design.md`) — sentence-granularity approved 2026-07-18; phased implementation queued |
| R9.4 | Default theme = System | confirmed | Already the default; no-op |

## Round-10 device-pass queue (2026-07-18) — shipped; detail doc removed 2026-07-25

| Item | Change | PR | Status |
|------|--------|----|--------|
| R10.1–R10.2 | Hardware Back dismisses only the active sheet; keyboard focus expands sheets | [#171](https://github.com/kamilkhan52/research-companion/pull/171) | Complete |
| R10.3 + R10.17 | Sequential paper-by-paper migration-notes review; Move/Copy preserve independent discussion history, branches, session state, Notes, corpus, and graph caches | [#172](https://github.com/kamilkhan52/research-companion/pull/172) | Complete |
| R10.4–R10.9 | Project-scoped first-tap Map build; shared safe progress connectors; 50-node in-canvas pager; unambiguous citation labels; generic Discover placeholder | [#173](https://github.com/kamilkhan52/research-companion/pull/173) | Complete |
| R10.24 + bounded Authors/Labs | Full player suppresses the redundant mini-player; ranked Author/Lab lists reveal bounded pages | [#174](https://github.com/kamilkhan52/research-companion/pull/174) | Complete |
| R10.23 | Editing a user turn immediately rewinds the visible discussion to the preceding response; the original prompt and later tail stay hidden through regeneration | [#175](https://github.com/kamilkhan52/research-companion/pull/175) | Complete |
| R10.22 | Figure assets warm in registered background jobs; ready figure labels/captions enter model context; opening analysis uses the exact inline `Figure N` card contract | [#176](https://github.com/kamilkhan52/research-companion/pull/176) | Complete |
| R10.20 | Listening preview cues continue through slow flat synthesis segments via a bounded grounded keepalive, stopping only at terminal/playable audio state | [#177](https://github.com/kamilkhan52/research-companion/pull/177) | Complete — device pass pending — tracked as [DR-022](device-review-ledger.md) |
| R9.2 phase 1 | Opt-in sentence-span Markdown path with violet selection/annotation marks and no behavior change for ordinary Markdown surfaces | [#178](https://github.com/kamilkhan52/research-companion/pull/178) | Complete |
| R9.2 phase 2 | Per-paper persisted sentence-comment queue with inline editor and attached-comment chips above the composer | [#179](https://github.com/kamilkhan52/research-companion/pull/179) | Complete |
| R9.2 phase 3 | Optional reply comments compose deterministically into the durable user turn; pure annotations send and clear only after server acceptance | [#180](https://github.com/kamilkhan52/research-companion/pull/180) | Complete |
| R9.2 phase 4 | Annotate mode opens with a quiet sentence-selection cue and Done escape hatch; composer transitions animate without changing ordinary message rendering | [#181](https://github.com/kamilkhan52/research-companion/pull/181) | Complete — physical-device acceptance pending — tracked as [DR-021](device-review-ledger.md) |
| R7.10 + R9.8 + palette refinement | Deterministic P-only Scholiast platform icon set; selected K1 64×52 time-jump pills; AA-safe Light mint/amber tokens | [#182](https://github.com/kamilkhan52/research-companion/pull/182), [#194](https://github.com/kamilkhan52/research-companion/pull/194) | Complete — code and local Figma Desktop Bridge audit passed; final boards screenshot-verified, with no authorized recent Figma graphic left unimplemented |
| R10.10 + R10.12 + R10.16 | Empty-project Add Papers hub; hierarchical sort directions with chronological defaults; compact explicit Move/Copy/Delete selection actions | [#183](https://github.com/kamilkhan52/research-companion/pull/183) | Complete — automated verification passed; device pass pending — tracked as [DR-023](device-review-ledger.md) |
| R10.13–R10.15 | Human-confirmed canonical titles; stable-slug Rename/Delete paper actions; durable source status, Fetch/auto-fetch, resolver recovery, and guarded PDF upload jobs | [#184](https://github.com/kamilkhan52/research-companion/pull/184) | Complete — automated verification passed; device pass pending — tracked as [DR-024](device-review-ledger.md) |
| R10.19 | Compact first-turn prompt/model selection; paper-summary Retry reopens the same configuration and stores prompt/mode per response branch | [#185](https://github.com/kamilkhan52/research-companion/pull/185) | Complete — automated verification passed; device pass pending — tracked as [DR-025](device-review-ledger.md) |
| R10.11 | Multi-source Discover recall (arXiv + Semantic Scholar), source-balanced fusion, Map citation/OpenAlex evidence, and fixed offline landmark evaluation | [#186](https://github.com/kamilkhan52/research-companion/pull/186) | Implemented — automated verification complete; device quality pass pending |
| R10.21 | Independent per-paper discussion threads with arbitrary compose-first messages, thread-scoped jobs/drafts/audio/retries, all-thread notes synthesis, and complete Move/Copy history | [#187](https://github.com/kamilkhan52/research-companion/pull/187) | Complete — automated verification passed; device pass pending — tracked as [DR-026](device-review-ledger.md) |
| R10.18 | Cross-project deterministic paper identity, app-wide duplicate preflight, safe Copy default, explicit Move, reusable source/history visibility, and immediate sequential Notes integration | [#188](https://github.com/kamilkhan52/research-companion/pull/188) | Complete — automated verification passed; device pass pending — tracked as [DR-027](device-review-ledger.md) |
| R10.25 | Persisted Comfortable/Tight density, density-aware shared style cache, reduced common type/card/list/chat rhythm, protected touch/math/code/audio sizing, and verified local-Figma comparison | [#189](https://github.com/kamilkhan52/research-companion/pull/189) | Complete — automated verification passed; device pass pending — tracked as [DR-028](device-review-ledger.md) |
| R11.1–R11.6 | Context-aware response preparation activity; reliably growing discussion composer; Last Interacted sorting; retrieval-triggered top-two affiliation metadata; hard guard against unsolicited notes proposals; first-summary incoming project-citation context | [#196](https://github.com/kamilkhan52/research-companion/pull/196), [#198](https://github.com/kamilkhan52/research-companion/pull/198) | Complete — automated verification passed; native composer-growth follow-up awaits device confirmation |

## Theming implementation (R.2, per docs/theming-design.md)

| Item | Change | PR | Status |
|------|--------|----|--------|
| T.1 | Theme runtime: `themes={dim,black,light}` (dim byte-identical default; provisional Black/Light hex pending Figma), ThemeProvider/useTheme/useThemedStyles, pre-paint mode restore, expo-system-ui root view, nav theme + themed StatusBar, `splash.dark`, `userInterfaceStyle: automatic`, Settings Appearance control, Toast as reference migration | [#130](https://github.com/kamilkhan52/research-companion/pull/130) | Complete — full chrome effect needs the next dev build (new native module) |
| T.2 | Migrate UI primitives (`ui/index.tsx`: themed text scale, Icon/Button/Card/Chip…) + shared chrome (TopBar, BottomSheet, Markdown, MathView, AgentActivity/Trail, NarrationTranscript, PromptTemplateOption, ProjectSwitcher, NowPlaying) to `useTheme`/`useThemedStyles`; 8 palette-derived inline literals inventoried for token promotion in T.5 | [#131](https://github.com/kamilkhan52/research-companion/pull/131) | Complete |
| T.3 | Migrate the tab screens (tab bar, Library, Discover, Map incl. BuildProgressBanner/FilterBar) + graph components (GraphCanvas, NodeDetailSheet, RecommendationsPanel) to the theme hooks; `stateMetaFor(t)` replaces the static map | [#132](https://github.com/kamilkhan52/research-companion/pull/132) | Complete |
| T.4 | Migrate the discussion screen (`paper/[slug].tsx`, incl. composer `colorScheme` derived from the theme), notes editor, and the sheets/panels (NotesReviewSheet, RelatedWorks/ExternalRef sheets, PromptStatusPanel, OptionsSheet, PaperCover) to the theme hooks | [#133](https://github.com/kamilkhan52/research-companion/pull/133) | Complete |
| T.5 | Final sweep: settings/authors/player/PaperEntityProvider migrated; inventoried inline tints promoted to tokens in all three palettes (`mintWash(Strong)`, `amberWash/Line`, `dangerWash`, `elevatedGlass`, scrims→`scrim`); flat `colors`/`stateMeta` exports REMOVED; both guards enforced as tests (no flat-palette imports, no inline color literals outside theme/, PaperCover exempt as content) | [#134](https://github.com/kamilkhan52/research-companion/pull/134), [#182](https://github.com/kamilkhan52/research-companion/pull/182) | Complete — palette retune and local Figma variable/board pass complete |
| T.6 | Hotfix: nav-theme imports repointed from `@react-navigation/native` to `expo-router` — SDK 56's bundler rejects direct `@react-navigation/*` imports in app code (tsc/Jest can't catch it; found on device when Metro refused to bundle); direct dep removed | [#135](https://github.com/kamilkhan52/research-companion/pull/135) | Complete |

## Current execution decisions (2026-07-14)

The **U.x rows** are the 2026-07-14 UX polish sweep from Kamil's on-device notes: one focused
PR per row off `main`, mobile-first (web only when the fix is shared or trivially portable),
reviewed per the standing review workflow (codex gpt-5.6-sol) before merge; U.9 is design-only
(Figma proposal, no implementation until sign-off — three open questions in
`docs/author-affiliation-view-proposal.md`).

Round 1 (U.1–U.9, PRs #81–#89) passed its Android device check except: U.4 (audio cancel)
confirmed working on device (2026-07-15); U.6 superseded by the U.11 rework; U.7
hardened by U.7b. Round 2 (U.7b + U.10–U.14, PRs #90–#95) passed its 2026-07-15 device check;
the residual U.7b link inconsistencies turned out to be mobile renderer bugs, fixed as U.15.
Round 3 (from the same device pass) is U.15 (markdown rendering), U.16 (status-bar overlap
while a discussion loads), U.17 (surface paper year in UI + agent context).
U.14 (retry forks + branch selector) is the deep one: retries archive the old tail as a
switchable branch (`.state/branches/`, never in the git record); commits finalize the chosen
branch and stamp a durable `proposal_committed` boundary; per-slug mutation locks + a
proposal-revision token serialize branch switches against turn starts and approvals. Its
Figma component is `Branch selector (U.14)` on chat frame 08a.

The dev loop for device passes: backend runs `RC_RELOAD=1 ./run.sh` on the Mac mini (tailnet
`100.83.161.127`), so `git pull` deploys backend changes; Metro Fast Refresh delivers JS.

The previously active work is complete on `main`: Map pinch-release stability
([#70](https://github.com/kamilkhan52/research-companion/pull/70)), playback restoration
([#71](https://github.com/kamilkhan52/research-companion/pull/71)), reading-mode prompt templates,
full-paper access, and assistant activity ([#72](https://github.com/kamilkhan52/research-companion/pull/72)), responsive long-equation layout
([#73](https://github.com/kamilkhan52/research-companion/pull/73)), and Continue Reading session
prefetch ([#76](https://github.com/kamilkhan52/research-companion/pull/76)). Their stale feature
worktrees have been removed.

The Semantic Scholar comparison and provider foundation are recorded as **5.0**
([#77](https://github.com/kamilkhan52/research-companion/pull/77)). Semantic Scholar is the fast
identity/reference metadata layer; cached local full-text analysis remains authoritative for
project-specific citation significance. Provider influence and intent stay separate from the
existing `significant` verdict.

Phase **5.0a** ([#78](https://github.com/kamilkhan52/research-companion/pull/78)) persists
provider references independently, merges identifiers and provider evidence into full-text
edges, and permits clearly marked metadata-only edges before full text is available. It does
not retrieve missing paper text; that follow-up is completed by Phase 5.1.

Phase **5.1** ([#79](https://github.com/kamilkhan52/research-companion/pull/79)) retrieves confidently
sourced missing-paper text through the existing background-job pipeline while preserving approval
and project-context invariants. Retrieved text remains graph-only derived state; ambiguous matches
require explicit source confirmation, individual failures do not abort the build, and progress
separates total, ready, and analyzed papers.

Phase **5.2 Fast graph-skeleton lifecycle** ([#80](https://github.com/kamilkhan52/research-companion/pull/80)) persists the metadata/cached-analysis map
before missing-paper retrieval and full-text enrichment, exposes its completeness in job/API state,
and lets mobile and web render that useful map while enrichment continues. Bounded one-hop node
expansion remains the next graph candidate; figure cards and other deferred polish still require
explicit reprioritization.

Rows 2.2a, 2.3, 4.0, and 4.1 retain a pending device-pass record. Before scheduling new device
work, reconcile those rows with checks Kamil has already completed and record only the remaining
acceptance cases.

The remaining ideas are not silently pending: retrieval-phase spoken cues (2.2b), global motion
tuning (the remainder of 4.2), wholesale Markdown-parser replacement (the remainder of 6.1), arXiv
HTML figure cards (6.2), and deferred iOS acceptance passes stay deferred until explicitly
reprioritized.

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
- Preview cues are model-written from grounded source IDs: completed response text, the paper's
  abstract/introduction, and committed project context about prior reading. Their target start
  cadence is three seconds, they continue until final narration is playable, and they never
  interrupt non-preview audio.
- All user-authored text is persisted locally until server acceptance or an explicit save.
- Composer model selection (the top-of-discussion picker) is a visible, explicit override for
  new responses in that screen instance — reset to the account default on the next visit — and
  never silently changes the persisted default itself.
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

Verification record ([PR #14](https://github.com/kamilkhan52/research-companion/pull/14)):

- full Ruff and 320-test backend suites pass;
- tests cover path precedence, exact live edits, placeholder/literal rejection, persisted restart
  fallback, corrupted-cache rejection, concurrent reads, dry-run behavior, source preservation,
  prompt seeding, non-overwrite behavior, project counts, and copied Git HEADs;
- remaining embedded prompt inventory and the developer-facing status UI stay scoped to Phase 1.2.

### 1.2 Complete prompt inventory and developer status

Move embedded graph extraction, retrieval hunt, analyst/notes tool guidance, and default reading
method text into the registry. Tool function schemas remain code because they are executable
interfaces, not editable prose.

Extend prompt status with `source`, `path`, `valid`, `error`, `modified_at`, and `effective_hash`.
When a vault is configured, API writes to vault-managed prompts return HTTP 409. Developer Settings
shows the exact server path and validation state and can refresh status; it does not edit files.

Verification record ([PR #16](https://github.com/kamilkhan52/research-companion/pull/16)):

- full Ruff and 327-test backend suites pass; all five mobile Jest suites and TypeScript pass;
- tests prove graph, retrieval, analyst, and notes prompts resolve through the registry, vault API
  writes return HTTP 409, status reports the active-project path and effective version, and
  prompt-only reseeding preserves existing projects and hand-edited files;
- the mobile Developer Settings surface is read-only and displays live source, exact server path,
  validation state/error, modified time, and effective hash with explicit refresh.
- Post-merge review follow-up [#18](https://github.com/kamilkhan52/research-companion/pull/18)
  makes project prompt API entries read-only and applies `RC_PROMPTS_DIR` precedence consistently
  to full and prompt-only migrations.

### 1.3 Self-contained research responses

Update analysis and narration defaults with this invariant: the researcher may never separately
read the paper. A relevant figure, diagram, table, algorithm, equation, or section is described at
the point of use from available text/captions. If visual details are unavailable, state that limit
and explain the surrounding argument; never say to inspect it “later” and never invent content.

Verification record ([PR #17](https://github.com/kamilkhan52/research-companion/pull/17)):

- full Ruff and 329-test backend suites pass; all five mobile Jest suites and TypeScript pass;
- tests prove the shared self-contained guidance is composed into both analysis and narration and
  that the defaults cover figures, diagrams, tables, algorithms, equations, and sections;
- an existing vault receives the new invariant through missing-file fallback immediately, while
  prompt-only seeding can materialize the new shared Markdown file without replacing prior edits.

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

Automated verification ([PR #19](https://github.com/kamilkhan52/research-companion/pull/19)):

- full Ruff and 336-test backend suites pass; all nine mobile Jest suites (sixteen tests) and
  TypeScript pass;
- tests cover persisted device state, request delivery mode, record-before-audio ordering,
  audio-start failure isolation, first-track autoplay, non-interrupting queue append, recoverable
  handoffs after navigation, stable message identity, response regeneration, device-local handoff
  eligibility, off/on dismissal, active-track-safe replacement, retryable handoff recovery, and
  cancellation during native queue add;
- native acceptance remains required for relaunch persistence, background/resume, automatic
  playback, queue advancement, and disabling Listening mode with a track active.

### 2.2 Grounded preview cues

While canonical text streams, assign stable IDs to completed sentences. At a target three-second
start cadence, submit new completed sentences, the paper opening, committed prior-reading context,
and previous cue text to a configurable `preview_model` (default: narration model). The preview
prompt returns JSON with a short spoken preview and its source IDs.

Reject unknown IDs, unseen numeric claims, malformed JSON, or output over 240 characters. Generate
cue speech in a separate background job so analysis never blocks. Prefer background, motivation,
introduction framing, and relationships to papers already read; reserve detailed results for final
narration. Play cues only while the player is idle or another cue is active, and suppress queued
cues once final narration becomes playable. Attribute preview LLM/TTS usage to the initiating
project.

Implementation verification:

- preview generation and synthesis run in independent project-scoped background jobs; chat
  snapshots publish only their opaque job ids and final narration suppresses outstanding cues;
- strict validation rejects malformed JSON, unknown source ids, uncited numeric claims, and cues
  over 240 characters;
- full Ruff and 349-test backend suites pass; all eleven mobile Jest suites (twenty-five tests) and
  TypeScript pass;
- mobile tests cover idle-only cue playback, busy-player dropping, server suppression, polling,
  failed-parent cancellation, cross-turn parent identity, dynamic preview-model fallback,
  explicit override clearing, and serialization with the final-audio queue;
- native iOS/Android acceptance remains required for audible cadence, background behavior,
  non-interruption, lock-screen behavior, and final-narration handoff.

#### 2.2a Contextual cue continuity adjustment

Keep the completed chat snapshot live while its final audio job runs. A project-scoped coordinator
continues publishing grounded cue jobs through narration adaptation and synthesis, with honest
phase/segment progress and no invented ETA. Stop when the combined final audio is ready—or when the
first progressive segment is published after 2.3—and remove any queued, not-yet-spoken cues before
adding the final track. Model/TTS latency can exceed three seconds, so the cadence is a scheduling
target rather than a fabricated delivery guarantee.

Acceptance:

- the model receives bounded paper-opening and committed prior-reading context plus canonical
  response sources, and every factual/numeric claim remains source-ID validated;
- cues continue after written analysis completes, report only real known progress, and stop when
  final narration is playable;
- automatic final-audio polling does not block cue playback; active user/final audio is never
  interrupted, multiple cues queue naturally, and final readiness discards queued late cues;
- backend and mobile tests cover context, coordinator lifecycle/progress, completed-parent polling,
  automatic-preparation playback, cue ordering, and final handoff;
- Android device verification covers cadence, intellectual focus, post-response continuity,
  progress wording, non-interruption, and final handoff. iOS remains explicitly deferred.

#### Post-merge device-feedback fixes (landed directly on `main`)

From the first Android device pass, fixed directly on `main` (not separate PRs):

- mini-player no longer stacks duplicate full-screen player routes on repeated taps;
- rolling transcript highlight and tap-to-seek corrected for progressive multi-segment playback
  (the per-segment position was being mapped as whole-narration fraction);
- final cue announces the response is ready and about to play, and the client keeps at most two
  cues queued ahead so a long prep never builds a stale backlog;
- references render as tappable links — in-project papers open their discussion thread, external
  ones prompt to open the source or add it to the reading list;
- listening cues can narrate the analysis turn's agentic tool use (web search / fetch), sourced
  as bounded `agent_activity` items (the analysis half of "cover agentic activity").

#### 2.2b Retrieval-phase spoken cues (deferred)

Spoken cues during the paper-retrieval / arXiv-hunt phase (the other half of "cover agentic
activity"). Deferred: retrieval is a connection-tied stream with no audio/cue infrastructure, so
reliable cues there need retrieval to gain the same job+cue treatment as the analysis turn, plus a
decision on listening-mode gating while the user watches the fetch on screen.

### 2.3 Progressive final narration

Persist each TTS segment separately and publish segment metadata as soon as it is ready. TrackPlayer
starts segment one while later segments synthesize and retains the combined final file for replay.
Move sentence parsing into shared playback code. Previous/next seeks sentence boundaries; remote
previous/next does the same and falls back to ±15 seconds when sentence metadata is unavailable.
Explicit ±15-second controls remain.

Instrument analysis first-token, cue-ready, analysis-complete, narration-complete, first-segment,
and playback-start timestamps. A multi-segment response passes only when playback begins before the
last segment finishes.

Implementation verification:

- audio jobs publish cached per-segment URLs as synthesis completes while retaining the combined
  MP3; legacy combined-only cache hits remain zero-cost fallbacks;
- automatic Listening and manual Listen both enqueue segment one before later synthesis completes,
  append later segments without interrupting active playback, and retain stable message identity;
- sentence parsing is shared by the rolling transcript, on-screen previous/next controls, and the
  headless TrackPlayer service; missing metadata falls back to explicit ±15-second seeking;
- analysis, cue, narration, first-segment, and client playback-start timestamps are recorded;
- full Ruff and 350-test backend suites pass; all twelve mobile Jest suites (thirty tests) and
  TypeScript pass;
- native iOS/Android acceptance remains required for progressive autoplay, segment transitions,
  headset previous/next behavior, background playback, and combined-file replay.

#### Post-merge device-feedback fix

Previous-sentence seeking always steps to the sentence before the one currently playing —
never restarts the current sentence, which is what the old within-a-grace-window boundary
search actually did. Already at the first sentence of the current segment still falls through
to the existing skipToPrevious segment-crossing behavior unchanged.

Android confirmation on 2026-07-13: transcript auto-follow remains current without a perceptible
delay, and previous/next sentence controls otherwise behave well. Direct sentence seeks could
occasionally begin after the first few words even though continuous playback included them. The
follow-up fix intentionally seeks 0.75 seconds before the estimated sentence boundary to absorb
character-proportion and MP3 seek imprecision; it needs one focused Android confirmation. Final
cue handoff remains a separate untested 2.2a case. iOS remains deferred.

## Phase 3 — continuity and navigation

### 3.1 Recent sessions and activity timestamps

Serialize session-index read/modify/write operations and update `updated_at` for every user and
assistant record. Add a cross-project recent-sessions endpoint containing project, paper, state,
and activity time.

Verification record (landed as `842dd15`, 2026-07-07 — [PR #29](https://github.com/kamilkhan52/research-companion/pull/29)
was closed unmerged and the work was committed directly):

- concurrent index writers are serialized without losing session metadata, and user/assistant
  records advance the authoritative activity timestamp;
- recent activity is sorted across project boundaries while each project context is explicitly
  rebound, and the home Continue card switches projects before resuming the latest unfinished
  paper;
- full Ruff and 353-test backend suites pass; all twelve mobile Jest suites (thirty-two tests) and
  TypeScript pass.

### 3.2 Authored-draft safety and reconciliation

Persist reply, request-changes, message-edit, opening/source, notes, and discovery drafts under
project/screen-specific AsyncStorage keys. Debounce writes and clear only after server acceptance or
save. If a POST response is lost, reconcile the draft against the refetched transcript before
offering another send.

Verification record ([PR #31](https://github.com/kamilkhan52/research-companion/pull/31)):

- all planned authoring surfaces use project/screen-specific persisted keys, debounced normal
  writes, and a submission flush before network delivery;
- discussion replies and revision feedback reconcile against accepted human-authored transcript
  inputs after a lost response, using a persisted acceptance baseline to avoid matching older
  identical text;
- notes saves, opening prompts, and discovery goals reconcile against authoritative refetched
  server state, while message edits and source retrieval remain persisted until acceptance;
- full Ruff and 355-test backend suites pass; all thirteen mobile Jest suites (thirty-six tests)
  and TypeScript pass.

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

### 4.0 Discussion thread on a maintained chat library

Replace the hand-rolled discussion thread (manual ScrollView, scroll pinning, keyboard
listeners, bespoke bubbles and composer shell) with
[`@kesha-antonov/react-native-chat`](https://github.com/kesha-antonov/react-native-chat), the
maintained continuation of react-native-gifted-chat (its peer dependencies were already in the
app). The library owns the inverted message list, keyboard handling, scroll-to-bottom, and the
input-toolbar shell; domain renderers plug in Markdown assistant messages with listen/copy, the
live turn's interleaved text/tool items, and the lifecycle-dependent toolbar (reply → draft
notes → request changes / approve → committed). Message editing moves from in-bubble to the
chat-standard long-press → edit-in-composer flow. Turn delivery is untouched: background jobs +
polling (`useStreamingTurn`), persisted authored drafts, and listening hand-off all remain.

Acceptance:

- Unit tests cover the transcript → message mapping (ordering, reply indices, synthetic
  pending/streaming rows).
- Reply, edit-and-regenerate, request changes, approve, reopen, and draft notes all work
  against the unchanged job endpoints; drafts still clear only on server acceptance.
- Android device pass: keyboard behavior, streaming pin-to-bottom, long-press menus, listening
  hand-off.

### 4.1 Modern discussion controls

Full-width message bubbles (bands, not floating chat bubbles). Listen/Copy on assistant messages
became icon-only; a third per-message action opens Retry / Retry with &lt;model&gt;, the first mobile
caller of the already-implemented `retry_job`/`RetryReq`. Every turn request (`DeliveryReq`) now
carries an optional one-shot `model` field the server passes straight to the job — `_prep_chat_start`
/`_prep_retry` no longer call `config.save_settings`, fixing a real gap against the locked decision
("composer model selection applies to one response only and never silently changes the default").
A model picker at the top of the discussion (like Gemini/ChatGPT) sets that one-shot override for
every new response in the current screen instance, never persisted.

The top-right icon row (Listening, notes, related works, graph) and the composer's Draft Notes
button collapsed into a single ⋯ overflow menu (`@expo/react-native-action-sheet`, already a
transitive dependency of the chat library).

#### Post-merge device-feedback fixes

From the device pass on #33/#34:

- the chat library's own `KeyboardAvoidingView` assumes it starts right below the safe area
  (`keyboardVerticalOffset={insets.top}` in its source), with no way to know a `TopBar` sits
  above it in this app's layout — the reply composer surfaced partly under the keyboard. Fixed
  by measuring the real header height and passing `insets.top + headerHeight` as
  `keyboardAvoidingViewProps.keyboardVerticalOffset`.
- dropped the streaming turn's status line ("Thinking…/Writing…/&lt;tool&gt;…") and background-safe
  footer note — the streamed text itself already shows progress.
- scrolling up to read while a response is still generating no longer gets dragged back to the
  bottom: the inverted message list has no explicit auto-scroll effect of its own (relying on
  staying at scroll offset 0 while the growing streaming item sits at index 0), but RN's default
  FlatList still corrects the viewport toward that offset as off-screen content resizes. Fixed
  with `maintainVisibleContentPosition` (`autoscrollToTopThreshold: 100`) so the list only keeps
  following while already near the latest message.

#### Deferred interaction: selectable response text

Long-press selection of arbitrary text inside assistant responses remains deferred after multiple
approaches conflicted with chat scrolling and the message action menu. The shipped long-press
actions, scrolling, and streaming pin behavior stay authoritative. Revisit selection as a focused
interaction change with Android gesture tests rather than enabling React Native `selectable`
wholesale inside the chat list.

### 4.2 Sheets and motion

Replace Modal components that show drag handles with the native
[`@expo/ui` BottomSheet](https://docs.expo.dev/versions/v56.0.0/sdk/ui/universal/bottomsheet/) and
real swipe-down dismissal. Keep project selection as a dropdown rather than a sheet.

Centralize app-owned motion durations. Default duration scale is `0.67` (about 1.5× faster), respect
system reduced motion, and expose motion scale plus cue cadence in Developer Settings. Native route
animations use the closest faster platform-supported transition rather than pretending all native
durations are tunable.

## Phase 5 — complete graph inputs

Semantic Scholar provides the fast graph skeleton and scholarly identifiers, with explicit
provider provenance and attribution. Its account-wide request limit is enforced through one
shared client pacer. Provider contexts, intents, and influence metadata are evidence rather than
replacements for the existing project-specific full-text significance analysis. The comparison
and rollout slices are documented in [`semantic-scholar-graph-spike.md`](semantic-scholar-graph-spike.md).

Provider source resolution and reference pages are cached independently from LLM extraction.
Metadata-only edges remain non-significant until local full-text analysis verifies the relation;
mobile and web Map views attribute Semantic Scholar whenever such data is displayed.

Parse and retain arXiv/source metadata in reading-list entries. Extend graph jobs with retrieval and
extraction phases: confidently matched missing papers are fetched without creating a discussion;
ambiguous papers are reported as needing source confirmation and can be resolved in Graph.

Continue after per-paper failures. Report total project papers separately from ready/analyzable
papers using “N of M ready” language. Preserve incremental extraction caches and job resumability.
Retrieved full text is stored only as graph-derived state; source confirmation never edits the
git-backed reading list or corpus.

Persist an explicitly marked skeleton snapshot as soon as provider metadata is ready. Polling job
snapshots expose only the small lifecycle/completeness marker; clients fetch the persisted graph
once per collision-proof snapshot revision instead of transferring the full graph on every
progress poll. An interrupted skeleton remains explicitly resumable after a server restart. Replace
the skeleton atomically with the enriched graph after retrieval and full-text analysis complete.

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
- Chat snapshots: reader-facing `activity` / `activity_detail` while answer text is pending.
- Paper payloads: bounded `affiliations`, `affiliation_status`, and `last_interacted_at`.
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
