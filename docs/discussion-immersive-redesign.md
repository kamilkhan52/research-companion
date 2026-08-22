# Immersive discussion canvas

Date: 2026-08-18

Status: selected direction; mobile implementation, automated verification, editable Figma
components, Light/Black Figma screens, and native Android scroll-under QA are complete. The normal
composer/keyboard state still needs a non-mutating rendered pass.

## Reference language

The supplied ChatGPT screenshots use a **content-under-chrome**, **edge-to-edge conversation
canvas**. The transcript is the base layer and owns the entire viewport. Navigation and input are
**floating overlay chrome**, not layout rows: compact top capsules and a bottom composer sit above
the scrolling content. **Gradient edge scrims** (also called scroll-edge fades) protect contrast
without becoming opaque toolbars, so text visibly travels behind the controls and dissolves near
the top and bottom edges.

Other useful terms for prompting or design review:

- immersive, full-bleed transcript;
- overlay header / floating navigation capsule;
- floating pill composer;
- safe-area-aware edge-to-edge layout;
- scroll-under behavior;
- top and bottom gradient masks/scrims;
- continuous reading surface rather than stacked assistant cards;
- quiet inline message actions;
- compact right-aligned user bubbles;
- scroll-to-latest affordance lifted above the composer.

This is not just “a transparent header.” A transparent in-flow header still consumes vertical
space. The defining behavior is that the list spans the viewport behind independently positioned
chrome, with enough scroll content inset to make the first and last turns fully readable.

## Research Companion translation

The redesign keeps the interaction model and product language already shipped:

- Manrope remains the control and metadata face; Newsreader remains the long-form discussion face.
- Dim, Black, and Light use the existing semantic palette; no new brand colors are introduced.
- Assistant responses become continuous editorial content directly on `bg`, without full-width
  surface bands or separator borders.
- The paper summary keeps its small Mint `PAPER SUMMARY` marker; it does not become a card.
- Reader messages remain compact elevated bubbles aligned right, preserving turn recognition.
- Listen, Copy, Project Notes, Retry, branch selection, figures, agent trail, sentence comments,
  and report/edit long-press behavior stay attached to the same messages.
- The top identity capsule carries paper title plus condensed year/thread context. Back and More
  remain separate 48px-class targets.
- The composer remains one rounded surface with its action inside. Its overlay includes the bottom
  safe area and grows with text/comment UI; list insets track the measured overlay height.
- The top list inset tracks the measured overlay header. Content can pass behind both overlays,
  while the oldest and newest resting positions stay unobscured.
- Keyboard avoidance changes from “safe area + in-flow header” to the safe-area offset only,
  because the header no longer participates in layout.

Lifecycle-specific toolbars (review notes, committed/continue) use the same floating bottom-card
treatment rather than falling back to an opaque full-width footer.

## Visual specification

- Canvas: Android portrait, `393 × 852`, edge-to-edge.
- Header: three overlay regions, 12px outer inset, 8px gaps, positioned below the status bar.
  Back/More use circular elevated controls; identity uses an elevated-glass pill with a hairline
  border. No bottom divider.
- Top scrim: opaque `bg` behind system/header chrome, easing to transparent below it.
- Transcript: 16px comfortable or 12px tight horizontal inset; assistant surfaces transparent;
  reader bubble maximum width 86%.
- Bottom scrim: transparent above the message actions, easing to a high-opacity `bg` behind the
  composer and navigation inset so the transcript remains faintly perceptible beneath the chrome.
- Composer: elevated pill, 1px `line2`, 24px radius, 36px side reveals, and a 16px lift above the
  protected safe-area bottom padding; Mint send action and existing shadow behavior (no Android
  elevation rectangle).
- Scroll control: circular elevated control above the measured composer, never underneath it.

## Mockups

- [`Light`](design-references/discussion-immersive-2026-08/light.png)
- [`Black`](design-references/discussion-immersive-2026-08/black.png)

