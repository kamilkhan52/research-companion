# Semantic Scholar graph comparison — 2026-07-14

## Decision

Use Semantic Scholar as the fast identity and reference-metadata layer, while keeping local
full-text analysis authoritative for project-specific citation significance. The API is strong
enough to build and expand a useful graph quickly, but its influence classification is not a
substitute for reading how a work is used in the source paper.

The intended production pipeline is therefore:

1. resolve project papers and fetch their outbound reference edges from Semantic Scholar;
2. build/persist an immediately useful metadata graph with identifiers and provider evidence;
3. merge cached local full-text extraction into matching edges for higher context coverage and
   the project's significance verdict;
4. retain the current full-text extractor as fallback for provider coverage gaps; and
5. expand an external node's references or incoming citations on demand, one bounded hop per
   background job.

Every stored provider-derived edge must carry provenance. The Map must attribute Semantic
Scholar anywhere its data contributes to visible results.

## Method

A temporary, non-production harness compared the existing per-paper full-text extraction cache
with the live Semantic Scholar Academic Graph `references` endpoint. It obeyed the approved
account's cumulative rate limit by waiting at least 1.1 seconds between requests. The harness
and temporary credential file were kept outside the repository; the credential file was deleted
immediately after the run.

Scope:

- 27 current project papers with successful cached full-text extractions;
- 14 resolved directly from stored scholarly identifiers;
- 13 without stored arXiv identifiers resolved through the paper-title match endpoint;
- all 13 title resolutions were exact after normalized-title comparison and returned external
  identifiers; and
- 62.45 seconds total, with no API errors or throttling responses.

Reference matching preferred arXiv/DOI identity, then used the graph pipeline's 0.86 fuzzy-title
threshold. This is an architectural comparison, not a formal evaluation dataset: matching and
the existing LLM verdicts can each contain errors.

## Results

| Measure | Result |
|---|---:|
| Cached full-text references | 1,616 |
| Semantic Scholar references | 1,422 |
| Matched references | 1,231 |
| Cached references found in Semantic Scholar | 76.18% |
| Semantic Scholar references found in cache | 86.57% |
| Matches by identifier | 325 |
| Matches by fuzzy title | 906 |
| Missing cache identifiers supplied by Semantic Scholar | 557 |
| Cached references with citation context | 99.51% |
| Semantic Scholar references with citation context | 79.75% |
| Semantic Scholar references with intent labels | 33.90% |

Three papers had no Semantic Scholar reference list despite 128 cached references between them.
Excluding those complete provider gaps, Semantic Scholar covered about 82.7% of cached
references. The reverse comparison shows 191 Semantic Scholar references that did not match the
cache, which can represent useful additional coverage, version/dedup differences, or matching
errors and should not be accepted blindly.

### Significance is not interchangeable

Across the 1,231 matched edges:

| Verdict relationship | Edges |
|---|---:|
| Local full-text significant | 205 |
| Semantic Scholar influential | 126 |
| Both positive | 62 |
| Local-only positive | 143 |
| Semantic-Scholar-only positive | 64 |
| Both negative | 962 |

Overall agreement looks high because most citations are negative under both systems, but only
62 of the 205 locally significant citations were also marked influential. Semantic Scholar's
signal is useful evidence and a prioritization feature; it must not overwrite or stand in for
the local, relation-specific significance decision.

## Production implications

- API-first identity should materially improve external-node deduplication: 557 matched
  references gained an identifier in this sample.
- A metadata skeleton for a project of this size can be acquired in roughly a minute under the
  one-request-per-second limit, rather than minutes per paper.
- Provider contexts can render useful evidence immediately, but local contexts remain the
  higher-coverage source and should replace or supplement provider excerpts when available.
- Missing provider lists and unresolved papers must degrade to the existing cached/full-text
  path without failing the overall graph build.
- `isInfluential` and intent labels should be stored as their own fields, not mapped directly
  onto the existing `significant` boolean.
- Provider requests remain long/network-touching work and must run through background jobs with
  project context rebound, per the repository invariants.

## Planned implementation slices

1. **Provider foundation:** secure setting, shared cumulative request pacer, typed normalization,
   retry/error behavior, and tests. No graph-output change.
2. **Metadata cache and merge ([#78](https://github.com/kamilkhan52/research-companion/pull/78)):**
   cache source resolution/reference pages independently of the LLM extraction, enrich matched
   references with identifiers/contexts/intents/provenance, and include metadata-only edges
   without calling them locally significant.
3. **Fast skeleton lifecycle (Phase 5.2, in progress):** persist the metadata graph before
   optional full-text enrichment, exposing completeness/provenance in job and API state without
   bloating the frequently polled job snapshot.
4. **Bounded node expansion:** background jobs for outbound references and incoming citations,
   with explicit one-hop controls and graph-size limits.
5. **Map evidence UI:** attribution plus clear metadata/context-verified/full-text-verified states.
