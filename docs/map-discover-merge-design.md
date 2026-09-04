# Map + Discover: one surface (DR-052)

**Status:** design agreed with Kamil 2026-09-04, not yet implemented.
**Supersedes:** DR-052's original one-line framing ("merge into one function driven by
options/context"), which left the surface question open.

## What he asked for

> "I think we keep all features of Map and the tab, and we integrate Discover. And we shouldn't
> be differentiating or have boundaries between the two when possible."
> — Kamil, 2026-09-04, choosing **one tab, no mode switch**

With three follow-ups settled the same day: **the graph leads** and the list sits below it; a
query **highlights matching nodes already in the graph** rather than injecting new ones; and the
tab **stays "Map"**. On scope: *"Both the query and the project are important when a query is
provided. The query in the context of the project is the priority."*

## What the duplication actually is

Not the whole of either screen. Both tabs render **a list of papers to add**:

| | Map today | Discover today |
|---|---|---|
| reference graph | ✅ `GraphCanvas` | — |
| neighbourhood freshness | ✅ `NeighbourhoodLine` | ✅ same component |
| papers to add | ✅ `graph/recommendations` | ✅ goal-driven suggestions |
| author board, labs research | ✅ | — |
| open-ended query | — | ✅ `run_discovery` |
| hide / unhide | (filtered by `discovery.filter_hidden`) | ✅ `discovery.hide_candidate` |

So "I still see both" is the recommendation list appearing twice, over a substrate that already
merged: `neighbourhood.py` (DR-052 PRs 1–2) and the shared hidden-list are used by both today.

## The merged surface

**One tab, `Map`.** Graph on top, as now. Below it, **one ranked list** of papers to add — not
sections, because sections are the boundary he asked us not to draw. Provenance moves onto each
row instead, in language the engine already emits (`discovery.py` builds these strings today):

- *"Cites “…” from your reading list"*
- *"New: has started citing “…” from your list"*
- *"Recommended from your reading list's citation patterns"*
- and, when a query ran, the query's own reason

**Opening the tab costs nothing.** The reference-derived and forward-citer lanes are file reads
off the graph store. The multi-source query run costs real money and takes minutes, so it stays
an explicit action on a background job — that is invariant 1, not a preference.

**A query re-ranks the list in project context and highlights matching nodes** already in the
graph. It does not add result nodes: the graph keeps meaning "your project", and a crowded graph
of things he has not read would answer a question he did not ask.

**Empty project** shows the query box alone. No new machinery — `_reading_list` already returns
`[]` gracefully and the lexical lane still produces suggestions, which is what makes Discover the
on-ramp for a new project's first papers.

## Questions settled without asking

| question | answer | evidence |
|---|---|---|
| Does Discover need a library? | No | `_reading_list` returns `[]`; "the lexical lane still produces suggestions" |
| Sections or one list? | One list, per-row provenance | `reasons` already speaks this language |
| Ranking with no query? | Existing project signals | connectivity bonus, significance classification, citation counts |
| Hidden list shared? | Yes, already is | `graph/recommendations` runs through `discovery.filter_hidden` |
| Does the graph move? | No | project structure is unambiguously Map |
| Author board / labs? | Stay | "we keep all features of Map" |

## Staging

Each step ships and is verifiable on its own; none leaves the tab in a half-merged state.

1. **Lanes behind one list.** Move `graph/recommendations` into the same ranked list Discover
   builds, with provenance per row. Discover's tab still exists and still works.
2. **The list moves under the graph** in the Map tab, with the query box. Discover's tab is
   removed and its route redirects.
3. **Query ↔ graph highlighting.** Matching nodes light up; no new nodes.
4. **First-run.** Empty project shows the query box as the on-ramp.

## Open, and deliberately not decided here

- **Ordering between lanes in one list.** A reference the corpus cites 6 times and a query hit
  with a strong lexical match are not comparable on any scale that exists today. Needs a real
  ranking pass, and probably his eye on a sample.
- **What the Map tab is called in the tab bar** if the list becomes its main job. He chose "Map"
  for now; worth revisiting once (2) ships and he has used it.
