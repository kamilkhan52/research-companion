# Discover quality evaluation

> **Kept for the fixture, not the pipeline (noted 2026-08-09).** The recall design below describes
> Discover *before* the 2026-07-30 rebuild, which replaced it with a recall-then-screen funnel. What
> is still live is the second half: `tests/fixtures/discovery_quality.json`, the properties the
> deterministic evaluation proves, and the blended score — the rebuild deliberately reuses that
> formula. Read the pipeline section as history; read the fixture section as current.

## Audit result

Before R10.11, Discover generated arXiv expressions, searched only arXiv, and asked the model
to rank the resulting titles and abstracts. Semantic Scholar ran only after recall to attach
citation counts. That meant an important journal or conference paper absent from arXiv could
never enter the candidate set, regardless of its relevance or scholarly impact.

The revised pipeline keeps arXiv because it provides broad open-access coverage, but fans each
planned concept out to both arXiv and Semantic Scholar:

1. The query-planning model returns an arXiv expression and provider-neutral search terms for
   each broad or narrow concept.
2. Results from every concept and provider are collected before the 50-paper context cap.
   Reciprocal-rank fusion rewards papers found by several searches. Eight provider-exclusive
   slots per source are reserved before filling the remaining slots by fused recall score.
3. Results coalesce by versionless arXiv ID, DOI, Semantic Scholar paper ID, or normalized
   cross-provider title. Exact-title aliases do not collapse distinct results from the same
   provider.
4. Existing Semantic Scholar citation enrichment and the Map paper-scoped OpenAlex lookup add
   total/influential citation, venue, author, and institution evidence when available.
5. The scoring model assigns topical relevance (0–10) separately from evidence credibility
   (0–4). The deterministic final score is:

   `relevance + 0.5 × credibility + min(1.5, 0.375 × log10(1 + citations))`

Relevance remains dominant. Institution metadata is supporting evidence only: the prompt
forbids rewarding institutional brand alone or penalizing missing affiliation data. Provider
and enrichment failures degrade to the surviving evidence rather than failing an otherwise
usable run.

## Fixed evaluation fixture

`tests/fixtures/discovery_quality.json` represents a project studying memory disaggregation.
Its arXiv-only recall contains a narrow recent paper and a relevant shared paper, but misses a
foundational OSDI paper. The Semantic Scholar fixture contributes that conference landmark and
a duplicate of the shared paper under another provider identity.

The deterministic evaluation proves that:

- the arXiv-only candidate set misses the conference landmark;
- multi-source recall recovers it;
- the shared paper deduplicates across providers;
- venue and grounded OpenAlex affiliation evidence reach the scoring prompt; and
- the directly relevant landmark ranks above the narrower recent work.

All fixture and unit tests inject search, citation, authorship, and model seams. The test suite
makes no live provider or model requests.

## Operational constraints

Discover remains a registered background job with polling. Semantic Scholar requests use the
existing process-wide pacer, and OpenAlex enrichment is bounded to the selected candidate set.
The job rebinds project context before reading or persisting project state. Opening a persisted
pre-R10.11 result upgrades its response shape in memory without rewriting the file.

Non-arXiv suggestions can be added to the Library. When Semantic Scholar supplies an open-access
PDF, that URL is carried into the existing initial-analysis retrieval offer; a DOI remains the
browser fallback when no PDF is known.
