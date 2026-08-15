# The corpus-neighbourhood algorithm (DR-052 + Discovery slice 3 + DR-051)

*Approved by Kamil, 2026-08-14. Supersedes the two open questions at the end of
[`map-discover-merge-design.md`](map-discover-merge-design.md), which remains the architectural
design for the merge itself; this document is the ALGORITHM — what the pipeline looks for, with
what signals, and why. Research backing: a survey of Litmaps, Connected Papers, ResearchRabbit,
Inciteful and scite plus live API measurements against Semantic Scholar and OpenAlex, both dated
2026-08-14 and summarised inline below.*

Both Map and Discover answer one question — **what surrounds this corpus?** Kamil's reframe pins
down its physics, and the whole design follows from taking that seriously:

> References for a paper should not change with time. New citations can appear, and if they cite
> our papers in significant ways they become even more important — and maybe that really is the
> core Discovery task: finding papers that cite existing papers in significant ways, are
> significant based on their content, and/or don't cite our papers but are significant to the
> project's goal.

## 1. The two kinds of stale

- **References are frozen.** A published bibliography never changes. Two second-order exceptions:
  an arXiv v2 can add references, and providers keep improving extraction, so the reference list
  *they know about* creeps up.
- **Citations only accumulate**, forever. This is the one genuinely time-varying half.

So "the substrate is stale" means two different things, and they get different treatment:

| Axis | Cause | Detection | Treatment |
|---|---|---|---|
| **Composition stale** | Papers added to the project; their anchors/references/citers are absent | Exact and free: set-difference of reading-list slugs against substrate anchors | **Auto-fix, always, no dialog.** Bounded by the new papers, and it is what pressing either button *means* |
| **Time stale** | The world published new citers since the last forward sweep | Age of the last sweep | **Run on what's there; show a freshness line with one-tap refresh.** Scheduled weekly runs (DR-051) absorb this axis |

This dissolves the merge design's open question 1 ("auto-refresh or ask?") — it was conflating the
two axes. Composition staleness never asks; time staleness never blocks.

