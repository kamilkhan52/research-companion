# Runtime design-system additions to reproduce in Figma

Status: code is authoritative for this pass. Figma was unavailable because the MCP server had no
credential; do not treat this file as evidence that the changes already exist in Figma.

Destination: `Research Companion — UI Redesign Proposal`. Add shared foundations and components to
`01 · Design System`; update the production-readiness frames in `02 · Mobile Screens`, section
`17 · Production Readiness · Accounts, Usage & Billing`. Preserve the existing Dim, Black, and
Light modes and Comfortable/Tight density variants.

## Foundations

### Protected geometry

Add a `Control` number group matching `mobile/src/theme/tokens.ts`:

| Token | Value | Intent |
|---|---:|---|
| `Control/min-touch` | 48 px | Minimum width and height for every interactive target at both densities. |
| `Control/standard` | 50 px | Comfortable-height primary control; Tight falls back to `min-touch`. |
| `Control/icon-halo` | 48 px | Standard circular status/icon container. |
| `Control/icon-halo-compact` | 36 px | Non-interactive icon container inside a larger card. |
| `Control/progress` | 8 px | Allowance meter thickness. |

Add a `Type/Financial floor` group. These values do not respond to density:

| Token | Value | Line height | Intent |
|---|---:|---:|---|
| `Financial/body` | 15 px | 23 px | Consequential allowance/refusal explanations. |
| `Financial/supporting` | 13 px | 18 px | Dates and compact supporting facts on money-adjacent surfaces. |

Add motion durations `Motion/quick = 160 ms` and `Motion/standard = 250 ms`. The allowance meter
uses `standard`, ease-out cubic, only between changed server values. It paints the first value
immediately and becomes an immediate state change when Reduce Motion is enabled.

No palette values were added. The new treatments intentionally compose the existing semantic
colors: Violet for allowance/evidence, Amber for temporary work or attention, Mint for action, and
Danger only for actual failures or destructive states.

## Shared components

### Tone surface

Create `Surface / Tone` with `Tone = Neutral | Mint | Violet | Amber | Danger` and
`Density = Comfortable | Tight`.

- Radius: 16 px; border: 1 px.
- Padding: 16 px Comfortable, 12 px Tight.
- Neutral: `elevated` fill, `line2` border, `muted` accent.
- Mint/Violet/Amber/Danger: corresponding `*Wash` fill and semantic accent border. Amber uses
  `amberLine`, not opaque Amber, so the edge remains quiet in Light.
- Every instance must include a title, explicit state phrase, icon, or symbol. Tone alone never
  communicates state.

### Tone icon

Create `Icon / Tone halo` with `Tone` variants and `Size = 48 | 36`. It is a circular `surface`
fill with a 1 px semantic border. Icons are 20 px in the standard halo and 16 px in the compact
halo. This is presentational; the enclosing control owns the 48 px target.

### Animated allowance meter

Create `Meter / Allowance` with a semantic track and Violet fill. Height is 8 px, fully rounded.
Its value means **remaining**, so it begins full and becomes shorter as allowance is spent. Do not
add a second marker for holds. Component notes must say: initial paint has no entrance animation;
value changes use `Motion/standard`; Reduce Motion is immediate.

## Screen: Plan & usage

Replace the former stack of equally weighted cards with this hierarchy:

1. Editorial intro: Violet overline `MONTHLY READING`, Newsreader heading `Your allowance`, then
   15/23 supporting copy. In Tight, heading is 27/32; Comfortable is 30/36.
2. Primary allowance card: `elevated` fill, 20 px radius, 24 px Comfortable padding (16 px Tight).
   Top row is `REMAINING THIS MONTH` plus a book-open icon. The number is 38/44 Comfortable or
   34/40 Tight in Violet Manrope SemiBold, paired with the word `remaining`.
3. The meter fills to `(limit_nanousd - spent_nanousd) / limit_nanousd`. Never bind it to
   `remaining_nanousd`, because that also subtracts live holds. Reset date remains a calendar row
   below the meter.
