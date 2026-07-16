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

**Treat paper HTML as untrusted — SSRF guard.** A paper's HTML can carry an absolute
`<img src>` (or a redirect) pointing at `localhost`, a link-local/private address, or an
arbitrary host. Because the backend fetches these bytes and then re-serves them through the
project route, image fetching must be locked down:
- **Scheme + host allowlist**: `https:` only, host in `{arxiv.org, *.arxiv.org (incl.
  ar5iv.labs.arxiv.org, export.arxiv.org), ar5iv.org}` — the expected figure origins (note
  ar5iv.org itself redirects into `*.arxiv.org`). Anything else is dropped.
- **Revalidate every redirect** against the same allowlist (don't follow blindly), and reject
  responses that resolve to private/link-local/loopback IPs.
- Enforce the size cap during download (stream + abort past the limit), and only accept
  `image/*` content types. Fetches carry **no cookies or app credentials**. This is the same
  "network only in background enrichment, never trust external input" posture the rest of
  the pipeline takes.

### 3. Asset cache + serving (mirror the paper-cover pattern)
Figures are binary assets that must survive restarts and be fetched by the client on demand —
exactly the shape the **paper cover** feature already solved:
- Store under the project `.state` (e.g. `.state/figures/<slug>/<figId>.<ext>`) plus the JSON
  manifest (`.state/figures/<slug>.json`). Accumulates across builds, same contract as the
  `citations`/`openalex`/`affiliations` caches.
- **Key the manifest to the paper's identity, not just its slug** — the R6.4 affiliation
  cache re-learned this the hard way. The manifest records the **versionless arXiv id + the
  exact source URL** it was derived from; a retrieval identity correction (same slug,
  different confirmed paper) or a changed source invalidates it rather than serving the old
  paper's figures. `force` (rebuild-from-scratch) re-fetches HTML and re-derives, like every
  other enrichment cache.
- Serve via a new project-scoped route mirroring the cover route
  (`GET /api/projects/{pid}/figures/{slug}/{figId}.<ext>` → bytes; a manifest endpoint
  `GET …/figures/{slug}` → JSON). The mobile client builds the image URL the same way
  `paperCoverImageUrl` does and lets React Native `Image` fetch it. (Markdown's CSP concerns
  don't apply — this is the app's own authenticated origin, not an artifact.)

### 4. When figures are derived (background, invariant 1)
Deriving a manifest = an HTTP fetch + parse + N image downloads: seconds, occasionally longer.
Two options, to decide at implementation:
- **(preferred) Fold into the graph build's enrichment step.** There is now a concrete
  precedent to copy: the R6.4 affiliation pass (`affiliations.annotate_project_affiliations`,
  called from `graph._persist_graph_snapshot` on the full path only). Same contract applies
  wholesale: per-paper **persist as each manifest lands** (a mid-build restart never redoes
  completed papers), a **hard wall-clock deadline per paper** with abort-on-stall (a dead
  host must not cost the deadline once per paper), best-effort throughout (never fails a
  build), skipped on skeleton publishes (no network), contextvar already bound by the job
  (invariant 2).
- **On first reference, lazily.** When an assistant turn cites a figure and no manifest exists,
  enqueue a small `figures_jobs` background job (its own `jobs.Job` + `work()`), poll a cheap
  snapshot. Same pattern as `preview_jobs` — but it re-solves the deadline/stall/persist
  problems the enrichment step already solved, which is why it's the fallback, not the pick.

The manifest is a pure cache: absent ⇒ no cards, present ⇒ cards. Never a turn dependency.

## Wiring figures into a turn

The analysis turn already emits section markers (`###CANONICAL###` etc.). The **canonical text
itself** is the durable record of which figures a turn references — it literally says
"Figure 3 shows…". So figure carding is resolved at **render time**, not baked into the
transcript:
- **Render-time resolution (source of truth).** When the discussion renders an assistant entry,
  scan its canonical text for figure mentions and look each up in the paper's **current**
  manifest. This is deterministic, no LLM, and — crucially — a manifest that becomes ready
  *after* a turn was written still cards that older turn on the next render. It also
  sidesteps the append-only-transcript trap: a turn that finished before enrichment completed
  (or that triggered the lazy job) would otherwise have recorded no figure ids and could
  never gain cards.
- **Matching spec** (one tolerant regex, shared by the renderer and the optional hint):
  `Fig(?:ure)?s?\.?\s*(\d+)([a-z])?` — covers "Figure 3", "Fig. 3", "Fig 3a"; a subfigure
  letter resolves to its parent figure; a plural mention ("Figures 2 and 3") cards each
  number found in the clause. **At most one card per figure per assistant message** — the
  first mention wins, later mentions in the same message stay plain text.
- **Optional cached hint (optimization only).** `app/sessions.py` *may* stamp an assistant
  entry with the figure numbers it mentioned (`figures: [3, 5]`) as a convenience, but the
  renderer never depends on it — it always re-resolves against the live manifest. Absent on
  PDF-only papers and fully backward compatible.
- A "Figure N" reference with no matching manifest figure is simply not carded (the text stays).

## Rendering (mobile)

`mobile/src/components/Markdown.tsx` renders **no images today**. Two additions:
1. A **`FigureCard`** component: the cached image (RN `Image`, `resizeMode="contain"`,
   `max-width:100%`, tap to open the source), the figure number + caption (existing `Text`
   variants), and a subtle "from arXiv HTML" source line. Theme-aware (lands after R.2 theming
   or is written theme-aware from the start).
2. The discussion renderer places a `FigureCard` **after the first paragraph that references
   its figure**, resolving the paragraph's "Figure N" mention against the paper's current
   manifest (render-time resolution, above — so late-arriving manifests card older turns too).
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

1. **Backend fetch + manifest + cache** (`retriever.py` HTML fetch, `figures.py` parser, the
   identity-keyed `.state` cache, the enrichment-step wiring with per-paper persist +
   deadline) — network-free tests with injected HTML fixtures (like the citations/extraction
   fakes).
2. **Serving routes** (manifest + asset bytes) + `shared/api-types.ts` regen + mobile endpoints.
3. **Shared reference resolution** (the matching spec above, as a pure helper with tests);
   optionally the `sessions.py` cached hint — the renderer must work without it.
4. **`FigureCard` + renderer placement** (mobile) + Jest fixtures for referenced/missing figures.
5. (Deferred) assistant-authored SVG via a new marker + `SvgXml`.

## Verification

Backend `ruff` + `pytest` with **injected HTML fixtures** (no live fetch — keep the suite
network-free per CLAUDE.md). Mobile `tsc` + Jest for `FigureCard` and the referenced/missing-
figure render paths. Device pass: a cs.* paper with figures shows cards inline; a PDF-only paper
is unchanged.