**Open question 2 ("does *Rebuild map* survive as a name?") — resolved: keep it.** The label
describes the view the reader gets; a freshness line underneath ("neighbourhood updated 5 min ago
via Discover") teaches the sharing without a rename. Revisit at PR 4 with screenshots.

## 2. The substrate

One neighbourhood pass maintains a persisted substrate in the graph store:

```
substrate (graph store, + store_revision)
├─ anchors        slug → {openalex_id, s2_id, doi, arxiv_id}     identity, paid once
├─ backward       refs of each anchor                            FROZEN — refresh on composition change
├─ forward        per-anchor SET of known citer ids              GROWS — delta-diffed (§5)
│                   + per-edge: contexts, isInfluential
└─ enrichment     per-candidate counts, fwci, percentile, topics

Map tab      = layout + structural significance     derived view, cheap
Discover tab = gate → triage → ranked suggestions   derived view, cheap
```

Rankings deliberately do NOT merge, nor do the tabs — see the merge design. Steps 1–2 are shared;
step 3 is per-view.

## 3. The three lanes

Kamil's framing, grounded against what the tools actually do.

### Lane 1 — significant citers (the differentiator)

**No mapping tool weights citation edges.** Litmaps, Connected Papers, ResearchRabbit and Inciteful
all treat every citer identically; scite reads citation rhetoric but does not do discovery. Lane 1
is unoccupied ground.

- **Recall:** the forward delta (§5) — exact, no similarity function involved.
- **Significance:** S2's ready-made `intents` labels are a **trap for monitoring** — measured live
  at ~70% coverage on pre-2024 citing papers, collapsing to **~18% on 2024+** (0 of the 300 newest
  citers of *Attention Is All You Need*); the classifier runs 1–2 years behind. The raw `contexts`
  sentences hold at **44–76% even on brand-new citers**. So: take the context, classify it
  ourselves.
- **Deterministic pre-filter first**, from the Valenzuela feature set (the research behind S2's own
  influential-citation flag), all computable from data we already fetch: count of our paper in the
  citer's `contexts` (F1 proxy), `1/referenceCount` (F7), author overlap (F4), cue phrases
  ("we follow", "we extend") (F5). Where we hold full text, section-of-citation (F2) is the single
  best feature in that paper. `isInfluential` is a **boost, never a gate** — ~11% recall on new
  citers.
- **Honest prior:** every independent source agrees "significant" is a **5–15% slice** (Valenzuela
  14.6% base rate; measured `isInfluential` 5.4%; scite 6.5% supporting + 0.8% contrasting).

### Lane 2 — content-significant (adopt, don't build)

OpenAlex `citation_normalized_percentile` (field- and year-normalised — right for a
cross-disciplinary corpus) where the paper is old enough to have one; a **Momentum**-style
recency-adjusted count from `counts_by_year` where it is not, so a 6-week-old paper can compete
with a 6-year-old one. Lane 2 is a scoring layer over every candidate, not its own recall lane.

### Lane 3 — goal-relevant non-citers

The existing topic sweep and goal search stay, plus two free S2 primitives no competitor uses:
`POST /recommendations/v1/papers/` accepts **positive and negative** paper lists (our dismissed
papers are the negatives — no other tool has curated rejections), and `/snippet/search` returns the
matching full-text passage, which is both better recall for goal-specific claims and the evidence
to justify a suggestion.

**Lane 3 must never borrow the word "significant":** abstract similarity was the *worst* of twelve
predictors of influence (Valenzuela F9). Relevance and significance are orthogonal — embeddings
belong in recall, never in the significance score.

**Union, then rank — never a mode switch.** The one published evaluation (Ahlgren et al. 2024)
found combining direct citation + co-citation + coupling beats any single signal, and adding text
lanes beats citation-only. Litmaps makes users pick one algorithm per map; our union-then-gate
funnel is the empirically better architecture.

## 4. Ranking additions

- **Corpus connectivity** — a candidate's edge count against *our reading list*, not the world
  (Litmaps surfaces this as "Map Connectivity"). Deterministic, explainable, free from the
  substrate. The Map uses it for structure; Discover generalises today's provenance bonus with it.
- **Momentum** — §3's recency-adjusted count, so the blend stops structurally favouring 2019.
- Existing blend weights and the citation-term cap stay; the two new terms slot in beside them.

**The output rule:** every suggestion names its lane and its evidence — *"cited your Foo et al.
three times in Methods, as the approach they extend"*, not "new relevant paper". An unexplained
ranked list is the recurring complaint in every published review of every competitor, and we hold
the evidence by the time we rank.

## 5. Monitoring (DR-051 rides this)

Litmaps' Monitor re-runs a saved query weekly and diffs the result, which conflates "cites you"
with "resembles you" and inherits index lag. We hold the reference graph, so:

- **A true graph delta:** per project, per week, one newest-first `/citations` call per anchor,
  diffed against the stored citer-id set. Exact, one cheap call per corpus paper.
- **Re-scan a trailing ~90-day window**, not since-last-run — citation edges resolve late ("too
  new" is a failure mode Litmaps documents about itself), and the id-set diff makes the re-scan
  idempotent. OpenAlex's index-time filters (`from_created_date`/`from_updated_date`) that would
  have solved this went **Premium-only in Feb 2026** (verified live); `from_publication_date`
  remains free but answers a different question.
- **LLM spend budgeted to the delta only** — a handful of new citers a week, sized easily by the
  existing per-operation lease.
- **Alert types stay separate** (ResearchRabbit's one good idea): "someone newly cited your paper,
  and here is how" is a different, more valuable event than "a similar paper appeared".

## 6. Deliberately not doing

- **scite's supporting/contrasting via the vendor** — subscription-only, 30% edge coverage, and
  0.00 recall on "contrasting" in the one independent evaluation (Bakker et al. 2023). Steal the
  taxonomy, skip the dependency. Measure our own classifier's recall on the interesting classes,
  not its accuracy — collapse-to-the-boring-class is the documented failure mode.
- **S2 `intents` as a live signal** — backfill only, per the coverage cliff in §3.
- **Embedding similarity in the significance score** — recall stage only.
- **A pick-one-algorithm UI** — the evidence says combine.
- **Merging the rankers or the tabs** — unchanged from the merge design.

## 7. Delivery

| PR | Ships | Visible change |
|---|---|---|
| **1 · Substrate** | Store revisioning + merge-on-save (closes a live write race); neighbourhood module; per-anchor citer sets begin persisting | None — behavior-identical |
| **2 · Discover reads it** | Neighbourhood job; OpenAlex lanes + recommendations consume the substrate; forward recall becomes the stored-set delta; contexts per new edge; composition auto-fix | Second button near-instant; no re-paying for identity |
| **3 · Significance** | Lane-1 pre-filter + context classification; corpus-connectivity and Momentum in the blend; S2 recommendations-with-negatives and snippet search in lane 3 | Evidence line on suggestions; ranking improves on recent papers |
| **4 · Client convergence** | Shared freshness line, one-tap time-refresh, cross-links | The merge becomes visible; DR-051 rides the substrate afterwards |

**Cost shape:** the delta sweep is one to two provider calls per corpus paper (fractions of a cent
per project per week); contexts ride the same calls; LLM triage runs only on gate survivors and
weekly deltas, on the already-pinned cheap models. No new spend category — everything meters
through the existing per-operation ledger.

## Sources

Vendor documentation for Litmaps (search algorithms, Monitor, database coverage, visualization),
Connected Papers, ResearchRabbit, Inciteful and scite; Valenzuela, Ha & Etzioni, *Identifying
Meaningful Citations* (AAAI 2015); Ahlgren et al., *Seed-based information retrieval in networks of
research publications* (arXiv:2403.09295); Bakker, Theis-Mahon & Brown, *Evaluating the Accuracy of
scite* (*Hypothesis* 35(2), 2023); Nicholson et al., *scite: A smart citation index* (*QSS* 2(3),
2021); live measurements against the Semantic Scholar Graph/Recommendations APIs and the OpenAlex
works API, 2026-08-14.
