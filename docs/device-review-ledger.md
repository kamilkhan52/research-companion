# Device-review feedback ledger

Canonical intake ledger for feedback Kamil raises while using the app on a real device. This file
tracks the feedback from the moment it is reported until implementation **and** physical-device
acceptance. The scenario-oriented acceptance scripts remain in
[`current-device-test-checklist.md`](current-device-test-checklist.md) and focused follow-up files;
the production and product roadmaps still decide delivery order.

**It also holds shipped work that is waiting on Kamil's device check**, whatever raised it. Until
2026-08-04 those lived only as a trailing "device pass pending" note on a roadmap row marked
complete — so the implementation backlog was visible and the verification backlog was not, and
items sat unverified since Round 9 with no id and no single view. One question, "what is waiting on
me?", now has one answer: every row in this file that is not `closed`.

## Workflow

1. Record every actionable observation in this table during the same session it is reported. Give
   it a permanent `DR-###` id; never reuse or renumber ids.
2. Preserve the user's wording in `Feedback / acceptance`. Split one message into multiple rows
   when the items can ship independently.
3. Use exactly one lifecycle state:
   - `open` — understood, not implemented;
   - `partial` — some acceptance clauses shipped, with the remainder stated explicitly;
   - `implemented — verify` — code is merged, but the real-device/human-quality check is open;
   - `deferred` — deliberately postponed, with the decision boundary named;
   - `closed` — device-confirmed or otherwise explicitly accepted by Kamil;
   - `superseded` — replaced by a later decision, linked from the row.
4. An implementation PR updates its row with the PR and the exact remaining device check. Automated
   tests alone never move a row to `closed`.
   **A PR that ships anything a person has to look at opens a row here if one does not exist**, so
   "complete" in the roadmap never again means "nobody has seen it." When a roadmap row carries a
   pending device check, it links the `DR-###` that owns it and both are updated together.
5. Put detailed reproduction steps in the acceptance checklist and link them here. Screenshots that
   must survive local cleanup belong on the PR/issue or, when genuinely useful as long-term visual
   evidence, under `docs/device-review-assets/<DR-id>/` rather than a temporary attachment path.

## Current actionable feedback

This table is a reconciliation of the 2026-07-21 Round-12 pass, its follow-up checklist, the
2026-07-29/30 production device passes, and feedback through the Discovery scanning-reel pass on
2026-07-31. Historical closed rounds remain in `product-roadmap.md`; they are not duplicated here.

