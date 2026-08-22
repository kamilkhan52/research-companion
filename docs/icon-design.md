# Seminar — Quiet Aperture app icon

## Decision

The production icon is **Quiet Aperture**, selected by Kamil from three generated directions in
August 2026. It deliberately does not encode the product name, an initial, a book, or a specific
academic discipline. The name can evolve without making the mark obsolete.

## Art narrative

Research rarely begins with one clean answer. It begins with perspectives that overlap, disagree,
and partially obscure one another. Seminar's work is the movement from that plurality toward a
clearer view: reading evidence, reasoning across it, and deciding what holds.

The icon turns that process into one compact gesture:

- **Two asymmetric planes** are two readings or bodies of evidence, moving in opposite directions.
- **Their overlap** is the act of comparison rather than simple collection.
- **The central aperture** is the considered view that reasoning opens. It is negative space, not
  another object layered on top.
- **The diagonal flow** keeps the mark active and editorial without becoming a literal chain link,
  infinity symbol, speech bubble, or letterform.

The result should feel quiet, exact, and useful: a research instrument rather than a mascot.

## Construction

- Canvas: 1024 × 1024, opaque square for the generic/iOS launcher asset.
- Palette: deep ink `#0B0D12` and warm paper `#F3F0E8` only.
- Geometry: two bold filled planes, no strokes, gradients, shadows, gloss, or embedded corner mask.
- Optical scale: the mark spans about 65% of the generic canvas width; the adaptive foreground
  uses about 72.5% of Android's guaranteed-safe diameter. This avoids a timid double-inset after
  launchers apply their own masks while retaining roughly 4% radial safe-zone clearance at the
  farthest curved edge.
- Aperture: a true cut-out in mark-only assets so Android theming and splash contexts remain valid.
- Compact proof: the aperture must remain open at 32 px.
- Android: meaningful foreground geometry stays inside the 66/108 adaptive-icon safe zone; the
  background and monochrome layers are separate.

The canonical editable source is `mobile/assets/brand/seminar-mark.svg`; the generator parses its
paths directly so the raster assets cannot silently drift from the approved vector. Install the
generator dependencies and regenerate the committed PNGs with:

```sh
.venv/bin/pip install -r scripts/requirements-icons.txt
.venv/bin/python scripts/gen_app_icons.py mobile/assets/images
```

The output contracts are:

| Asset | Contract |
|---|---|
| `icon.png` | 1024² opaque ink canvas, used by Expo and iOS |
| `android-icon-background.png` | 1024² opaque ink layer |
| `android-icon-foreground.png` | 1024² transparent warm-paper mark, safe-zone scaled |
| `android-icon-monochrome.png` | 1024² transparent single-tint mask |
| `splash-icon.png` | 512² transparent warm-paper mark |
| `favicon.png` | 48² opaque compact proof |

Native launcher assets require a development-app rebuild and reinstall. Reloading the Metro bundle
alone cannot change the icon installed on the phone.

## Figma deliverable

The editable Figma board contains the approved component and platform proofs listed below. Its
geometry still needs the same 1.20× scale sync after the Desktop Bridge reconnects; until then,
the canonical SVG and generated PNGs are the production source of truth.

- vector master;
- primary launcher proof;
- 64 px and 32 px proofs;
- Android adaptive safe-zone proof;
- monochrome proof;
- the short narrative and construction guardrails above.

The previous letterform icon remains in git history; it is not retained as an active asset or
compatibility fallback, so a future rebrand cannot accidentally restore it.
