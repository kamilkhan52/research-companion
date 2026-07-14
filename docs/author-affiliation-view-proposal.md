# Authors & Affiliations view — design proposal (U.9)

Status: **proposal — awaiting Kamil's sign-off; no implementation yet.**
Figma: file `Research Companion — UI Redesign Proposal`, page `02 · Mobile Screens`,
frame `14 · Authors & Affiliations` (node `55:1696`, in section `09 · Additional App States`;
v2 bubble-map annotation group `62:150`).

## Why

The Map answers "which papers matter here?" but not "who is doing this work?" — the field
notes ask for a view that highlights the most active authors and labs/companies/universities
in the project and its reference neighborhood. Litmaps ships a "By Author" display mode as
precedent; ours should additionally rank by *this project's* evidence (in-project papers and
significant citations), not raw fame.

## Data we already have vs. what needs fetching

| Signal | Availability today |
|---|---|
| Author names on EXTERNAL nodes | ✅ referenced works carry `authors: string[]` (S2 reference metadata + full-text extraction) |
| Author names on PROJECT nodes | ❌ `build_nodes_and_edges` initializes project nodes with `authors: []` and nothing fills them — the papers that matter most are exactly the ones missing authors today. v1 must fetch/persist them (S2 paper lookup by the arXiv id that nodes carry since U.8, falling back to parsing the corpus header) |
| Which papers each author appears on, in/out of project | ✅ derivable from the stored graph at read time |
| Significant-citation weight per paper | ✅ `significant_cited_by_count` on nodes |
| S2 `authorId` per author | ⚠️ present in S2 reference payloads but currently dropped at merge — must be kept to disambiguate "J. Smith" |
| Affiliations | ❌ needs `GET /author/{id}?fields=affiliations` per distinct author (batched, cached like citation counts); coverage is patchy, so the design must degrade to "affiliation unknown" |

**Aggregation (server-side, at graph read/build time, no LLM):**
`activity = 3·(in-project papers) + 2·(significant citations of their papers by project papers) + 1·(external appearances)` — same spirit as the recommendation score: in-project evidence dominates.

## The view (v1 recommendation: ranked board, not a canvas)

A third segment on the Map screen's existing filter chips: **Papers · Authors · Labs**.

- **Authors mode** — a two-column card board ranked by activity score.
  Card: author name; affiliation line when known (else omitted, never "Unknown"); count chips
  (`N in project`, `M significant`, `K referenced`); an "active years" micro-range (e.g.
  2019–2024) from their papers' years. Tap → bottom sheet listing their papers (project papers
  open the Discussion; external ones get the U.5-aware Add button). Long-press → highlight
  their papers on the paper map (GraphCanvas `highlightIds` already supports this).
- **Labs mode** — the same cards grouped under affiliation headers, headers ranked by summed
  activity; authors with unknown affiliation collapse into a final "Independent / unknown"
  group so patchy S2 coverage never hides people.
- Both modes reuse Map chrome (search box filters by author/affiliation name; the build
  banner, offline states, and attribution line stay).

**Why not an author bubble-map for v1:** a canvas of author bubbles + co-authorship edges is
prettier but needs a second layout engine, co-authorship edge derivation, and label-collision
work — high cost before we know the view earns its keep. The board answers the actual question
("who/which labs are most active?") in ranked order. Bubble map is sketched in the Figma frame
as a v2 concept only.

## Implementation sketch (for sizing, not for this PR)

1. Backend: populate project-node authors first (S2 paper lookup by arXiv id, cached like
   citation counts; corpus-header parse as fallback) — without this no in-project ranking is
   computable; keep S2 `authorId` through the merge; add `authors_summary` to the stored
   graph; affiliation fetch+cache module mirroring `citations.py` (best-effort, never blocks
   a build).
2. API: `GET /api/projects/{pid}/graph/authors` → ranked authors + affiliation groups.
3. Mobile: Authors/Labs segments on the Map screen; card board + author sheet. Web mirrors
   with a table.

## Open questions for Kamil

1. Should external-only authors (never on a project paper) appear at all in v1, or only
   authors with ≥1 in-project paper?
2. Is the activity weighting (3/2/1) right, or should significant citations dominate?
3. Affiliations: is patchy coverage acceptable for v1, or defer Labs mode until an
   affiliation-coverage spike proves it useful?
