# Merging Map and Discover into one pipeline (DR-052)

*Drafted 2026-08-10. Kamil: "We should be merging Map and Discover… That's a quality of life
upgrade we must push before we are production ready. Think about why; the two have common steps
and differ in context a little. This can be a single function that can fulfil all requirements
based on options or context." Status: design — nothing here is built.*

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
refresh Discovery's reservoir; a Discovery run's fresh OpenAlex data never lands in the graph),
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
2. **Discovery reads the substrate:** R1/R2 (and R5's recommendations) consume the substrate,
   triggering a neighbourhood refresh only when stale; Discovery's own OpenAlex fetching
   shrinks to goal-search (R4). Its fresh data writes BACK to the substrate.
3. **Client convergence:** both tabs show the shared "neighbourhood freshness" line; the near-
   instant second-view behavior lands; cross-links optional.

Risks: the graph store becomes a genuinely shared mutable substrate — writes from two job kinds
need the store's existing revisioning to prevent a Discover write clobbering a mid-build state
(the registry's per-project dedup already serializes the heavy pass; the rule to enforce is
*one neighbourhood job per project at a time*, which `start_or_join`'s keying gives for free).
DR-046's lesson applies: substrate absence must render as "not built yet + offer", never as
loss.

## Open questions for Kamil

1. Should a Discover run auto-refresh a stale neighbourhood (minutes, metered) or ask first?
   The roadmap's risk posture (never surprise-block a legitimate user) suggests: refresh
   automatically when the substrate is absent, ask when it is merely stale.
2. Does the Map's "rebuild" button survive, or become "refresh neighbourhood" with the layout
   derivation always implied?
