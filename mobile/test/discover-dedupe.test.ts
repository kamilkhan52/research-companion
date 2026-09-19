// DR-113 — Kamil's Discover screenshot carried a red "Encountered two children with the same
// key" toast over the results. The cause was real duplication, fixed at the source in
// `discovery_recall.merge_candidates`; this guard exists because results ALREADY SAVED on disk
// still hold the duplicate, and re-running Discover is a paid multi-minute job. Without it, his
// existing results keep showing one paper twice.

import {
  dedupeSuggestions,
  graphRecommendationToSuggestion,
  MAX_UNIFIED_GRAPH_RECOMMENDATIONS,
  mergeRecommendationLanes,
} from '@/app/(tabs)/discover';
import type { GraphRecommendation, PaperSuggestion } from '@/api/types';

const GRAPH_REC: GraphRecommendation = {
  id: 'ext:arxiv:2401.00001',
  kind: 'external',
  slug: null,
  title: 'A Project Recommendation',
  authors: ['A. Author'],
  venue: 'Systems',
  year: 2024,
  arxiv_id: '2401.00001v2',
  doi: null,
  url: 'https://arxiv.org/abs/2401.00001',
  group: null,
  list_status: null,
  cited_by_project_count: 2,
  significant_cited_by_count: 1,
  cites_count: 0,
  citation_count: 42,
  provenance: ['full_text', 'semantic_scholar'],
  recommend_score: 7.2,
  recommend_reasons: ['Cited by 2 papers in this project'],
  betweenness_centrality: 0.4,
};

const QUERY_ROW: PaperSuggestion = {
  candidate_id: 'arxiv:2401.00001',
  arxiv_id: '2401.00001',
  title: 'A Project Recommendation',
  abstract: 'Query abstract',
  authors: ['A. Author'],
  affiliations: ['Example University'],
  year: 2024,
  category: 'cs.DC',
  venue: 'Systems',
  url: 'https://arxiv.org/abs/2401.00001',
  pdf_url: 'https://arxiv.org/pdf/2401.00001',
  citation_count: 42,
  sources: ['arxiv'],
  relevance: 9,
  credibility: 3,
  score: 9.5,
  reasons: ['Matches the active query'],
};

test('a repeated candidate id is shown once, keeping the higher-ranked copy', () => {
  const rows = [
    { candidate_id: 'arxiv:2012.09852', title: 'SpAtten', rank: 11 },
    { candidate_id: 'arxiv:2012.09852', title: 'SpAtten', rank: 12 },
    { candidate_id: 'arxiv:2401.00001', title: 'Another' },
  ];
  const out = dedupeSuggestions(rows);
  expect(out).toHaveLength(2);
  expect(out[0].rank).toBe(11);
  expect(out.map((r) => r.candidate_id)).toEqual(['arxiv:2012.09852', 'arxiv:2401.00001']);
});

test('rows without a candidate id are all kept — a missing id is not evidence of sameness', () => {
  const rows = [
    { candidate_id: undefined, title: 'One' },
    { candidate_id: null, title: 'Two' },
    { candidate_id: '', title: 'Three' },
  ];
  expect(dedupeSuggestions(rows)).toHaveLength(3);
});

test('an ordinary result is passed through unchanged', () => {
  const rows = [{ candidate_id: 'a' }, { candidate_id: 'b' }, { candidate_id: 'c' }];
  expect(dedupeSuggestions(rows)).toEqual(rows);
});

test('a graph recommendation gains a stable card identity and project provenance', () => {
  const adapted = graphRecommendationToSuggestion(GRAPH_REC);
  expect(adapted.candidate_id).toBe('graph:ext:arxiv:2401.00001');
  expect(adapted.reasons).toEqual(['Cited by 2 papers in this project']);
  expect(adapted.score).toBe(7.2);
  expect(adapted.sources).toEqual(['semantic_scholar']);
  expect(adapted.recommendation_provenance).toBe('Project graph');
});

test('query ranking leads, a cross-lane duplicate is one row, and both reasons survive', () => {
  const nextGraph = {
    ...GRAPH_REC,
    id: 'ext:title:another project paper',
    title: 'Another Project Paper',
    arxiv_id: null,
    recommend_score: 6,
  };
  const merged = mergeRecommendationLanes([QUERY_ROW], [GRAPH_REC, nextGraph]);

  expect(merged.map((row) => row.title)).toEqual([
    'A Project Recommendation',
    'Another Project Paper',
  ]);
  expect(merged[0].reasons).toEqual([
    'Matches the active query',
    'Cited by 2 papers in this project',
  ]);
  expect(merged[0].recommendation_provenance).toBe('Search result · Project graph');
  // The richer query card wins the duplicate rather than being replaced by the sparse graph row.
  expect(merged[0].abstract).toBe('Query abstract');
  expect(merged[1].candidate_id).toBe('graph:ext:title:another project paper');
  expect(merged[1].recommendation_provenance).toBe('Project graph');
});

test('a shared title cannot merge two rows whose strong identities conflict', () => {
  const query = { ...QUERY_ROW, arxiv_id: null, doi: '10.1/query' };
  const graph = { ...GRAPH_REC, arxiv_id: null, doi: '10.1/graph' };

  expect(mergeRecommendationLanes([query], [graph])).toHaveLength(2);
});

test('the graph lane stops at the same high-signal ceiling as the Map sheet', () => {
  const graphRows = Array.from({ length: MAX_UNIFIED_GRAPH_RECOMMENDATIONS + 1 }, (_, i) => ({
    ...GRAPH_REC,
    id: `ext:title:project recommendation ${i}`,
    title: `Project Recommendation ${i}`,
    arxiv_id: null,
  }));

  expect(mergeRecommendationLanes([], graphRows)).toHaveLength(MAX_UNIFIED_GRAPH_RECOMMENDATIONS);
  expect(mergeRecommendationLanes([], graphRows).at(-1)?.title)
    .toBe(`Project Recommendation ${MAX_UNIFIED_GRAPH_RECOMMENDATIONS - 1}`);
});
