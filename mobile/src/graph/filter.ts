// The "Significant" view's node set. Keep every node PARTICIPATING in a significant citation
// — both ends — plus anything significantly cited. Keeping only significantly-cited nodes hid
// every citing project paper (siblings rarely cite each other, so their own cited-by count is
// 0), and since the canvas renders edges only between visible nodes, the default view showed
// nodes with zero edges (R6.3).

import type { GraphEdge, GraphNode } from '@/api/types';

export function significantNodes(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const inSignificantEdge = new Set<string>();
  for (const e of edges) {
    if (e.significant) {
      inSignificantEdge.add(e.source);
      inSignificantEdge.add(e.target);
    }
  }
  return nodes.filter((n) => n.significant_cited_by_count > 0 || inSignificantEdge.has(n.id));
}

/** Page the ranked Significant view without stranding edges: whenever a ranked node is taken,
 *  its significant-edge partners come along immediately (soft page limit — partners may push a
 *  page slightly past `limit` so the last-taken node is never left edge-less). A plain
 *  `slice(0, limit)` re-created the empty-edge map whenever one rank tier (e.g. all project
 *  sources, ranked first) filled the page and every counterpart fell off it. */
export function pageSignificant(ranked: GraphNode[], edges: GraphEdge[], limit: number): GraphNode[] {
  const inView = new Set(ranked.map((n) => n.id));
  const partners = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = partners.get(a);
    if (list) list.push(b);
    else partners.set(a, [b]);
  };
  for (const e of edges) {
    if (!e.significant || !inView.has(e.source) || !inView.has(e.target)) continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const byId = new Map(ranked.map((n) => [n.id, n]));
  const kept = new Set<string>();
  const out: GraphNode[] = [];
  const take = (id: string) => {
    const node = byId.get(id);
    if (!node || kept.has(id)) return;
    kept.add(id);
    out.push(node);
  };
  for (const n of ranked) {
    if (out.length >= limit) break;
    if (kept.has(n.id)) continue;
    take(n.id);
    for (const partner of partners.get(n.id) ?? []) take(partner);
  }
  return out;
}
