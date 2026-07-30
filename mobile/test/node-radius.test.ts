import { citationWeight, nodeRadius } from '@/hooks/useGraphLayout';
import type { GraphNode } from '@/api/types';

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: 'n', kind: 'project', slug: 'n', title: 'A paper', authors: [], venue: '', year: 2020,
  arxiv_id: null, doi: null, url: null, group: null, list_status: 'unread',
  cited_by_project_count: 0, significant_cited_by_count: 0, cites_count: 0, ...over,
} as GraphNode);

describe('citationWeight', () => {
  it('is zero for unknown counts, so a missing number never shrinks a node', () => {
    // Coverage is partial by nature — a node OpenAlex and S2 both miss must look like an ordinary
    // node, not like a paper nobody cites.
    expect(citationWeight(undefined)).toBe(0);
    expect(citationWeight(null)).toBe(0);
  });

  it('adds one step per 10x, which is how citation counts are actually read', () => {
    // The gap between 100 and 1,000 should feel like the gap between 10,000 and 100,000.
    expect(citationWeight(1_000)).toBeCloseTo(1);
    expect(citationWeight(10_000)).toBeCloseTo(2);
    expect(citationWeight(100_000)).toBeCloseTo(3);
  });

  it('ignores small counts rather than penalising recent or niche work', () => {
    expect(citationWeight(0)).toBe(0);
    expect(citationWeight(100)).toBe(0);
  });

  it('caps, so the most-cited paper is bigger but not a different kind of object', () => {
    expect(citationWeight(170_000)).toBeLessThanOrEqual(5);
    expect(citationWeight(50_000_000)).toBe(5);
  });
});

describe('nodeRadius', () => {
  it('grows with global citations', () => {
    const plain = nodeRadius(node({ citation_count: 0 }));
    const famous = nodeRadius(node({ citation_count: 100_000 }));
    expect(famous).toBeGreaterThan(plain);
  });

  it('keeps in-project significance and global impact independent', () => {
    // A paper central to THIS reading list but little-cited elsewhere, and a famous paper nothing
    // here builds on, are different facts — neither should mask the other.
    const centralHere = nodeRadius(node({ significant_cited_by_count: 6, citation_count: 20 }));
    const famousElsewhere = nodeRadius(node({ significant_cited_by_count: 0, citation_count: 100_000 }));
    expect(centralHere).toBeGreaterThan(nodeRadius(node()));
    expect(famousElsewhere).toBeGreaterThan(nodeRadius(node()));
  });

  it('an unknown count leaves the radius exactly as it was before this existed', () => {
    expect(nodeRadius(node({ significant_cited_by_count: 3 })))
      .toBe(nodeRadius(node({ significant_cited_by_count: 3, citation_count: null })));
  });

  it('stays bounded for the largest real count in a project', () => {
    // 169,158 (Adam) is the biggest in Kamil's graph; a node must not become a different object.
    const biggest = nodeRadius(node({ significant_cited_by_count: 8, citation_count: 169_158 }));
    expect(biggest).toBeLessThan(60);
  });
});
