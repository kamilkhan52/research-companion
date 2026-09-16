# Merging Map and Discover into one pipeline (DR-052)

*Drafted 2026-08-10. Kamil: "We should be merging Map and Discover… That's a quality of life
upgrade we must push before we are production ready. Think about why; the two have common steps
and differ in context a little. This can be a single function that can fulfil all requirements
based on options or context." Status: **BUILT — all four delivery PRs merged by 2026-08-21**
(#407 substrate, #409 delta lane, #431/#432 significance + lane-3 primitives, #436 client
convergence). The open questions below were resolved in
[`corpus-neighbourhood-spec.md`](corpus-neighbourhood-spec.md) §1; this file remains the
architectural record, and §"The surface" below is the 2026-09-04
continuation. One correction learned at PR 4: the freshness line is DISCOVERY's (the
forward sweep), shown read-only on the Map — the Map build never writes forward records.*

## Why they merge: the shared spine

Both features answer the same underlying question — **what surrounds this corpus?** — and both
already do it in three steps that differ only at the edges:

| step | Map (graph.py) | Discover (discovery*.py) | actually different? |
|---|---|---|---|
| 1. Anchor resolution | project papers → per-paper extraction + S2/OpenAlex ids | project papers → OpenAlex ids (R1, cached in graph store) | **No** — Discovery slice 1 already reads the graph's ids when present, and re-derives them when not |
| 2. Neighbourhood | references/citers of each anchor, enriched with citation counts | forward citations, graph recommendations, goal search | **Partly** — same providers, same identity keys, different traversal direction and breadth |
| 3. Ranking | `score_recommendations` (significance to this corpus) | gate → batch triage → blend | **Yes** — Map ranks for *structure*, Discover ranks for *what to read next* |

The cost of keeping them separate is concrete and already being paid: identity resolution runs
twice (the graph build resolves anchors, then a Discovery run re-resolves whatever the graph
lacks), `graph.score_recommendations` is computed by the Map and consumed by Discovery through
a side-channel read, staleness is bidirectional (a Map built after papers were added doesn't
refresh Discovery's reservoir, and only Discovery's anchor ids flow back into the graph store —
its citation and topic data never do),
and the reader sees two buttons that each take minutes and partially redo each other's work.

## The merged shape: one neighbourhood pass, two views

One pipeline — call it the **corpus neighbourhood pass** — with staged, resumable outputs:

```
anchors(project)                      # step 1: identity, cached once, shared
  → neighbourhood(anchors, breadth)   # step 2: edges + candidate works, one provider sweep
      → graph view    (layout, significance, authors)      ← today's Map
      → reading view  (gate, triage, ranked suggestions)   ← today's Discover
```

- **Steps 1–2 are one job** (`neighbourhood_jobs`), reusing the graph store as the single
  persisted substrate — it already holds per-paper extractions, provider records, and
  recommendations. Discovery's ledger stays what it is (screening memory), but its *inputs*
  come from the substrate instead of its own fetch pass.
- **The two views are cheap derivations** over the substrate. The Map's layout/significance
  step and Discover's screening funnel run as their own (much shorter) jobs, each triggered by
  its tab, both reading the same neighbourhood revision. "Build map" and "Discover" become
  "refresh the neighbourhood, then derive my view" — and when the substrate is fresh (the other
  tab refreshed it minutes ago), the expensive half is skipped entirely. That is the
  quality-of-life win: the second button becomes near-instant.

