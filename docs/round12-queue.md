# Round-12 queue — 2026-07-21 device pass + usage notes

Execution ledger for the session working through the failures in
`docs/current-device-test-checklist.md` and Kamil's 2026-07-21 usage notes. Workflow per item:
implement on a branch, PR, codex CLI review (GPT 5.6 Sol, high reasoning), fix findings, merge.
Update the Status column as items land.

## Investigations (findings recorded, fixes are queue items)

- **I1 — Web search is "spotty" in discussions: root cause found.** The live server runs
  without `RC_AGENTIC`, so `agent_harness.AGENTIC_ENABLED` is false and every turn takes the
  single-shot `agent.py` path, which has **no tools at all**. DeepSeek then narrates an intent
  to search without being able to; Sonnet honestly reports no search tool exists. Not a model
  problem; tool calls have been impossible on every turn. Fix tracked as R12.8. A separate
  tool-calling model choice is a later follow-up, deliberately after R12.8.
- **I2 — Full paper analysis is split across two pipelines.** Fetch/first-read warms figures,
  covers, and (since #196) first-page affiliations into `paper_metadata`; Map build separately
  does OpenAlex enrichment, citations, an LLM affiliation fallback cached in graph data, and a
  figures backfill. Related-works/citation evidence exists only via Map build — which is why
  D05 saw late affiliations and D06's opening summary lacked citing evidence. Unification
  tracked as R12.9.

## Queue

| # | Item | Source | Status |
|---|------|--------|--------|
| R12.1 | Figure-card visibility: prompt coverage on all first-response/summary paths, explicit "show figures" handling, native-arXiv HTML image-path fix; card placement at/before first mention; rename first response to **Summary** everywhere | D27 + in-flight work | in progress |
| R12.2 | Resuming a paper (Continue Reading or any entry) opens the **last-opened thread**, not the first | usage notes | queued |
| R12.3 | **Hide** action on recommended papers so Discover recommendations stay relevant | usage notes | queued |
| R12.4 | Default sort = **Last Interacted, most recent first**; persist per-project sort (D10 note) | usage notes + D10 | queued |
| R12.5 | Marquee/hero title: first appearance must start at the rolling left position — no mid-screen start or snap | usage notes | queued |
| R12.6 | Floating rounded surfaces (composer, mini player, project selector, …) must not reveal a rectangular backdrop over underlying content; transparent + subtle shadow | usage notes | **done** — composer & project pill float as absolute overlays over the scrolling list (measured onLayout inset so content scrolls behind); mini-player is now a plain full-width bar; device-confirmed (PR follow-up to #207) |
| R12.7 | Responses as playlist tracks: easy play-next when the current response ends + optional autoplay | usage notes | queued |
| R12.8 | Make the agentic tool loop the default turn path (retire the silent `RC_AGENTIC` footgun), keep an explicit off switch, and surface tool calls in the chat UI | I1 | queued |
| R12.9 | Single full-paper pass: one canonical per-paper record (affiliations, figures, citations/related works, covers) produced on first full-text analysis and reused by Map build — never divergent per-surface passes; concise progress steps shown during first read | I2 + usage notes | queued |
| R12.10 | Notes generation/review UX: visible progress, auto-open the proposal, Cancel/Approve/Request-edits together on the review screen | D03 | queued |
| R12.11 | Opening summary must use completed-Map incoming-citation evidence (substantive vs background) | D06 | queued |
| R12.12 | New Project sheet: keyboard must reveal the name input/actions with 4+ existing projects | D08 | queued |
| R12.13 | Canonical-title approval must keep the live discussion attached; fix mid-string edit cursor jump; "Keep it" persists and suppresses future prompts | D12 | queued |
| R12.14 | Build Graph / Discover Search first tap must keep the running view (no flash-revert); add search cancel + safe partial results | D17 + D18 note | queued |
| R12.15 | Continue Reading opens with the prefetched draft — no ~1s stale/spinner pause | D39 | queued |

## Secondary polish backlog (from passing items' notes — pick up after the queue)

- D02: drop the explanatory subtitle under the pending-response activity; keep short truthful
  phrases only, template-driven.
- D09/D20: one compact uniform Add entry point (round +); remove oversized "Have a specific
  paper?" surfaces; explicit add navigates straight into the live discussion.
- D14: notes-revision auto-scroll, added/removed diff view, redesigned review actions, tappable
  paper references, words-not-characters counter, full-context integration passes.
- D19: collapsible Map details disclosure + filter rail.
- D20: Discover result evidence (affiliations, venue, recency, citations, why-selected);
  investigate the empty "Reinforcement learning for system design problems" run.
- D21: compact icon metadata on Authors/Labs, remove stray year, make Labs institution-first,
  "Get Profile" rename + longer profile budget.
- D26: keep sentence comments as structured attachments above the composer; append server-side.