The bitmap mockups are visual proposals generated from the two supplied ChatGPT references plus
the current Research Companion discussion screenshot. Runtime code and editable Figma layers remain
the implementation sources of truth.

## Figma scope

Target file: `O62BbV7CcCOf3O55HKAjtK`, page `02 · Mobile Screens`. Update the existing discussion
family rather than creating a duplicate page. Add a named section for the immersive discussion
states and create Light and Black screen frames. Reuse the existing `Research Companion` variables
and Manrope/Newsreader styles. Create only the missing reusable assets:

- `Discussion / Floating header`
- `Discussion / Edge scrim`
- `Discussion / User message`
- `Discussion / Message actions`
- `Discussion / Scroll to latest`
- `Discussion / Composer`

Component descriptions should point to `mobile/src/components/TopBar.tsx`,
`mobile/src/components/chat/DiscussionEdgeFade.tsx`, and
`mobile/src/app/paper/[slug].tsx`. Code Connect is not currently available on the account's View
seat, so descriptions are the source-path bridge.

Delivered in
[`18 · Discussion Immersive · Components & Screens`](https://www.figma.com/design/O62BbV7CcCOf3O55HKAjtK/Research-Companion-%E2%80%94-UI-Redesign-Proposal?node-id=127-2747):

- Light screen `127:2759` and Black/OLED screen `127:2761` at `393 × 852`.
- Six reusable component sets with 16 total theme/state variants.
- Editable component properties for header title/subtitle, reader message, and composer prompt.
- Semantic-variable bindings for every production solid paint; edge-scrim gradient stops are the
  documented fixed-color exception.
- Minimum 44px interaction targets and component descriptions linked to their React Native source.

### Phase 0 gap analysis (completed)

- Existing code and Figma foundations already cover the three themes, semantic colors, Manrope,
  Newsreader, spacing, radii, icon buttons, and the ordinary stack header.
- Existing discussion frames document the outgoing in-flow header and assistant surface bands;
  they should be revised in place, not preserved as a competing pattern.
- Missing Figma assets are limited to the six discussion-specific components listed above. No new
  variable collection, primitive button family, or community chat kit is warranted.
- Runtime code is the authority where the old Figma frame conflicts with measured safe-area and
  composer behavior. The new components should bind to the existing local variables.
- The Figma Desktop Bridge was approved and the planned foundation audit, component construction,
  screen composition, and visual/structural validation phases are complete.

## Acceptance

1. The message list paints behind the status area, floating header, scrims, composer, and Android
   navigation area.
2. At rest, no readable content is permanently hidden by either overlay.
3. Scrolling visibly carries content beneath both fades.
4. Keyboard-open behavior leaves the growing composer fully visible and does not double-count the
   now-overlay header.
5. Streaming follow behavior, manual scroll hold, scroll-to-latest, sentence comments, and all
   thread/notes/audio actions remain functional.
6. Light, Dim, and Black contain no baked palette values outside the semantic token source.
7. Assistant text uses Newsreader; controls and reader messages use Manrope.

## Verification evidence

- The complete mobile Jest suite passed after implementation: 118 suites, 734 tests.
- Focused chrome tests cover the floating header treatment, both non-interactive scrims, and the
  shared geometry contract for safe-area keyboard offset, inverted-list padding, and
  scroll-to-latest clearance.
- TypeScript reports only the pre-existing typed-route error at `mobile/src/app/plan.tsx:303`;
  the changed discussion files introduce no additional diagnostics.
- `git diff --check` passes and the existing theme guard remains green.
- Native Android emulator QA at `411dp × 914dp` verified the edge-to-edge canvas, floating header,
  readable top/bottom fades, and transcript scroll-under behavior using an existing committed
  discussion. The device guard correctly prevented activating `Continue discussion`, because that
  would mutate server state; the ordinary composer and keyboard-open acceptance checks therefore
  remain covered by the Figma screens and geometry tests rather than a live rendered pass.
