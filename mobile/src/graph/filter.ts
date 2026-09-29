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

/** How far partner-pulling may push a page past `limit`. A hard cap (not unbounded): one
 *  high-degree paper could otherwise drag hundreds of partners in and re-create the canvas
 *  freeze pagination exists to prevent. */
const PARTNER_SLACK = 20;

/** Page the ranked Significant view without stranding edges: whenever a ranked node is taken,
 *  its significant-edge partners come along immediately (bounded by PARTNER_SLACK past
 *  `limit`; a node whose first partner can't fit isn't taken at all, so every taken source
 *  keeps at least one renderable edge). A plain `slice(0, limit)` re-created the empty-edge
 *  map whenever one rank tier (e.g. all project sources, ranked first) filled the page and
 *  every counterpart fell off it. */
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
  const hardCap = limit + PARTNER_SLACK;
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
    const missing = (partners.get(n.id) ?? []).filter((p) => !kept.has(p));
    // Taking this node must leave room for at least one partner, or its edges couldn't
    // render — end the page here instead of stranding it.
    if (missing.length > 0 && out.length + 2 > hardCap) break;
    take(n.id);
    for (const partner of missing) {
      if (out.length >= hardCap) break;
      take(partner);
    }
  }
  return out;
}


const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'what', 'which',
  'how', 'why', 'does', 'into', 'about', 'such', 'than', 'their', 'there', 'papers', 'paper',
  'work', 'works', 'find', 'related', 'new', 'using', 'use', 'like',
]);

/** Whether a graph node matches the Map's search text (DR-052 step 4).
 *
 * The same box filters the map while typing and runs Discover on submit, so the text is often
 * a TOPIC ("hybrid bonded 3D DRAM for AI workloads") rather than a fragment of one title. A
 * plain substring test would empty the map for every such query. Order of tests:
 * the whole text as a substring (the old behaviour, so a typed title fragment, author or year
 * still narrows exactly); otherwise by words — every word for a short query, most of them for
 * a long one, since no title repeats a whole sentence. */
export function nodeMatchesQuery(node: GraphNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [node.title, ...node.authors, String(node.year ?? '')].join(' ').toLowerCase();
  if (haystack.includes(q)) return true;
  const words = Array.from(new Set(
    q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !QUERY_STOPWORDS.has(w)),
  ));
  if (words.length < 2) return false;
  const hits = words.filter((w) => haystack.includes(w)).length;
  const needed = words.length <= 3 ? words.length : Math.ceil(words.length * 0.6);
  return hits >= needed;
}
