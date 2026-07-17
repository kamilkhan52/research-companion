# Paradigm — app icon design (R7.10)

The app is called **Paradigm**, after the concept Thomas Kuhn defined in *The Structure of
Scientific Revolutions*: normal science proceeds inside a shared frame; anomalies accumulate;
and then the frame itself shifts — the same facts reorganize into a new structure. That is
the app's philosophy of reading: you work through a corpus *with* an interlocutor until your
map of the field reorganizes. The inspiration stays implicit — the icon should carry the
*feeling* of a frame-shift (structure, reorganization, the same elements seen anew), never a
literal Kuhn reference, portrait, or book.

## Constraints

- Must read at launcher sizes (48–192 px), as an Android adaptive icon (safe center ~66%)
  and an iOS rounded square. One strong silhouette; no fine text; no thin hairlines.
- Palette family: the app's own — deep ink navy (#0B0D12 family) ground with mint (#34D399
  family) as the living accent; violet/amber as possible secondary sparks. Must sit well on
  both dark and light launchers.
- Scholarly but modern: the app pairs serif reading text with a clean dark UI. The icon
  should feel like an instrument, not a toy.

## Concepts (for image generation)

1. **Gestalt mark** — one abstract shape deliberately readable two ways (the duck–rabbit's
   spirit, abstracted): e.g. a bold negative-space form that reads as an open book from one
   glance and a rising graph/lens from another. The double-reading IS the paradigm shift.
2. **Prism** — a clean geometric prism: a single line of light enters, a fanned spectrum
   leaves. One input, new structure; understanding as refraction. Strong, minimal, iconic.
3. **Re-formed constellation** — a small constellation of nodes where two edge-sets overlap:
   the same points connected two different ways (old frame in muted ink, new frame in mint).
   Speaks directly to the app's reference graph.
4. **Page-turn phase shift** — a page caught mid-turn forming two planes: the near plane in
   ink, the turning plane catching mint light — reading as the mechanism of the shift.
5. **Anomaly grid** — an ordered field of dots with ONE displaced dot in mint, the grid's
   lines subtly warping toward it: the anomaly that reorganizes the field around itself.
6. **Stepped ring (revolution)** — a nearly-complete circle that, at one point, steps
   outward onto a larger radius — the cycle of normal science broken by a discontinuous
   jump. Reads as both an orbit and a spiral staircase of frames.

## Process

Per Kamil (2026-07-17): codex generates candidate images for these ideas → Fable + codex
jointly pick the top three across all generations → the three are rebuilt as clean vector
comps in Figma → Kamil picks the final. Generated drafts live outside the repo
(`.app-state`/scratch); only the chosen vector direction lands in `mobile/` assets.

## Selection (2026-07-17)

Codex (gpt-5.6) generated one image per concept. Concept 1's generation failed to produce a
usable mark (vetoed by codex); concept 3 read as a generic network-app icon (dropped by
Fable). Rankings — Fable: 2, 5, 6 · codex: 6, 2, 4. Joint top three (2 and 6 unanimous;
5 chosen over 4 for the third seat because 4's weakness — "reads as a generic
document/bookmark icon" — was codex's own criticism, while 5 is the most Kuhn-specific mark
and its small-size risk is fixable in vector):

1. **Prism** (concept 2) — one input beam, refracted rays; mint + violet.
2. **Anomaly grid** (concept 5) — muted 4×4 dot field, one displaced mint dot pulling its
   neighbors; the anomaly reorganizing the field.
3. **Stepped ring** (concept 6) — an orbit that steps outward onto a larger radius; the
   revolution as a discontinuity.

Vector comps of all three (512px + 64px launcher previews, ink #0B0D12 ground, mint #34D399)
are built in Figma: **"Research Companion — UI Redesign Proposal" → page "03 · App Icon —
Paradigm"**. Raw generations live in the session scratchpad (not committed).

## Status

- [x] Concept reasoning (this doc)
- [x] Codex image generations per concept (6, one failed)
- [x] Top-three selection (Fable + codex)
- [x] Figma comps of the three
- [ ] Kamil's pick + final vector polish + asset integration (`mobile/assets/`, adaptive
      icon, splash)
