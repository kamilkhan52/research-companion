# Device-review feedback ledger

Canonical intake ledger for feedback Kamil raises while using the app on a real device. This file
tracks the feedback from the moment it is reported until implementation **and** physical-device
acceptance. The scenario-oriented acceptance scripts remain in
[`current-device-test-checklist.md`](current-device-test-checklist.md) and focused follow-up files;
the production and product roadmaps still decide delivery order.

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

## Planned product work adjacent to device feedback

These are not forgotten device defects, but they are the immediate continuation of the work that
was active when this ledger was created:

| Work | State | Next boundary |
|---|---|---|
| Discovery slice 2 — OpenAlex topic sweep, Semantic Scholar `search/bulk`, incremental frontier, stage checkpoints | `planned` | Implement from `~/.claude/plans/keen-finding-rabin.md`; keep grounded and lexical lanes independent, preserve the false-negative audit/protected quotas, and make a restart resume rather than re-buy a long run. |
| Discovery slice 3 — comparative reading path and client surface | `planned` | One comparative `v4-pro` call using the marker protocol; path/coverage/why UI only after slice 2's recall reservoir is measured. |
| M3 metering, quotas, and model enforcement | `planned` | Production launch priority: close P0-4/P0-17 before twelve testers can spend against shared provider keys. |

## Reconciled Round-12 implementation history

The Round-12 queue had stale `queued` labels even though these merged. They remain listed here so
future sessions do not re-investigate them: R12.2 → #204, R12.3 → #206, R12.4 → #202, R12.5 →
#203, R12.8 → #208, R12.12 → #209, R12.15 → #210. R12.14's first-tap half → #205; its
cancellation half is DR-002. R12.10's auto-open half → #211; the remaining review UX is DR-001.
