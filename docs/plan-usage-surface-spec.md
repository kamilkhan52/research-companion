# Scholiast plan and usage surface

Status: fallback design handoff, created 2026-08-07. Figma write access was unavailable during
this pass, so the editable source and rendered assets are checked in under
`docs/design-references/plan-usage-2026-08/`. The intended Figma destination remains file
`Research Companion — UI Redesign Proposal`, page `02 · Mobile Screens`, existing section
`17 · Production Readiness · Accounts, Usage & Billing`.

When Figma write access returns, refine the existing `Usage` frame (`90:116`) into
`Usage · Normal · Light`, then place these siblings beside it inside that same section:
`Settings entry`, `Normal`, `Approaching`, `Exhausted`, `Busy — not exhausted`, `Too large`, and
`Not enforced`, each with `Light` and `Dark` suffixes. Do not create a duplicate page or leave any
variant loose on the canvas.

## Superseded in part, 2026-08-10 — remaining, not consumed

Kamil's first tester pass reversed one decision below: the surface should show what is **remaining**,
not what has been consumed (DR-041). Everything else here still holds, including the rule that
governs how to do it — **remaining must be `limit - spent`, never `remaining_nanousd`**, which
subtracts holds too and would tell a reader with several jobs running that most of their month is
gone. That is the exact false alarm the spend/held split exists to prevent; it would simply be
arriving through the front door instead.

Read the percentage sections below as being about the same number seen from the other side.

## Product decision

The reader sees **neither credits nor dollars**. The surface shows the server-authoritative
percentage of the monthly allowance that has actually been spent, the reset date, and the plan's
promise in reading terms.

- Dollars describe Scholiast's provider cost, not value to a reader.
- Credits are fungible internal cost units. A reader cannot predict whether the next paper will
  consume 8, 80, or 800 of them, so a raw balance looks precise without being actionable.
- Papers and narration minutes are understandable promises, but the balance is fungible and the
  API does not split it into per-feature buckets. They therefore describe the plan, never a
  remaining estimate.
- Percentage is the only numeric usage signal in the primary UI. It comes directly from
  `spent_fraction`; the client does not derive it from nano-USD fields.

Internal QA still needs the plan constants: tester = 5,000 credits / $5.00; free = 200 credits /
$0.20; basic = 2,500 credits / $2.50. Those numbers do not appear in reader-facing copy.

## Information architecture

Add one row near the top of Settings, in an `ACCOUNT` group:

- Label: `Plan & usage`
- Subtitle: plan summary (for example, `Testing plan` or `20 papers a month · 45 min studio voice`)
- Trailing: chevron only; no balance badge
- Tap: push `/plan`, retaining the existing Settings top-bar/back behavior

This is a detail screen, not an inline Settings card. Settings is already long and configuration-
dense. The allowance needs one calm page where the spent/held distinction can be explained without
turning every Settings visit into a usage check. When `enforced` is false, omit the row entirely.
If `/plan` is already visible when enforcement becomes false (sign-out or connectivity/config
change), navigate back without showing a zero or an allowance-unavailable card.

## The core visual rule: spent and held never share a bar

`spent_fraction` owns the single violet progress bar. It is durable month-to-date spend and is the
only value that can trigger the 80% warning.

When `held_nanousd > 0`, show a separate amber-tinted live-work card below the spend card:

- activity glyph, `IN PROGRESS NOW`, `Some work is finishing`
- `A little room is temporarily set aside. It returns as the work finishes.`
- no percentage, no shared axis, no stacked segment, and no combined “remaining” number

When `held_nanousd === 0`, omit that card. Never use `remaining_nanousd` as a month-left label: it
subtracts holds and would recreate the exact false alarm this design is intended to prevent.

## State mapping

| Surface | Authoritative condition | Treatment and copy |
|---|---|---|
| Normal | `enforced && spent_fraction < warn_at_fraction` | Detail screen. Violet spend-only bar, reset date, plan promise. Optional separate live-work card when held is non-zero. |
| Approaching | `enforced && spent_fraction >= warn_at_fraction && spent_fraction < 1` | Same geometry. Violet spend bar plus amber information card: `You're getting close` / `Nothing is blocked. Scholiast will keep working until this month's allowance is used.` |
| Exhausted | Action response `402`, `code: quota_exceeded`, and `requested_nanousd <= limit_nanousd` | Mid-flow modal: `This month's allowance is used`. Say exactly when paid work returns. Primary `Keep reading`; secondary `View plan & usage`. No upgrade CTA. |
| Busy, not exhausted | Action response `429`, `code: holds_outstanding` | Mid-flow amber modal: `A few things are finishing`. Explain that running work briefly has room set aside. Disable retry until `Retry-After`; button counts down, then becomes `Try again`. Never mention the monthly reset. |
| Too large for plan | Action response `402`, `code: quota_exceeded`, and `requested_nanousd > limit_nanousd` | Contextual mid-flow modal: `This narration won't fit your plan`. State that waiting will not help. Prefer an available no-cost alternative (`Use device voice` for premium narration); otherwise `Choose a smaller action`. No upgrade CTA. |
| Not enforced | `enforced === false` | Omit the Settings row and the detail surface. Do not show a zero, empty bar, plan allowance, or disabled card. |

Job snapshots can also carry these safe refusal strings after background continuation. Map them to
the same modal treatment rather than exposing a generic job error. Do not infer “busy” from
`held_nanousd > 0`; only the server refusal says the new action cannot fit.

