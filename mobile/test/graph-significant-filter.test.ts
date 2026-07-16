// R6.3 — the default "Significant" view must show the significant CITATIONS, not just the
// cited nodes. On the real 3D DRAM graph every significant edge's source was a project paper
// whose own significant_cited_by_count was 0 (siblings don't cite each other), so the old
// node-only filter dropped every source, no edge had two visible endpoints, and the map drew
// nodes with zero edges.

import type { GraphEdge, GraphNode } from '@/api/types';
import { pageSignificant, significantNodes } from '@/graph/filter';

function node(id: string, kind: 'project' | 'external', significantCitedBy = 0): GraphNode {
  return {
    id,
    kind,
    slug: kind === 'project' ? id : null,
    title: id,
    authors: [],
    venue: '',
    year: 2026,
    arxiv_id: null,
    doi: null,
    url: null,
    group: null,
    list_status: null,
    cited_by_project_count: 0,
    significant_cited_by_count: significantCitedBy,
    cites_count: 0,
  };
}

function edge(source: string, target: string, significant: boolean): GraphEdge {
  return { source, target, significant, reason: '', contexts: [] } as unknown as GraphEdge;
}

test('keeps both endpoints of significant edges so the edges actually render', () => {
  const nodes = [
    node('paper-a', 'project'),          // cites ref-1 significantly, itself uncited
    node('ext:ref-1', 'external', 2),
    node('ext:ref-2', 'external'),       // only cited insignificantly
  ];
  const edges = [
    edge('paper-a', 'ext:ref-1', true),
    edge('paper-a', 'ext:ref-2', false),
  ];

  const kept = significantNodes(nodes, edges).map((n) => n.id);

  expect(kept).toContain('paper-a');     // the citing side — dropped by the old filter
  expect(kept).toContain('ext:ref-1');
  expect(kept).not.toContain('ext:ref-2');
});

test('still keeps significantly-cited nodes with no surviving edge record', () => {
  const nodes = [node('ext:orphan', 'external', 1), node('ext:noise', 'external')];

  const kept = significantNodes(nodes, []).map((n) => n.id);

  expect(kept).toEqual(['ext:orphan']);
});

test('pagination pulls each source\'s significant partners onto the same page', () => {
  // More sources than one page: project-first ranking would fill the whole page with sources
  // and strand every external target off it — zero renderable edges again.
  const ranked: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 25; i++) ranked.push(node(`paper-${i}`, 'project'));
  for (let i = 0; i < 25; i++) {
    ranked.push(node(`ext:ref-${i}`, 'external', 1));
    edges.push(edge(`paper-${i}`, `ext:ref-${i}`, true));
  }

  const page = pageSignificant(ranked, edges, 20);
  const onPage = new Set(page.map((n) => n.id));

  const renderable = edges.filter((e) => onPage.has(e.source) && onPage.has(e.target));
  expect(renderable.length).toBeGreaterThan(0);
  // Every project source that made the page has its target with it.
  for (const n of page) {
    if (n.kind === 'project') expect(onPage.has(`ext:ref-${n.id.slice('paper-'.length)}`)).toBe(true);
  }
});

test('growing the page limit extends the previous page (stable prefix)', () => {
  const ranked: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 10; i++) {
    ranked.push(node(`paper-${i}`, 'project'));
    ranked.push(node(`ext:ref-${i}`, 'external', 1));
    edges.push(edge(`paper-${i}`, `ext:ref-${i}`, true));
  }

  const small = pageSignificant(ranked, edges, 6).map((n) => n.id);
  const large = pageSignificant(ranked, edges, 12).map((n) => n.id);

  expect(large.slice(0, small.length)).toEqual(small);
});