4. Approaching state is an Amber tone surface titled `A little room remains`, with an Info icon and
   explicit text that nothing changes until the allowance reaches zero. Its condition remains
   spend at or above the server warning fraction; holds alone cannot show it.
5. Work in progress is a separate Amber tone surface with Activity icon, `IN PROGRESS NOW`, title,
   and explanation. It has no number, meter, or shared axis with allowance.
6. Plan identity moves to a quieter final card: Violet bookmark halo, `YOUR PLAN`, a Violet-outlined
   plan chip, the server summary verbatim, then the existing narration capability line. Do not
   invent benefits in the component.
7. Usage-unavailable is a Neutral tone surface (`Usage is taking a moment`) and says the allowance
   is unchanged. It never substitutes zero.

Remaining boundary labels mirror the old consumed labels: exactly full is `100%`; any positive
value below 1% is `<1%`; any value below full that rounds to 100 is `>99%`; exactly empty is `0%`.
The accessibility label repeats the same truth and says “remaining.”

## Component: Spend refusal sheet

Update the existing refusal variants in `02 · Mobile Screens / 17 · Production Readiness` rather
than creating a paywall component. The sheet stays an interruption inside the reader's current
flow, never an upsell.

All four variants share this structure:

- Standard 48 px Tone icon at the top.
- Semantic overline 16 px below it, then a Newsreader heading at 29/35 Comfortable or 27/32 Tight.
- Financial body at 15/23 in every density.
- Optional fact panel uses `Surface / Tone`, a 16 px icon, overline, then supporting text at 13/18.
- Primary action begins 24 px after content; secondary action is 8 px below. Both retain a 48 px
  minimum target. Sheet body has no Danger treatment because these states describe limits or time,
  not data loss.

Variant mapping:

| Variant | Tone / icon | Overline | Fact panel | Actions |
|---|---|---|---|---|
| Allowance used | Violet / calendar | `MONTHLY ALLOWANCE` | Violet `PAID WORK RETURNS` with authoritative reset date | `Keep reading`; `View plan & usage` |
| Work finishing | Amber / clock | `WORK IN PROGRESS` | None; countdown button carries the time | Disabled `Try again in Ns`, then `Try again`; `Not now` |
| Starting quickly | Amber / clock | `TRY AGAIN SHORTLY` | None | Same deliberate countdown/retry pattern |
| Narration too large | Violet / minimize | `NARRATION` | Violet `AVAILABLE NOW` / `Device voice is included` | `Use device voice`; `Not now` |
| Other action too large | Violet / minimize | `THIS ACTION` | None | `Choose a smaller action` |

Do not add an upgrade action, price, credit count, red warning symbol, or language implying the
reader did something wrong. Android Back, backdrop, and `Not now` all restore the exact prior flow.

## Component: Notes review

Add `Review section` on `01 · Design System` with `Kind = Paper notes | Project synthesis` and both
density modes. It is a standard card containing a 36 px Violet Tone icon, heading, one-line intent,
then its diff/editor content after 12 px. Paper notes uses `file-text`; project synthesis uses
`layers`. In Tight, card padding is 12 px; Comfortable is 16 px.

Add `Diff / Line` with `State = Context | Added | Removed | Gap` and density variants:

- Root is `elevated`, 12 px radius, `line2` border, clipped.
- Lines are 36 px minimum Comfortable and 32 px Tight, separated by a hairline.
- Every line reserves a 3 px leading rule and 18 px centered marker gutter. Added uses Mint rule,
  Mint wash, and `+`; Removed uses Danger rule, Danger wash, and `−`; Context keeps a transparent
  rule and blank marker. The symbol remains visible because state must not depend on color.
- Gap is a centered `•••` between two 24 px `line2` rules and has the accessibility label
  `Unchanged lines omitted`.
- Markdown and paper-link behavior are unchanged inside the content column.

