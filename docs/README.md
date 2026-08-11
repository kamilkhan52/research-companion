# docs — what is here, and which file is authoritative

Written 2026-08-09. Several of these files describe overlapping ground, and until this index existed
a third of them were referenced by nothing at all — which is how a design doc gets re-derived
instead of read. **If two files disagree, the one named authoritative here wins**; fix the other in
the same PR rather than leaving both.

Start with `README.md` and `CLAUDE.md` at the repo root. This index covers `docs/` only.

## Live ledgers — read these to know what to do next

| File | Authoritative for |
|---|---|
| [`device-review-ledger.md`](device-review-ledger.md) | Every piece of Kamil's device feedback, from report through device acceptance. **"What is waiting on Kamil" = every row that is not `closed`.** Merging never closes one. |
| [`current-device-test-checklist.md`](current-device-test-checklist.md) | The reproduction steps the ledger's rows link to. Scenarios, not a queue. |
| [`device-test-r12-followups.md`](device-test-r12-followups.md) | The focused acceptance scripts for DR-012, DR-013, DR-014 and DR-024. |
| [`product-roadmap.md`](product-roadmap.md) | Product delivery order and the acceptance bar per PR. |
| [`production/10-roadmap.md`](production/10-roadmap.md) | Launch-milestone order, locked decisions, architectural rules for production work. |
| [`production/HUMAN_ACTIONS.md`](production/HUMAN_ACTIONS.md) | Things only Kamil can do. Agents must not attempt or work around these. |
| [`improvements.md`](improvements.md) | The standing code-quality plan. |
| [`cleanup-plan.md`](cleanup-plan.md) | The docs/comment cleanup this index came from, and its phase status. |
| [`design-system-additions.md`](design-system-additions.md) | Every runtime token, its value and intent, and each component's states — written so someone with Figma access can reproduce them. |
| [`figma-runtime-design-handoff.md`](figma-runtime-design-handoff.md) | **The Figma node IDs.** 11 component sets, 189 variants, 22 section-17 screens. Search these before creating anything; `Usage` is `90:116` and must be updated in place, never duplicated. |

## Production reference

| File | Holds |
|---|---|
| [`production/00-current-state-audit.md`](production/00-current-state-audit.md) | The evidence base the roadmap was written against. |
| [`production/02-security-and-privacy.md`](production/02-security-and-privacy.md) | Code-derived storage/processor inventory and the Play Data Safety matrix. |
| [`production/04-ai-costs-quotas-and-abuse.md`](production/04-ai-costs-quotas-and-abuse.md) | The cost/abuse analysis behind M3. |
| [`production/20-pricing-analysis.md`](production/20-pricing-analysis.md) | Measured unit costs. **The credit peg — 1 credit = $0.001 — comes from here**, and `app/spend_limits.py` cites it. |
| [`production/30-ui-layer-brief.md`](production/30-ui-layer-brief.md) | The UI brief for the production surfaces. |
| [`production/40-device-test-runbook.md`](production/40-device-test-runbook.md) | How to prove what a Metro server is actually serving before saying "ready to test". |
| [`production/90-history.md`](production/90-history.md) | Completed milestones M1–M3, dated handoffs, the R14 pass. Rationale, not to-dos. |

## Design docs — rationale for features that shipped

Keep these. They record *why* a shipped design is the way it is, which no diff carries. They are not
plans, and nothing in them is outstanding work unless a ledger row says so.

- [`canonical-paper-pass-design.md`](canonical-paper-pass-design.md) — one per-paper record, reused
  by Map rather than re-derived (DR-013).
- [`canonical-title-identity-design.md`](canonical-title-identity-design.md) — the *other* canonical:
  titles, not data (DR-012). Do not conflate the two.
- [`paper-discussion-threads.md`](paper-discussion-threads.md) — independent per-paper threads (DR-026).
- [`cross-project-paper-identity.md`](cross-project-paper-identity.md) — deterministic identity across
  projects, duplicate preflight, Copy/Move (DR-027).
- [`project-forking-design.md`](project-forking-design.md) — splitting a project; implemented by
  `app/project_split.py`.
- [`audio-playlist-design-brief.md`](audio-playlist-design-brief.md) — responses as playlist tracks (DR-014).
- [`player-jump-controls-design-brief.md`](player-jump-controls-design-brief.md) — transport controls.
- [`text-comments-design.md`](text-comments-design.md) — sentence comments as structured attachments (DR-009).
- [`chat-figures-design.md`](chat-figures-design.md) — figure cards in chat (DR-003).
- [`theming-design.md`](theming-design.md) — the theme system.
- [`icon-design.md`](icon-design.md) — icon direction. Start from the scholiast idea, not paradigm-shift.
- [`web-rebuild-plan.md`](web-rebuild-plan.md) — the phased React+Vite rebuild; still in progress.
- [`mobile-app-plan.md`](mobile-app-plan.md) — the native-app direction; phases C/D still ahead.

## Specs and proposals

- [`plan-usage-surface-spec.md`](plan-usage-surface-spec.md) — the plan/usage client surface.
  **Shipped** (#336, reframed to remaining in #350); the spec's own header records the part that was
  superseded. The SVG frames in `design-references/plan-usage-2026-08/` are a stale fallback handoff
  — the live design is in Figma, see the node IDs above.
- [`job-notifications-design.md`](job-notifications-design.md) — DR-050: push notifications on
  long-job completion. Planned; nothing built.
- [`scheduled-discovery-design.md`](scheduled-discovery-design.md) — DR-051: plan-bound scheduled
  discovery via a persisted next-run timestamp (supersedes the rebuild plan's no-scheduler
  decision). Planned; nothing built.
- [`map-discover-merge-design.md`](map-discover-merge-design.md) — DR-052: one corpus-neighbourhood
  pipeline beneath the Map and Discover tabs. Planned; nothing built.
- [`comment-mode-polish-design.md`](comment-mode-polish-design.md) — DR-053: comment-mode fixes and
  the dead-taps investigation (shared root cause suspected with DR-055). Planned; nothing built.
- [`performance-proposal.md`](performance-proposal.md) — mobile performance suggestions, 2026-08-03.
  Nothing here has been actioned.
- [`author-affiliation-view-proposal.md`](author-affiliation-view-proposal.md) — Authors/Labs view.
- [`semantic-scholar-graph-spike.md`](semantic-scholar-graph-spike.md) — the S2 graph spike.

## History

- [`initial-plan.md`](initial-plan.md) — the founding 2026-06-16 design. Its own header lists what
  has since diverged; treat it as provenance, never as instruction.
- [`discovery-quality-evaluation.md`](discovery-quality-evaluation.md) — the pre-rebuild Discover
  pipeline. Its **fixture** half is still live; its pipeline half is not.
- [`figma-workflow.md`](figma-workflow.md) — how UI design work was driven through Codex + Figma.
  Codex is out of quota as of 2026-08-10, so read this as the shape of the workflow rather than the
  current tooling.
