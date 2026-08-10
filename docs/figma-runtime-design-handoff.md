# Figma runtime-design implementation handoff

Date: 2026-08-09

Status: implemented and validated in Figma. Code on `design/ui-polish` remains authoritative.

This records the Figma work specified by [`design-system-additions.md`](design-system-additions.md)
so the next Claude Code session can continue the code and UX work without rediscovering the file,
node IDs, component matrices, or implementation constraints.

## Target and access

- File: [Research Companion — UI Redesign Proposal](https://www.figma.com/design/O62BbV7CcCOf3O55HKAjtK/Research-Companion-UI-Redesign-Proposal?node-id=90-102)
- File key: `O62BbV7CcCOf3O55HKAjtK`
- `01 · Design System`: `1:2`
- `02 · Mobile Screens`: `3:2`
- Production-readiness section: `90:102`
- Figma Desktop Bridge has working read/write access. A create/remove write probe and all writes
  below succeeded.
- The managed Figma MCP endpoint reached its Starter-plan call cap during the run, but the Desktop
  Bridge remained connected and completed the work through the same Figma Plugin API.
- Code Connect was attempted on `Surface / Tone` and rejected because the account does not have a
  Dev or Full seat on an Organization/Enterprise plan. Each component description therefore carries
  its runtime source path until the seat/plan is upgraded.

## Claude Code coordination

The live Claude Code session in tmux session `research-companion-f3` was messaged through the CLI
before implementation. Its handoff established these constraints, all of which were followed:

- Update the existing design-system page; do not create a parallel system page.
- Preserve and update Usage frame `90:116`; do not replace the frame or duplicate it.
- Put every new screen example inside section `90:102`.
- Treat runtime code as authoritative and do not import the stale SVG references under
  `docs/design-references/`.
- Preserve Dim, Black, Light and Comfortable/Tight behavior.
- Keep allowance, live holds, and refusals as distinct concepts. Holds do not share the allowance
  meter or axis.
- Do not add credits, prices, upgrade CTAs, red limit warnings, or refusal copy that blames the
  reader.
- Usage-unavailable must not render a full or zero meter.
- Refusal sheets are driven by actual `402`/`429` responses, not `plan.warn`.
- Review continues to enforce the human-approval boundary.
- Reconnecting is non-dismissible, non-Danger, and uses the exact safe-response copy.
- Do not model unmerged future decision records such as DR-042, DR-043, DR-046, DR-047, or DR-048.

## Foundations added

All runtime-independent values were added to the existing `Research Companion` collection
(`VariableCollectionId:52:1406`, mode `Scholar Dark`). No parallel collection was created.

| Variable | ID | Value | Code syntax |
|---|---|---:|---|
| `Control/min-touch` | `VariableID:111:99` | 48 | `control.minTouch` |
| `Control/standard` | `VariableID:111:100` | 50 | `control.standard` |
| `Control/icon-halo` | `VariableID:111:101` | 48 | `control.iconHalo` |
| `Control/icon-halo-compact` | `VariableID:111:102` | 36 | `control.iconHaloCompact` |
| `Control/progress` | `VariableID:111:103` | 8 | `control.progress` |
| `Type/Financial floor/body` | `VariableID:111:104` | 15 | `moneyType.body` |
| `Type/Financial floor/body-line` | `VariableID:111:105` | 23 | `moneyType.bodyLine` |
| `Type/Financial floor/supporting` | `VariableID:111:106` | 13 | `moneyType.supporting` |
| `Type/Financial floor/supporting-line` | `VariableID:111:107` | 18 | `moneyType.supportingLine` |
| `Motion/quick` | `VariableID:111:108` | 160 | `motion.quick` |
| `Motion/standard` | `VariableID:111:109` | 250 | `motion.standard` |
| `radius/sm` | `VariableID:114:231` | 12 | `radius.sm` |
| `radius/md` | `VariableID:114:232` | 16 | `radius.md` |

Financial text styles:

- `Typography/Financial/Body`: `S:8c83ecc62d8fcda7083990122e6da18aa9e0db8c,` — Manrope Regular 15/23.
- `Typography/Financial/Supporting`: `S:eff65d96b589b3c88c0873df9673ae65f20e96a9,` — Manrope Regular 13/18.

Palette parity required one missing semantic Violet-wash path. No palette value was invented:

- Dim `color/wash/violet`: `VariableID:114:162`, aliasing existing primitive `VariableID:74:13`.
- Black primitive/semantic: `VariableID:114:163` / `VariableID:114:164`.
- Light primitive/semantic: `VariableID:114:165` / `VariableID:114:166`.

The variable-bound documentation section is
`Runtime foundations · Protected geometry / Financial / Motion` (`114:119`).

## Components built

All component sets are on `01 · Design System`, inside named sections rather than loose on the
canvas. Variant counts were checked after construction.

| Component set | Node ID | Variants | Runtime source recorded in Figma |
|---|---|---:|---|
| `Surface / Tone` | `114:325` | 30 | `mobile/src/ui/index.tsx` (`ToneSurface`) |
| `Icon / Tone halo` | `114:447` | 30 | `mobile/src/ui/index.tsx` (`ToneIcon`) |
| `Meter / Allowance` | `114:461` | 3 | `mobile/src/ui/index.tsx` (`AnimatedProgressBar`) |
| `Status / Reconnecting` | `114:505` | 6 | `mobile/src/components/ConnectionNotice.tsx` |
| `Review section` | `114:678` | 12 | `mobile/src/components/NotesReviewSheet.tsx`, `mobile/src/components/NotesDiff.tsx` |
| `Diff / Line` | `114:776` | 24 | `mobile/src/components/NotesDiff.tsx` |
| `Review actions` | `114:898` | 12 | `mobile/src/components/NotesReviewSheet.tsx` |
| `Map / Build card` | `114:1179` | 12 | `mobile/src/app/(tabs)/graph.tsx` |
| `Map / Filter rail` | `114:1421` | 12 | `mobile/src/app/(tabs)/graph.tsx` |
| `Input / Add known paper / Divider shown` | `114:1810` | 24 | `mobile/src/components/AddPaperInline.tsx` |
| `Input / Add known paper / Divider hidden` | `114:2100` | 24 | `mobile/src/components/AddPaperInline.tsx` |

`Input / Add known paper` was split by Divider because the unsplit
`Divider × State × Density × Theme` matrix is 48 variants and exceeds the 30-combination component
cap. Together the two sets represent the complete 48-state matrix.

Private swappable runtime icon sources are inside section
`Runtime components · Production readiness` (`114:167`) and use the `__Icon / ...` naming
convention. Do not recreate them before searching that section.

Other design-system sections created:

- `Runtime components · Review`: `114:507`
- `Runtime components · Map`: `114:900`
- `Runtime components · Add paper`: `114:1423`

## Section 17 screens

The existing Usage frame ID was preserved. It is now named `Usage · Remaining · Light`; all 69
legacy credit/paywall children were replaced inside that frame.

| Screen | Node ID |
|---|---|
| `Usage · Remaining · Light` | `90:116` |
| `Usage · Remaining · Dim` | `114:2130` |
| `Usage · Remaining · Black` | `114:2160` |
| `Usage · Approaching · Light` | `114:2190` |
| `Usage · In progress · Dim` | `114:2223` |
| `Usage · Unavailable · Light` | `114:2256` |
| `Usage · Remaining · Light [Tight]` | `114:2280` |
| `Usage · Approaching · Black [Tight]` | `114:2310` |
| `Usage · In progress · Light [Tight]` | `114:2343` |
| `Refusal · Allowance used · Light` | `117:2416` |
| `Refusal · Work finishing · Dim [Tight]` | `117:2440` |
| `Refusal · Starting quickly · Black` | `117:2460` |
| `Refusal · Narration too large · Light [Tight]` | `117:2480` |
| `Refusal · Other action too large · Dim` | `117:2503` |
| `Review · Proposed changes · Light` | `117:2520` |
| `Review · Loading failure · Dim` | `117:2560` |
| `Review · Stale proposal · Light` | `117:2568` |
| `Map · Build expanded · Dim` | `117:2576` |
| `Map · Filter expanded · Light` | `117:2625` |
| `Add paper · Ready · Light` | `117:2682` |
| `Add paper · Error · Black` | `117:2705` |
| `Discussion · Reconnecting · Dim` | `117:2730` |

Section `90:102` was enlarged to `1884 × 7768`. Its original eight account/onboarding screens remain
untouched; the new frames continue the existing four-column grid below them.

## Validation performed

The final Plugin API audit passed these checks:

- 11 expected component sets found; all 189 variants have the expected counts.
- 22 new/updated production-readiness frames found.
- No duplicate screen names, out-of-bounds frames, or overlapping screen frames.
- No broken variable aliases.
- No `credit`, `credits`, `upgrade`, price, dollar, Dismiss, lost-connection, or offline language in
  the new/updated frames.
- Required copy present: approval boundary, reconnecting notice, usage-unavailable notice,
  no-auto-submit note, device-voice fact, and UTC reset.
- Tone halos are 36/48 as specified.
- Review actions, map filter choices, and add-paper actions meet the 48 px minimum target.
- Added/Removed diff lines retain `+`/`−`; every Gap variant retains `•••` plus the description
  `Accessibility label: Unchanged lines omitted.`
- Final screenshots were taken for foundations, every component family, the updated Usage screen,
  refusal, review, map, add-paper, reconnecting, and the complete section-17 grid.

Two visual defects found during QA were fixed:

1. Review header copy had collapsed to 1 px; all 12 variants were corrected.
2. Editable text properties had overridden Project synthesis and Diff Gap content; variant-owned
   copy and the `•••` gap marker were restored.

## What Claude should do next

1. Continue treating the branch code and open PR #350 as authoritative. Update these Figma nodes
   only when the merged runtime contract changes.
2. Search by the exact IDs/names above before creating anything. The common duplication hazard is
   still Usage frame `90:116`.
3. If DR-042 or another deferred decision record lands, reconcile its code changes against the
   plan-summary/refusal examples rather than preemptively editing the current designs.
4. If a qualifying Figma seat/plan becomes available, add Code Connect mappings using the source
   paths in the component descriptions and verify them in Dev Mode.
5. Keep usage-unavailable, live holds, and actual spend refusal as three visually and semantically
   distinct states.
6. Preserve the existing approval boundary and the no-paywall refusal behavior.

No application source files were changed during the Figma pass. The only repository changes are
this handoff and the implementation-status link in `design-system-additions.md`.