The full-screen review starts with `PROPOSED CHANGES`, the paper title, and the explicit approval
boundary: `Nothing joins the project until you approve it.` After the two Review sections, create
`Review actions`, an elevated card with `FINISH REVIEW`, a short explanation, and actions in order:
primary `Approve & commit`, secondary `Request edits`, tertiary `Cancel`. Opening Request edits
inserts a Neutral Tone surface inside this same card; it is not a separate sheet or competing flow.

Loading failure uses a centered Neutral Tone surface and states that nothing was committed. Stale
proposal or request failures use a Danger Tone surface with icon and text, rather than an unframed
red caption. Preserve the existing human-approval behavior and proposal revision token.

## Components: Map build and filter rail

Add `Map / Build card` with `State = Collapsed | Expanded`, `Density`, and all palette modes.

- Both states share a minimum 48 px header: 36 px Mint `share-2` Tone icon; `MAP BUILD` overline;
  `Building map…` plus `N of M ready`; chevron. The visible count never collapses away.
- Expanded adds the existing three-step progress component, then optional hint, current paper, and
  progress. Hints use a compact Mint Tone surface. Current paper uses a compact Neutral Tone
  surface with phase overline and existing marquee behavior.
- Progress uses the animated-progress rules, Mint fill, 6 px height, and a separate `N analyzed`
  label. The initial value does not animate from zero and Reduce Motion updates immediately.
- Preserve project-scoped expansion persistence and the default-expanded state for a live build.

Add `Map / Filter rail` with `State = Collapsed | Expanded`:

- Container is `surface`, 16 px radius, 1 px `line` border, 12 px horizontal inset (8 px Tight).
- Summary is 64 px Comfortable or 56 px Tight: 36 px Violet `sliders` Tone icon; `FILTER`
  overline; active filter heading; full `N node(s) visible` label; chevron.
- Expanded choices scroll horizontally below the summary. Each is a 48 px minimum pill with 12 px
  horizontal padding, `elevated` fill and `line2` border. Selected adds Mint wash/border, Mint label,
  and a 15 px check, so selection is never color-only.
- Search remains inside the same rail when active; its query behavior and auto-focus do not change.

## Component: Add paper inline

Add `Input / Add known paper` with `Divider = Shown | Hidden`, `State = Empty | Ready | Busy |
Error`, and both densities.

- Optional divider is `line2` hairlines around `OR ADD DIRECTLY`; it separates this deterministic
  path from discovery without creating another card.
- Field is one `elevated` shell, 16 px radius and 1 px `line2` border; height is 56 px Comfortable
  and 52 px Tight. Left is a 36 px Violet `link-2` Tone icon. Placeholder is the concise
  `Title, DOI, or arXiv link`.
- A stable 72 × 48 px action lives inside the right edge. Empty uses `surface`, `line2`, muted `Add`
  plus arrow and is disabled. Ready uses Mint fill/edge and `mintInk`; Busy replaces content with a
  spinner and exposes busy accessibility state. Keeping the action mounted prevents layout jump as
  the reader types.
- Error changes the shell border to Danger and adds a compact Danger Tone surface below with alert
  icon and the actual safe error. It does not clear the field or its persisted draft.

Preserve the existing parser, duplicate preflight, auto-analysis request, and direct navigation to
the running discussion. This component changes presentation, not the add contract.

## Component: Connection notice

Add `Status / Reconnecting` as a compact Neutral Tone surface, not an error banner:

- 8 px padding, horizontal layout, 36 px Neutral `wifi-off` Tone icon, caption text.
- Exact copy: `Reconnecting… Your response is safe.`
- No Danger color, warning title, “lost,” “offline,” “failed,” or Dismiss action.
- It is omitted for the first six-second-class interruption window because the existing pending
  activity already tells the reader work continues.
- It appears only after six consecutive 900 ms poll misses and disappears on the first successful
  job snapshot. It also clears on settle, cancellation, or conversation change. Mark it as a polite
  live region; it must never take focus away from the discussion.

Keep terminal start/job failures on the existing actionable error treatment. This component is
only connection status while the durable server-side job continues.
