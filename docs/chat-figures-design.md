# Paper figures in chat — design (R.10)

Kamil's framing (2026-07-15): the discussion should be able to *show* a paper's figures, not
just describe them — "render figures from the paper HTMLs" — and, later, let the assistant
author its own diagrams (SVG). Decision taken with him: **figures first** (real figures pulled
from arXiv HTML); assistant-authored SVG is deferred. This document is the reviewable plan.
No code ships with it.

It builds on the deferred roadmap sketch (§6.2 "arXiv HTML figures") and keeps every CLAUDE.md
invariant: figure extraction is **best-effort and never fails a turn or a build**, anything
minutes-long is a **background job + polling**, `store.py` stays LLM/network-free, and nothing
new reaches the git record.

## What "figures-first" means for v1

When a paper has an arXiv **HTML** rendering (ar5iv / arXiv's native HTML), derive a **figure
manifest** — each figure's number, caption, and image asset — cache it and the images under the
project `.state`, and let the discussion **render a figure card** (image + number + caption +
source link) inline, immediately after the first assistant paragraph that references that
figure ("Figure 3 shows…"). No visual model interprets the pixels; figure grounding stays in
captions + surrounding text exactly as today. PDF-only papers keep today's text/caption
behavior with no regression.

Explicitly **out of scope for v1** (deferred, noted here so the shape is known):
- Assistant-authored SVG diagrams. When revisited it is small — `react-native-svg`/`SvgXml`
  already power `MathView.tsx`, so an assistant `###FIGURE_SVG###` block could render there.
- PDF figure extraction (bounding-box crops from the PDF). ar5iv coverage is good for recent
  cs.* papers; PDF-only papers simply show no cards.
- Pixel-level visual interpretation / vision models.

## Pipeline

### 1. HTML fetch (best-effort, alongside the existing PDF path)
`app/retriever.py` today resolves a paper to `full_text` from the **PDF** (`_extract_pdf`).
Add a sibling, non-blocking resolution of the paper's **HTML**:
- URL: ar5iv (`https://ar5iv.org/abs/<id>`) and/or arXiv's HTML (`https://arxiv.org/html/<id>`).
  Try arXiv HTML first (native, newer), fall back to ar5iv.
- This is **additive**: retrieval still succeeds on the PDF alone. HTML is only for figures; a
  missing/failed HTML fetch is a silent no-op (like an OpenAlex miss), retried on a later build.

### 2. Figure manifest (deterministic parse, no LLM)
Parse the fetched HTML into a manifest — a new module `app/figures.py`, deterministic and
network-only-for-image-bytes:
```
figure = { id, number, label, caption, src (original URL), asset (cached filename),
           width, height, alt }
```
- Select `<figure>` elements (and ar5iv's `ltx_figure`), read the `<figcaption>`, resolve the
  `<img>` URL against the page base, and record the figure number from the caption/label.
- **Download the image bytes** to the asset cache (below). Cap per-image size (e.g. 2 MB) and
  per-paper count (e.g. 20); skip SVG/data-URI edge cases in v1 or store as-is if small.
- Keep it tolerant: a figure with no resolvable image is dropped, not fatal.

### 3. Asset cache + serving (mirror the paper-cover pattern)
Figures are binary assets that must survive restarts and be fetched by the client on demand —
exactly the shape the **paper cover** feature already solved:
- Store under the project `.state` (e.g. `.state/figures/<slug>/<figId>.<ext>`) plus the JSON
  manifest (`.state/figures/<slug>.json`). Node-id/slug-keyed, accumulates across builds, same
  contract as `citations`/`openalex` caches.
- Serve via a new project-scoped route mirroring the cover route
  (`GET /api/projects/{pid}/figures/{slug}/{figId}.<ext>` → bytes; a manifest endpoint
  `GET …/figures/{slug}` → JSON). The mobile client builds the image URL the same way
  `paperCoverImageUrl` does and lets React Native `Image` fetch it. (Markdown's CSP concerns
  don't apply — this is the app's own authenticated origin, not an artifact.)

### 4. When figures are derived (background, invariant 1)
Deriving a manifest = an HTTP fetch + parse + N image downloads: seconds, occasionally longer.
Two options, to decide at implementation:
- **(preferred) Fold into an existing background job.** Piggyback on the graph build or the
  cover/preview coordinator: when a paper is (re)processed, derive its figure manifest in the
  same background pass that already rebinds the active-project contextvar (invariant 2). Nothing
  in the request path blocks on it.
- **On first reference, lazily.** When an assistant turn cites a figure and no manifest exists,
  enqueue a small `figures_jobs` background job (its own `jobs.Job` + `work()`), poll a cheap
  snapshot. Same pattern as `preview_jobs`.

The manifest is a pure cache: absent ⇒ no cards, present ⇒ cards. Never a turn dependency.

## Wiring figures into a turn

The analysis turn already emits section markers (`###CANONICAL###` etc.). Figures are attached
to a transcript entry as **optional metadata**, not new prose:
- `app/sessions.py`: assistant transcript entries gain an optional `figures: [figId, …]` list
  (the figures this turn references, resolved against the paper's manifest). Absent on entries
  that reference none, and on PDF-only papers — fully backward compatible.
- Resolution is deterministic: scan the canonical text for "Figure N" / "Fig. N" references and
  map to the manifest's numbers. No LLM; a reference with no matching manifest figure is just
  not carded.
- The transcript JSONL stays append-only; figure ids are small and reference the cache.

## Rendering (mobile)

`mobile/src/components/Markdown.tsx` renders **no images today**. Two additions:
1. A **`FigureCard`** component: the cached image (RN `Image`, `resizeMode="contain"`,
   `max-width:100%`, tap to open the source), the figure number + caption (existing `Text`
   variants), and a subtle "from arXiv HTML" source line. Theme-aware (lands after R.2 theming
   or is written theme-aware from the start).
2. The discussion renderer places a `FigureCard` **after the first paragraph that references
   its figure** (using the entry's `figures` metadata + the paragraph's "Figure N" mention).
   Basic inline `![alt](url)` image support in `Markdown.tsx` is a smaller, separate capability
   we may add too, but the **card** (caption + source + number) is the primary surface.

Fallbacks: no manifest ⇒ render exactly as today (the "Figure 3" text stays, no card). Image
fails to load ⇒ the card degrades to caption + source link (no broken-image box).

## Licensing / safety

- arXiv HTML/ar5iv figures carry the paper's license (often arXiv non-exclusive; many are
  CC-BY). v1 caches and displays them **within the app for the reader who retrieved the paper**
  (personal research use), with a visible **source attribution** on every card and a link back
  to the paper. We do **not** redistribute assets via public Artifacts.
- Size/count caps (above) bound cache growth; a settings toggle can disable figure fetching.
- HTML is fetched over the network only in the background enrichment path — never in `store.py`,
  never on the request thread.

## Phasing (each its own PR after this doc)

1. **Backend fetch + manifest + cache** (`retriever.py` HTML fetch, `figures.py` parser, `.state`
   cache) — network-free tests with injected HTML fixtures (like the citations/extraction fakes).
2. **Serving routes** (manifest + asset bytes) + `shared/api-types.ts` regen + mobile endpoints.
3. **Transcript figure metadata** (`sessions.py`) + deterministic reference resolution.
4. **`FigureCard` + renderer placement** (mobile) + Jest fixtures for referenced/missing figures.
5. (Deferred) assistant-authored SVG via a new marker + `SvgXml`.

## Verification

Backend `ruff` + `pytest` with **injected HTML fixtures** (no live fetch — keep the suite
network-free per CLAUDE.md). Mobile `tsc` + Jest for `FigureCard` and the referenced/missing-
figure render paths. Device pass: a cs.* paper with figures shows cards inline; a PDF-only paper
is unchanged.