Options/context (Kamil's "single function… based on options"): the pass takes `breadth`
(references-only for a pure Map refresh; +forward-citations +goal-search when Discover needs
reservoir) and `since` (incremental, from the frontier bookkeeping Discovery slice 2 planned).
A view never triggers more breadth than it needs, but breadth fetched for one view is banked
for both.

## What deliberately does NOT merge

- **Ranking.** Structural significance and what-to-read-next are different judgments; forcing
  one scorer produced the mediocre pre-rebuild Discover. The funnel (gate → cheap triage →
  blend) and `score_recommendations` both stay, as view-side derivations.
- **The tabs.** Two entry points remain — the mental models ("see my field" vs "what next") are
  distinct. The merge is beneath them. A later UI pass may add cross-links ("this suggestion in
  the map"), which the shared substrate makes trivial (same node ids).
- **Spend identity.** The neighbourhood pass is one metered operation; each view derivation
  that calls an LLM (triage, path) meters as itself. No operation disappears from the ledger.

## Migration path (three PRs, each shippable)

1. **Substrate extraction:** `graph.py`'s steps 1–2 move behind `neighbourhood_jobs` with the
   graph build calling it — behavior-identical, Map tab unchanged. The job registry, staged
   progress, and retrieval confirmations carry over.
2. **Discovery reads the substrate:** R1/R2/R3 — the OpenAlex lanes (anchors, forward
   citations, topic sweep) — and R5's recommendations consume the substrate, triggering a
   neighbourhood refresh only when stale; what remains Discovery-owned is R4, the Semantic
   Scholar goal search, which is goal-dependent and has no place in a goal-agnostic substrate.
   Fresh provider data writes BACK to the substrate.
3. **Client convergence:** both tabs show the shared "neighbourhood freshness" line; the near-
   instant second-view behavior lands; cross-links optional.

Risks — and the two mechanisms PR 1 must BUILD, because neither exists today:

- **The graph store has no revisioning.** `save()` is a whole-document atomic write; last
  writer wins silently. The clobber is not hypothetical even now: a graph build load-mutate-
  saves the document many times mid-build while `discovery.py` saves resolved anchors into the
  same file. PR 1 adds a store revision counter checked on write (stale write → reload, merge,
  retry), which also retroactively closes today's race.
- **Nothing serializes the two features.** Graph and discovery run in SEPARATE registries with
  different key schemes, so "one neighbourhood job per project" must be designed, not
  inherited. The rule: the neighbourhood pass is one registry keyed on bare `pid`; a request
  whose `breadth` exceeds the running job's does NOT silently join it (a joined narrow pass
  would hand Discover an incomplete reservoir with no signal) — it queues a follow-up sweep for
  the missing lanes, and the views read whatever revision is complete for their needs.

DR-046's lesson applies: substrate absence must render as "not built yet + offer", never as
loss.

## Open questions for Kamil

1. Should a Discover run auto-refresh a stale neighbourhood (minutes, metered) or ask first?
   The roadmap's risk posture (never surprise-block a legitimate user) suggests: refresh
   automatically when the substrate is absent, ask when it is merely stale.
2. Does the Map's "rebuild" button survive, or become "refresh neighbourhood" with the layout
   derivation always implied?

---

# The surface (agreed 2026-09-04)

## What he asked for

> "I think we keep all features of Map and the tab, and we integrate Discover. And we shouldn't
> be differentiating or have boundaries between the two when possible."
> — Kamil, 2026-09-04, choosing **one tab, no mode switch**

With three follow-ups settled the same day: **the graph leads** and the list sits below it; a
query **highlights matching nodes already in the graph** rather than injecting new ones; and the
tab **stays "Map"**. On scope: *"Both the query and the project are important when a query is
provided. The query in the context of the project is the priority."*

## What the duplication actually is

Not the whole of either screen, and not a *visible* duplication — that framing was wrong in
review. Both tabs offer **a way to add recommended papers**, but the Map's is behind a `zap`
header icon that opens a `BottomSheet` (`graph.tsx:301`, panel at `:411`): 100 rows max, paged
20 at a time, no Hide, no abstract, no affiliations, no relevance. Kamil's remark was about
seeing two **tabs**, not two lists on screen. The duplication is of KIND — two places that
recommend papers to add, over one substrate — not of rendered surface:

| | Map today | Discover today |
|---|---|---|
| reference graph | ✅ `GraphCanvas` | — |
| neighbourhood freshness | ✅ `NeighbourhoodLine` | ✅ same component |
| papers to add | ✅ `GET /graph` → `recommendations` | ✅ goal-driven suggestions |
| author board, labs research | ✅ | — |
| open-ended query | — | ✅ `run_discovery` |
| hide / unhide | (filtered by `discovery.filter_hidden`) | ✅ `discovery.hide_candidate` |

So "I still see both" is two TABS that each recommend papers to add, over a substrate that
already merged: `neighbourhood.py` (DR-052 PRs 1–2) and the shared hidden-list are used by both today.

## The merged surface

**One tab, `Map`.** Graph on top, as now. Below it, **one ranked list** of papers to add — not
sections, because sections are the boundary he asked us not to draw. Provenance moves onto each
row instead, in language the engine already emits (`discovery.py` builds these strings today):

- *"Cites “…” from your reading list"*
- *"New: has started citing “…” from your list"*
- *"Recommended from your reading list’s citation patterns"* (curly apostrophe in the source; `_preview` emits "from your list" rather than "from your reading list", so two variants ship depending on surface)
- and, when a query ran, the query's own reason

**Opening the tab costs nothing — with one correction from review.** The reference-derived lane
is a file read: `GET /graph`'s `recommendations` field, already in the graph store. The
**forward-citer lane is not**. The store holds only per-anchor citer ID SETS
(`record_forward_sweep` writes `{citers, swept_at, complete, source}`) — no title, no authors, no
abstract — and the rows come from `neighbourhood.forward_delta()`, a Semantic Scholar sweep of
one call per corpus paper that declines to start without an S2 key. So free rows come only from
the last run's persisted result and the discovery ledger's reservoir; producing NEW ones is
network work inside the run job.

The multi-source query run costs real money and takes minutes, so it stays an explicit action on
a background job — invariant 1, not a preference.

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

Each step ships and is verifiable on its own. Step 1 is deliberately duplicative until step 3;
no other step leaves the tab half-merged.

1. **Lanes behind one list.** Feed the Map's recommendations into the same ranked list Discover
   builds, with provenance per row. The source is `GET /graph`'s `recommendations` field, **not**
   `GET /graph/recommendations` — that route has no caller in `mobile/`, `web/` or `shared/`.

   **COPY, not move:** the Map's `zap` sheet keeps working through this step, because removing it
   would strip a Map feature and "we keep all features of Map" is the constraint. That does mean
   the same rows are reachable from two places until step 3, which is the one step that is
   deliberately worse before it is better.

   **The real content of this step is shape, not plumbing.** `GraphRecommendation` has no
   `candidate_id`, `abstract`, `affiliations`, `sources`, `relevance` or `credibility`, and calls
   its reasons `recommend_reasons`. `SuggestionCard` keys both its React identity and its
   in-flight hide guard on `candidate_id` — so dropping graph rows in unchanged gives every one
   of them `undefined`, colliding React keys and a hide response that can flip the wrong card.
   Step 1 is a server-side `candidate_id` + `reasons` alias, or an explicit client adapter.

   **Implemented in [#528](https://github.com/kamilkhan52/research-companion/pull/528).** The client
   adapter gives graph rows stable card identities, preserves each lane's own ranking, collapses
   cross-lane identities without replacing the richer query card, and labels every row as a search
   result, project-graph recommendation, or both. The duplicate Map sheet remains by design until
   step 3.
2. **First-run, BEFORE the tab goes.** Empty project shows the query box as the on-ramp. This
   moved ahead of the tab removal in review: today's only on-ramp is `EmptyProjectHub`'s
   "Discover papers" CTA (`index.tsx:503` → `router.push('/discover')`), and the Map tab's
   zero-paper state is "No map yet" with a **Build map** button. Removing Discover's tab first
   would point every new project's CTA at a dead end.

   **Implemented in [#521](https://github.com/kamilkhan52/research-companion/pull/521) (DR-157).**
   The CTA now enters Map, where a confirmed zero-paper project renders the shared Discover
   query/job/results content. The standalone tab remains until the later surface steps ship.
3. **The list moves under the graph** in the Map tab, with the query box. Discover's tab is
   removed; its route and `index.tsx`'s `onDiscover` both land on the query box. Touches
   `_layout.tsx`'s `TAB_META` (4 slots → 3) and `nowPlayingVisibility.ts`'s hardcoded
   `TAB_PATHS`.
4. **Query ↔ graph highlighting.** Matching nodes light up; no new nodes.

## Scope and settled surface mechanics

**Mobile only.** The web SPA has its own `discover` view and hash route (`web/src/App.tsx`) and
its own `RecommendationsPanel` (`web/src/components/Graph.tsx`); it follows separately via
`docs/web-rebuild-plan.md`.

**One search box has two deliberate phases.** While the reader types, it filters graph nodes
locally and for free. Submitting the same text starts the metered Discover background job. The
control must make the submit boundary legible; merely typing can never spend money.

**Two long jobs can be live on one screen.** The graph build (`graph_jobs`, keyed on `pid`) and
the Discover run (`discovery_jobs`, scoped `discovery:${pid}`) are separate registries and can
run concurrently. The write race itself is closed by `graph_store` revisioning (#407). Both jobs
remain visible when concurrent, each with its own progress and Stop controls; neither replaces or
conceals the other.

## Decisions confirmed by Kamil 2026-09-13

Kamil answered each remaining surface question directly: **yes** to the one-box type/submit
boundary, **yes** to simultaneous independent job controls, **yes** to query-first ordering with
per-row provenance, and **keep Map for the first release** pending device use.

- **Ordering between lanes in one list.** With an active submitted query, Discover matches come
  first in their existing query ranking, followed by graph-derived recommendations in their
  existing project ranking. With no active query, use the existing project ranking. De-duplicate
  across lanes and show provenance on every row; do not pretend the two incomparable score scales
  form one numeric score.
- **Tab name.** Keep **Map** for the first release and revisit it only after device use.
