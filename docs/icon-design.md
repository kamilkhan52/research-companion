# Paradigm — app icon design (R7.10, redo brief)

The first pass (6 codex generations → a Fable×codex top-three → Figma vector comps on page
"03 · App Icon — Paradigm") was useful groundwork but is being **redone** with Kamil in the
generation loop and a firmer foundation: agreed app-icon best practices, and a sharper reading
of the Paradigm philosophy, *before* we prompt codex. This document is that foundation.

## What "Paradigm" means (and how it should feel, not read)

The app is **Paradigm**, after Kuhn's *The Structure of Scientific Revolutions*: normal
science proceeds inside a shared frame; anomalies accumulate; the frame itself then
reorganizes — the same facts snap into a new structure. That is the app's theory of *reading*:
you work through a corpus with an interlocutor until your map of a field reorganizes.

Design implications, in order of importance:

1. **Express the shift, not the book.** The icon should carry the *feeling* of a frame-shift —
   structure, reorganization, "the same elements seen anew" — never a literal book, portrait,
   telescope, or Kuhn reference. A generic "reading/library" icon would actively mislead.
2. **One idea, cleanly.** A paradigm is a single organizing frame; the mark should be one
   confident gesture, not a scene. This aligns with the #1 best practice below (single focal
   point), so philosophy and craft point the same way.
3. **Quietly intellectual, not sci-fi.** The app pairs serif reading text with a calm dark UI.
   The icon is an instrument, not a toy or a neon gadget.

The honest tension to resolve in generation: the most *conceptually precise* marks (an anomaly
reorganizing a field; a discontinuous jump) risk being illegible at 48px, while the most
*legible* marks (a bold single glyph) risk being generic. The winning direction has to be both
— a bold, simple silhouette that still earns its meaning.

## App-icon best practices we will hold codex to (2025/2026)

Synthesized from current iOS/Android guidance (sources below):

- **Single focal point; ~0.5s to read.** One dominant element, no scene. It must be
  recognizable at 60×60 and in a home-screen grid, not just at 1024².
- **2–3 colors max.** Our palette: deep ink ground (#0B0D12 family) + mint (#34D399) as the
  living accent; at most one secondary spark (violet #6A55E0 or amber). No busy gradients.
- **Bold shapes, generous negative space.** Thin hairlines and fine detail vanish at small
  sizes and get crushed by the platforms' 2025 effects (see next point).
- **Design for the platform's own treatment — don't pre-bake it.** iOS applies its rounded
  mask (and iOS 26 "Liquid Glass" depth/reflection) automatically — supply a **1024² square,
  no transparency, no self-added corners/shadows/gloss**; if shapes aren't bold and clear the
  glass effect flattens them. Android **adaptive icons** are two layers: an **opaque
  background** (108dp) + a **foreground** (108dp) whose meaning must sit inside the **72dp
  safe zone** (the system masks to circle/squircle/rounded-square and can crop the outer
  ~33%). Also plan a **monochrome layer** — Android now tints icons from the wallpaper, and
  without one the icon reads as dated.
- **No text.** The wordmark is not the icon.
- **Distinct in context.** It has to stand out on a crowded launcher next to other dark,
  mint-ish, minimal icons — distinctiveness is a real constraint, not just taste.

These become the non-negotiable clauses in every codex generation prompt (square 1024,
opaque, single bold silhouette, ≤3 colors, meaning inside the center ~66%, no text).

## The collaborative generation plan (Kamil in the loop)

Kamil wants to be involved at the generation step — that is the real point of selection.

1. **Align on 3–4 concept directions together** (from the philosophy above) before generating —
   not 6 scattershot ideas. Likely starting candidates to react to: *stepped ring /
   discontinuous orbit*, *refraction/prism*, *re-formed constellation (same nodes, new edges)*,
   *figure-ground flip (one shape, two readings)*. Kamil edits this set.
2. **Co-write the codex image prompts** for the agreed directions — each carrying the
   best-practices clauses above verbatim, plus the specific concept and palette. Kamil reviews
   the prompts before they run.
3. **Generate** (codex → OpenAI Images), review together, iterate prompts as needed.
4. **Select** the direction(s) worth vectorizing; rebuild as clean vector comps in Figma at
   512² **and** 64px, on both a dark and a light launcher mock, with the Android safe-zone and
   a monochrome variant checked.
5. **Kamil picks the final**; then vector polish + asset integration (`mobile/assets/`,
   adaptive `icon`/`foregroundImage`/`backgroundColor` + `monochromeImage` in `app.json`,
   splash), shipped as its own PR (needs a dev build — native asset change).

## Status

- [x] First-pass concepts + generations + comps (superseded; kept on the Figma page for
      reference)
- [x] Best-practices research + philosophy brief (this doc)
- [ ] **Align concept directions with Kamil** ← next, collaborative
- [ ] Co-write + run codex generation prompts
- [ ] Vector comps (dark+light, 512+64px, safe zone, monochrome)
- [ ] Kamil's final pick → polish + `app.json`/asset integration (new dev build)

## Sources

- [App Icon Design Guide (SVG Genie)](https://www.svggenie.com/blog/app-icon-design-guide)
- [iOS vs Android Icon Guidelines 2025 (IconDino)](https://appiconcreator.com/blog/ios-vs-android-icon-guide)
- [App Icon Trends & Best Practices 2025 (ASOMobile)](https://asomobile.net/en/blog/app-icon-trends-and-best-practices-2025/)
- [App Icon Guide 2026 (MobileAction)](https://www.mobileaction.co/guide/app-icon-guide/)
