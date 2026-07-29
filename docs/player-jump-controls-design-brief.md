# Design brief — player jump controls (polish plan round 2, Phase K)

Brief for the designer (codex): propose and build, in Figma, the transport-control region
of the full-screen player so that BOTH jump kinds — the ±15-second **time jump** and the
**sentence jump** — have clear, discoverable, one-handed controls. The output frame is the
spec a developer implements from, through the normal PR loop.

## The product moment

Scholiast is a research-reading companion. The player is its focused listening surface: the
user is often walking, phone in one hand, listening to a long spoken explanation of a
paper. The screen shows a rolling transcript (current sentence highlighted and centered,
neighbors dimmed, tap a line to jump) above a bottom transport block.

The two jumps do different jobs and the design must teach that difference at a glance:

- **Time jump (±15 s)** — coarse repositioning. "I zoned out for a bit."
- **Sentence jump (‹ previous / next ›)** — semantic replay. "Say that sentence again."
  This is the more valuable jump while listening to prose: it lands exactly on a sentence
  boundary of the transcript (falls back to ±15 s when boundaries are unavailable). It
  must feel like the first-class control it is — today it is two bare caption-text labels
  ("Previous sentence" / "Next sentence") that look like footnotes and are awkward to tap.

## Current layout (mobile/src/app/player.tsx — keep unless the design needs otherwise)

Top to bottom: header (collapse chevron, serif title) · rolling transcript (flex) ·
controls block above the home indicator: full-width mint scrub slider with elapsed/total
times · a row with two ±15 s pills (elevated fill, thin border, rotate-ccw/cw icon + "15")
flanking a 72 px mint circular play/pause · the offending sentence-text row.

Constraints: the transcript keeps the flex space (do not shrink it meaningfully); the play
button stays the single dominant control; everything reachable by a thumb one-handed;
tap targets ≥ 44 px; every control gets an accessibility label.

## Design language (the app's philosophy — binding)

A quiet research instrument. Scholar-dark, calm chrome, nothing gamified.

- Canvas `#0B0D12`, cards `#151922`, raised surfaces/inputs `#1B202B`; hairlines
  `rgba(153,163,183,0.14)` (stronger: `0.28`).
- Text `#F3F0E8` warm off-white; secondary `#99A3B7`.
- **Mint `#65D6B4` = action** (ink on mint: `#0A231B`); violet `#9B8AFB` = relationship/
  synthesis/AI; amber `#E4B85C` = caution. Accents are used sparingly — one dominant mint
  element per region.
- Shapes: pills and circles; radius 999 pills for buttons/chips; thin low-contrast borders,
  no heavy shadows.
- Type: **Manrope** for all UI/controls; **Newsreader** (serif, incl. italic) only for
  editorial titles. No other families.
- Icons: thin-line (Feather set in the app) — the design should use icon shapes that map
  onto Feather glyphs or simple custom strokes a developer can draw.
- Principles: mint = action; dense data starts focused then reveals detail; the interface
  recedes behind the content (here: the transcript is the content).

Exact tokens live in `mobile/src/theme/tokens.ts`; existing player frame: `12 · Audio
Player` on page `02 · Mobile Screens` (file `O62BbV7CcCOf3O55HKAjtK`).

## What to deliver in Figma

On page `02 · Mobile Screens`, in a **new named section `14 · Player Jump Controls`**
(do not modify existing frames):

1. **Two or three exploration frames** (phone-size, match the existing frames' 390-width
   convention) showing distinct arrangements of the transport block — e.g. sentence jump
   as the inner pair around play with time jump outboard; sentence jump as a segmented
   pill under the slider; icon+glyph treatments that distinguish "15" from "sentence".
   Full screens (header + abbreviated transcript + transport) so hierarchy is judged in
   context, but the transport block is the design surface.
2. **One frame marked `— RECOMMENDED`** in its name, with a short rationale in a small
   text note beside (not inside) the frame.
3. Iconography that makes the two jump kinds instantly distinguishable and learnable
   without labels — though a first-run affordance (e.g. tiny captions that could later
   disappear) is acceptable if argued for.
4. States worth showing: playing, and buffering on the play control. (Scrubbing/loading
   states exist and are unchanged.)

Working rules (from `docs/figma-workflow.md` / the MCP handoff): no duplicate pages, no
stale node IDs, no helper/failed-attempt layers left behind, Manrope + Newsreader only,
validate each frame with a screenshot capture, keep every new layer inside the new section.

## Out of scope

Voice/speed settings, the mini player, the transcript's own design, cue/preparation
states, and any behavior change to seeking logic (`mobile/sentence-seek.ts` stays as-is:
sentence boundaries by fraction of track, ±15 s fallback).