**On the server's `warn` flag (corrected 2026-08-09).** An earlier revision of this spec assumed
`warn` was the 80%-of-spend warning and told implementers to treat any disagreement with
`spent_fraction` as a contract fault. It is not that flag. `warn` is computed from spend **plus
holds**, deliberately, so that it can fire before admission refuses — and admission refuses on the
sum. Read it as *reservation pressure*, not as "the month is nearly gone".

That makes it the wrong input for everything on this screen: at 76% spent with a listening flow in
flight it is true, while the month is three-quarters intact. So **the Approaching card and the bar
key off `spent_fraction` alone**, and `warn`/`at_capacity` are not rendered here at all.

They are also **not** a way to infer a refusal. Every modal in the table above is selected from an
actual `402`/`429` action response, never from a flag predicting one — a client that opened the
exhausted modal because `warn` was true would be refusing work the server was still willing to do.

## Plan copy

Use server `plan.summary` verbatim in the plan card. Presentation labels are title case only:

| `plan.name` | Display label | Supporting treatment |
|---|---|---|
| `tester` | `Tester` | `Testing plan — generous allowance while the app is in review` |
| `free` | `Free` | `3–4 papers a month, your device's voice` |
| `basic` | `Basic` | `20 papers a month, 45 minutes of studio narration` |

`premium_audio` may drive a compact `Studio narration included` / `Device voice` row, but it must
not imply separate audio credits. `monthly_credits` and all nano-USD fields remain transport data.

## Layout and styling

- Canvas: 393 × 852 Android, including 48 px status area and 24 px gesture area.
- Horizontal page inset: 20 px. Primary cards: 353 px wide.
- Top bar: 88 px high below status area; 52 px circular back target.
- Spacing: 4 / 8 / 12 / 16 / 24 / 32. Cards use 16–20 px internal padding.
- Radius: 12 small, 16 medium, 20 large, 26 extra-large, pill for chips/actions.
- Type: Manrope for status, labels, controls, and cards. Newsreader only for the 28–30 px editorial
  page heading and 27–29 px interruption heading.
- Light tokens are copied from `mobile/src/theme/tokens.ts`: `#F3F1EA` canvas, `#FBFAF6` surface,
  `#FFFFFF` elevated, `#1C2129` text, `#5D6879` muted, `#15795F` action, `#6A55E0` usage,
  `#8F6411` in-flight, `#C2385A` danger.
- Dark uses the existing Dim palette: `#0B0D12` canvas, `#151922` surface, `#1B202B` elevated,
  `#F3F0E8` text, `#99A3B7` muted, `#65D6B4` action, `#9B8AFB` usage, `#E4B85C` in-flight.
- Borders use the existing `line2` token at 1 px. Do not add Android elevation rectangles.
- Violet means usage/evidence. Amber means transient/in-flight. Exhaustion remains violet and
  neutral rather than danger-red because it is a planned boundary, not data loss.

## Interaction details

- Progress bar animation: 250 ms ease-out on refetch; never animate from zero on every focus.
- Pull to refresh and refetch on screen focus. Do not poll the detail screen merely to animate
  holds. Those two are currently the ONLY refresh paths: nothing invalidates the plan when a job
  settles, which is DR-036 rather than an oversight — covering it means every metered subsystem'''s
  terminal outcomes, and covering three of them is what produced two rounds of review findings.
- Busy retry: parse `Retry-After` seconds, use a monotonic local countdown, and enable retry at
  zero. Do not auto-submit the action.
- Modal dismissal: Android back and `Not now`/`Keep reading` both return to the exact prior flow.
- `View plan & usage` closes the modal before navigating, preventing a stale modal on back.
- Dates are local-calendar strings (`Resets September 1`), derived from `period_ends`; do not show
  a raw ISO timestamp or a “days left” value that can drift across midnight.
- No `Manage plan` control in M3. A future placeholder may be added only as disabled design
  annotation, never as a tappable row in shipped UI.

## Accessibility and copy constraints

- Progress accessibility label: `18 percent of this month's allowance used.` It must not include
  held work.
- Live-work card label: `Work in progress. Some allowance is temporarily set aside and returns
  when the work finishes.`
- Minimum touch target 48 × 48; body copy at least 15 px; supporting copy 13 px.
- Do not rely on color alone: every warning/transient state has a title and explicit time horizon.
- Screen-reader focus moves to the interruption heading when the modal appears; focus returns to
  the triggering control on dismissal.

## Asset inventory

The companion directory contains light and dark 393 × 852 SVG exports for the Settings entry and
all six required states. PNG exports are generated from the same source for review/reference.
All graphics are UI-native line geometry; the implementation needs no bespoke bitmap or icon
asset. Reuse the app's existing icon set for back, calendar, activity, audio, and chevron glyphs.

## Correction applied 2026-08-07 — what actually still works when the allowance is used

The exhausted-state copy originally read *"Reading, notes, and device voice still work."* That
promises something the backend does not keep: the `notes` job registry is metered and reserves
budget (`app/notes_jobs.py`), so an AI notes edit is refused exactly like a turn or a narration.
Only three registries survive an exhausted allowance, and notes is not among them.

What genuinely still works: reading anything already retrieved, viewing and hand-editing notes,
and device-voice narration (which never reaches a paid provider). The copy now reads *"Reading and
device voice still work."*

The general rule for anyone extending these states: **a reassurance in this UI is a claim about
`reserves=True` on a registry.** Check the registry before promising a feature keeps working — a
reader who is told notes still work and then cannot save one has been told something false at the
exact moment they are least inclined to be forgiving.
