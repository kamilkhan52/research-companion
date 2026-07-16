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
