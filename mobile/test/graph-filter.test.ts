// DR-052 step 4: the Map's one search box is often given a TOPIC, not a title fragment.
import type { GraphNode } from '@/api/types';
import { nodeMatchesQuery } from '@/graph/filter';

function node(title: string, authors: string[] = [], year: number | null = 2024): GraphNode {
  return {
    id: title, kind: 'external', slug: null, title, authors, venue: '', year, arxiv_id: null,
    doi: null, url: null, group: null, list_status: null, cited_by_project_count: 0,
    significant_cited_by_count: 0, cites_count: 0,
  } as GraphNode;
}

const HYBRID = node('Hybrid Bonding for Stacked DRAM', ['C. Writer']);
const BERT = node('BERT: Pre-training of Deep Bidirectional Transformers', ['J. Devlin'], 2018);

test('an empty search matches everything', () => {
  expect(nodeMatchesQuery(BERT, '  ')).toBe(true);
});

test('a title fragment, an author and a year still narrow exactly as before', () => {
  expect(nodeMatchesQuery(HYBRID, 'stacked dr')).toBe(true);
  expect(nodeMatchesQuery(BERT, 'devlin')).toBe(true);
  expect(nodeMatchesQuery(BERT, '2018')).toBe(true);
  expect(nodeMatchesQuery(BERT, 'stacked dr')).toBe(false);
});

test('a topic finds the papers about it without matching unrelated ones', () => {
  const topic = 'hybrid bonded 3D DRAM for AI workloads';
  expect(nodeMatchesQuery(HYBRID, topic)).toBe(false);
  expect(nodeMatchesQuery(HYBRID, 'hybrid bonding stacked DRAM for AI workloads')).toBe(true);
  expect(nodeMatchesQuery(BERT, topic)).toBe(false);
});

test('a short query needs every word; one shared word is not a match', () => {
  expect(nodeMatchesQuery(HYBRID, 'hybrid dram')).toBe(true);
  expect(nodeMatchesQuery(HYBRID, 'hybrid transformers')).toBe(false);
  expect(nodeMatchesQuery(BERT, 'deep dram')).toBe(false);
});

test('filler words do not count for or against a match', () => {
  expect(nodeMatchesQuery(HYBRID, 'papers about the stacked dram')).toBe(true);
});