| ID | Raised | Feedback / acceptance | State | Evidence / next action |
|---|---|---|---|---|
| DR-001 | 2026-07-21 | Notes generation and review must show useful generation progress, open the proposal automatically, and put Cancel, Approve & commit, and Request edits into one coherent review flow. Migration-note review also needs auto-scroll, a real added/removed diff, tappable paper references, words rather than characters, and full paper/discussion context. | `partial` | Auto-open shipped in [#211](https://github.com/kamilkhan52/research-companion/pull/211). The PR explicitly deferred progress copy, unified actions, and the diff. Current `NotesReviewSheet` still has only Approve & commit + Cancel; request changes remains outside the sheet. Design and ship the remaining flow together. |
| DR-002 | 2026-07-21 | A running Discover search needs Cancel/Stop. Preserve safe partial results when possible; otherwise show a clear cancelled/empty state. | `implemented — verify` | The first-tap reversion shipped in [#205](https://github.com/kamilkhan52/research-companion/pull/205); live finds shipped in [#308](https://github.com/kamilkhan52/research-companion/pull/308) and [#309](https://github.com/kamilkhan52/research-companion/pull/309). The current change adds project/user-scoped cooperative Stop: it halts before the next provider stage, preserves the prior completed result, retains already-published finds as clearly unranked partial evidence, and gives a clear stopped/empty state. Verify Stop early, after finds appear, with previous results present, and across a network interruption. |
| DR-003 | 2026-07-21 | When a response discusses a figure, place the matching figure card immediately before or at its first mention. | `partial` | Prompt coverage and native arXiv sourcing shipped in [#201](https://github.com/kamilkhan52/research-companion/pull/201); the Markdown renderer still emits cards after the paragraph containing the reference. The old request to call this response “Summary” was superseded by Kamil's later “Paper summary” decision ([#282](https://github.com/kamilkhan52/research-companion/pull/282)). |
| DR-004 | 2026-07-21 | Use one compact, uniform Add entry point across the app; remove oversized specific-paper surfaces. Adding a known title/link should proceed directly into the live/running discussion instead of returning to Reading Mode for work that already started. | `partial` | Discover's oversized card became a compact inline `or` field and hides during a run in [#308](https://github.com/kamilkhan52/research-companion/pull/308). The empty-project Library hub and `?specific=1` route remain separate surfaces, and add-by-reference currently routes to the paper without automatically starting its analysis. |
| DR-005 | 2026-07-21 | Library filter labels should match the actual states exactly: All, Unread, Discussing, Read. | `open` | Current labels are `All`, `To read`, `In progress`, `Done` in `mobile/src/app/(tabs)/index.tsx`. Sort persistence/default behavior was separately completed in [#202](https://github.com/kamilkhan52/research-companion/pull/202). |
| DR-006 | 2026-07-21 | Remove the explanatory subtitle beneath pending-response activity; keep only short truthful activity phrases. | `open` | `activity_detail` is still rendered and includes prose such as “Connecting your message to the paper and prior turns.” Keep useful tool/progress state, but remove the redundant subtitle from the compact pending card. |
| DR-007 | 2026-07-21 | Make Map's current-paper/process details collapsible and put filters in a collapsible horizontal rail. | `open` | Pagination, labels, in-plot counts, constant-size labels, and zoom behavior shipped and were device-confirmed; this space-saving control treatment did not. |
| DR-008 | 2026-07-21 | Authors/Labs cards should use compact icon-and-count metadata, omit the unexplained year, call the action “Get profile,” and produce a meaningfully longer grounded profile. Labs should foreground institutions/labs rather than repeat Authors. | `partial` | Labs is now institution/lab-first, but author cards still show text chips plus `active_years`, and the action remains `Generate profile`. Audit the prompt/output cap together with the client polish. |
| DR-009 | 2026-07-21 | Sentence comments should remain structured attachment-like chips above the composer, while the backend supplies them to the agent without pasting them into the user's visible typed message. | `partial` | Sentence selection and queued chips shipped in [#178–#181](https://github.com/kamilkhan52/research-companion/pull/181) and passed the device flow. The outgoing transcript/message representation still needs a deliberate structured-attachment contract rather than visible text composition. |
| DR-010 | 2026-07-21 | New Project with 4+ projects must keep the name field/actions above the keyboard. | `implemented — verify` | Dedicated top-anchored create panel shipped in [#209](https://github.com/kamilkhan52/research-companion/pull/209). Re-run the original 4+ project device case. |
| DR-011 | 2026-07-21 | Continue Reading should use the prefetched last-opened thread/draft with no visible stale/spinner pause. | `implemented — verify` | Thread-aware prefetch shipped in [#210](https://github.com/kamilkhan52/research-companion/pull/210). The original complaint was perceptual (~1s), so closure still needs device timing acceptance. |
| DR-012 | 2026-07-21 | Canonical-title Update/Keep must preserve the live thread; mid-string editing must keep the caret stable; Keep mine must persist; Delete stays available from menu and swipe. | `implemented — verify` | Shipped in [#214](https://github.com/kamilkhan52/research-companion/pull/214). Run D1–D5 in [`device-test-r12-followups.md`](device-test-r12-followups.md). |
| DR-013 | 2026-07-21 | The first-read canonical pass should show concise progress, be reused by Map without re-paying, keep affiliations consistent, and let an opening paper summary explain how later project papers cite it. | `implemented — verify` | Mechanism shipped in [#213](https://github.com/kamilkhan52/research-companion/pull/213). Kamil device-confirmed the newer reading-mode paper-context card on 2026-07-31, but that is not the D06 incoming-citation-summary acceptance. Run B1–B3 and C1 in [`device-test-r12-followups.md`](device-test-r12-followups.md). |
| DR-014 | 2026-07-21 | Listening-mode responses should work as playlist tracks with Play next and optional autoplay, including background/lock-screen behavior. | `implemented — verify` | Shipped in [#215](https://github.com/kamilkhan52/research-companion/pull/215). Run E1–E6 in [`device-test-r12-followups.md`](device-test-r12-followups.md) on a current native build. |
| DR-015 | 2026-07-29 | Avoid nested accessible buttons inside the Continue Reading pressable; TalkBack/VoiceOver must reach dismiss and external-link actions reliably. | `deferred` | Known pre-existing accessibility debt recorded in `docs/production/10-roadmap.md`. Schedule one deliberate nested-control audit rather than another isolated button patch. |
| DR-016 | 2026-07-29 | Use skeleton screens for initial empty-cache loading, without replacing meaningful job progress or stale cached content. | `deferred` | Design and implementation guardrails are in `product-roadmap.md` U.26. Do after subscription/credit surfaces settle, before M10 launch rehearsal and store screenshots. |
| DR-017 | 2026-07-31 | Add a Quick Discover mode, optimized for first interaction latency. | `deferred` | Kamil explicitly deferred this until the parallel optimized default has real usage data. Slice 1 measured roughly 5–7 minutes; set Quick's quality/latency budget only after more device runs. |
| DR-029 | 2026-08-07 | Discovery slice 2 has never been run for real. Verify a cold search and an incremental one: reservoir size, elapsed time, spend, whether it resumes after an interruption, and whether the results are actually better than slice 1. | `implemented — verify` | Merged as [#311](https://github.com/kamilkhan52/research-companion/pull/311) and deployed, but no production run has ever been measured. The durable plan is `~/.claude/plans/keen-finding-rabin.md`. Slice 1 measured 418s and \$0.013; slice 2 widened recall substantially, so both numbers are expected to move and neither is known. |
| DR-030 | 2026-08-07 | Cooperative Stop on a running Discover search. Try it early, after live finds have appeared, with an older completed result present, and across a network interruption. | `partial` | Merged as [#310](https://github.com/kamilkhan52/research-companion/pull/310) and deployed. Kamil confirmed on 2026-08-07 that the Stop control is present and nothing looks wrong at a glance, so this is no longer blocking. What remains unverified is the BEHAVIOUR under the four conditions above — stopping early, stopping after live finds, stopping with an older completed result present, and across a network interruption. Return to it only if a real search misbehaves. This is the same acceptance DR-002 asks for; kept separate because DR-002 predates the implementation and this row names the shipped behaviour. |
| DR-031 | 2026-08-07 | The twelve-PR metering stack is live and invisible until something misbehaves. Watch for anything that used to work and now errors — narration, audio playback, notes edits, retrieval — and for provider spend that looks wrong in `/usage`. | `implemented — verify` | [#312](https://github.com/kamilkhan52/research-companion/pull/312)–[#323](https://github.com/kamilkhan52/research-companion/pull/323): exact-cost metering, the retirement of `/api/speak` and `/api/narrate`, per-user usage events, audio-cache eviction, prompt-injection framing, price-sorted routing. All backend; nothing should look different. A behavioural change here is a regression. |
| DR-032 | 2026-08-07 | Per-account rate limits are live: 20 job starts a minute, 4 concurrent. Confirm ordinary reading never trips them, and that if one does trip the message is clear rather than a raw failure. | `implemented — verify` | [#325](https://github.com/kamilkhan52/research-companion/pull/325), deployed. Continuations are exempt, so a listening turn's narration and auto-analysis should not consume slots — that exemption is the part most likely to be wrong in practice. |
| DR-033 | 2026-08-07 | Graph extraction now runs on DeepSeek V4 Flash-0731 rather than V4 Pro. Build a map on a real project and judge whether the references are as good — this changes what the whole reference graph is built from. | `implemented — verify` | Kamil's call, 2026-08-07. Verified live on a toy reference list (all references parsed) but never on a 90 KB paper. §2b prices it at \$0.00721/paper against Pro's \$0.03343, which is what makes a large map affordable — but quality on real papers is the open question, not cost. |
| DR-034 | 2026-08-07 | The spend ceiling's refusals have no client handling. When a 402 or 429 arrives the server's message is shown, but nothing retries after `Retry-After`, nothing shows remaining budget, and there is no upgrade path. | `open` | [#326](https://github.com/kamilkhan52/research-companion/pull/326) is merged but deliberately NOT deployed. `grep` for `402`/`429`/`quota_exceeded`/`holds_outstanding` across `mobile/src` and `web/src` returns nothing. Design belongs with the usage/80%-warning surface rather than a bolted-on toast; mockups exist and Figma work is queued. |

## Shipped work still awaiting device acceptance

Folded in from `product-roadmap.md` on 2026-08-04. These rows were marked complete there with a
trailing "device pass pending" note, which meant the *implementation* backlog was visible while the
*verification* backlog was not — several had been waiting since Round 9 with no id and no single
view. They are ordinary ledger rows now: same ids, same rule that only Kamil's device confirmation
moves one to `closed`.

The roadmap remains the delivery-order record; when one of these closes, update both.

| ID | Raised | Feedback / acceptance | State | Evidence / next action |
|---|---|---|---|---|
| DR-018 | 2026-07-17 | Paper figures appear in chat: arXiv-sourced figure cards render with captions beside the response that discusses them. | `implemented — verify` | Shipped in phases R.10a–R.10c ([#154](https://github.com/kamilkhan52/research-companion/pull/154)/[#155](https://github.com/kamilkhan52/research-companion/pull/155)/[#156](https://github.com/kamilkhan52/research-companion/pull/156)); design in `docs/chat-figures-design.md`. Verify on a paper with real arXiv HTML figures. Placement itself is a separate open defect — see DR-003. |
| DR-019 | 2026-07-17 | Listening cues stop repeating "synthesizing" and report only on real progress; audio keeps playing when the app is backgrounded. | `implemented — verify` | [#160](https://github.com/kamilkhan52/research-companion/pull/160), [#192](https://github.com/kamilkhan52/research-companion/pull/192). Cues are progress-gated; Android continues after backgrounding and removal from recents; iOS declares the playback/spoken-audio session and background-audio mode. **Android acceptance and a fresh native iOS build both remain.** |
| DR-020 | 2026-07-17 | Reply composer redesign: send button inside the field, full width, no stray separator line beyond the rounded shape. | `implemented — verify` | [#166](https://github.com/kamilkhan52/research-companion/pull/166) — one floating rounded card, transparent container so no strip shows. Check against the Gemini reference Kamil supplied. |
| DR-021 | 2026-07-21 | Annotate mode opens with a quiet sentence-selection cue and a Done escape hatch; composer transitions animate without disturbing ordinary message rendering. | `implemented — verify` | [#181](https://github.com/kamilkhan52/research-companion/pull/181), phase 4 of R9.2. The structured-attachment contract for the outgoing message is separately open — see DR-009. |
| DR-022 | 2026-07-21 | Listening preview cues keep going through slow flat synthesis segments and stop only at a terminal or playable audio state. | `implemented — verify` | [#177](https://github.com/kamilkhan52/research-companion/pull/177) — bounded grounded keepalive. Verify on a genuinely slow synthesis, not a fast one. |
| DR-023 | 2026-07-21 | Empty-project Add Papers hub; hierarchical sort directions with chronological defaults; compact explicit Move/Copy/Delete selection actions. | `implemented — verify` | [#183](https://github.com/kamilkhan52/research-companion/pull/183) — automated verification passed. Note DR-004 wants the Add surfaces unified; this hub is one of the surfaces that review should cover. |
| DR-024 | 2026-07-21 | Human-confirmed canonical titles; stable-slug Rename/Delete; durable source status with Fetch/auto-fetch, resolver recovery, and guarded PDF upload. | `implemented — verify` | [#184](https://github.com/kamilkhan52/research-companion/pull/184) — automated verification passed. Overlaps DR-012's D1–D5 script in [`device-test-r12-followups.md`](device-test-r12-followups.md); run them together. |
| DR-025 | 2026-07-21 | Compact first-turn prompt/model selection; paper-summary Retry reopens the same configuration and stores prompt/mode per response branch. | `implemented — verify` | [#185](https://github.com/kamilkhan52/research-companion/pull/185) — automated verification passed. Verify Retry reuses the configuration rather than resetting to defaults. |
| DR-026 | 2026-07-21 | Independent per-paper discussion threads: arbitrary compose-first messages, thread-scoped jobs/drafts/audio/retries, all-thread notes synthesis, complete Move/Copy history. | `implemented — verify` | [#187](https://github.com/kamilkhan52/research-companion/pull/187) — automated verification passed. Large surface; verify thread scoping of audio and retries specifically, since those cross job boundaries. |
| DR-027 | 2026-07-21 | Cross-project deterministic paper identity, app-wide duplicate preflight, safe Copy default, explicit Move, reusable source/history visibility, immediate sequential Notes integration. | `implemented — verify` | [#188](https://github.com/kamilkhan52/research-companion/pull/188) — automated verification passed. Verify the duplicate preflight against a paper genuinely present in two projects. |
| DR-028 | 2026-07-21 | Persisted Comfortable/Tight density with a density-aware style cache; tighter type/card/list/chat rhythm while touch targets, math, code, and audio controls stay protected. | `implemented — verify` | [#189](https://github.com/kamilkhan52/research-companion/pull/189) — automated verification and a local-Figma comparison passed. Verify touch targets and equation legibility at Tight, which is where protection is most likely to have slipped. |

## Planned product work adjacent to device feedback

These are not forgotten device defects, but they are the immediate continuation of the work that
was active when this ledger was created:

| Work | State | Next boundary |
|---|---|---|
| Discovery slice 2 — OpenAlex topic sweep, Semantic Scholar `search/bulk`, incremental frontier, stage checkpoints | `implementation ready — review` | Draft [#311](https://github.com/kamilkhan52/research-companion/pull/311), stacked on #310, keeps grounded and lexical lanes independent, persists the candidate reservoir before advancing frontiers, resumes completed stages, and measures protected title-drop false negatives. After review/merge, run one cold and one incremental production-device search to measure reservoir size, elapsed time, spend, resume behavior, and result quality. |
| Discovery slice 3 — comparative reading path and client surface | `planned` | One comparative `v4-pro` call using the marker protocol; path/coverage/why UI only after slice 2's recall reservoir is measured. |
| M3 metering, quotas, and model enforcement | `planned` | Production launch priority: close P0-4/P0-17 before twelve testers can spend against shared provider keys. |

## Reconciled Round-12 implementation history

The Round-12 queue had stale `queued` labels even though these merged. They remain listed here so
future sessions do not re-investigate them: R12.2 → #204, R12.3 → #206, R12.4 → #202, R12.5 →
#203, R12.8 → #208, R12.12 → #209, R12.15 → #210. R12.14's first-tap half → #205; its
cancellation half is DR-002. R12.10's auto-open half → #211; the remaining review UX is DR-001.
