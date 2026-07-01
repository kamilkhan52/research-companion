// Memoized force-directed layout for the reference graph. Recomputes only when the graph's
// actual shape changes (node set + edge set), not on every render/re-fetch, so panning/zooming
// or opening a detail sheet never triggers an expensive re-layout.

import { useMemo } from 'react';

import type { GraphEdge, GraphNode } from '@/api/types';
import { computeForceLayout, type LayoutResult } from '@/graph/layout';

export function nodeRadius(node: GraphNode): number {
  const base = node.kind === 'project' ? 22 : 13;
  const weight = Math.min(node.cited_by_project_count, 8);
  return base + weight * 2.4;
}

export function useGraphLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  serverBounds?: { width: number; height: number },
): LayoutResult {
  // Fast path: the server precomputed positions (temporal layout). Use them directly — no
  // client-side O(n²) simulation, so the screen renders instantly at any size. Only kicks in
  // when every rendered node has coordinates; otherwise we fall back to the client sim below.
  const serverLayout = useMemo<LayoutResult | null>(() => {
    if (!nodes.length || !nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')) {
      return null;
    }
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) positions[n.id] = { x: n.x as number, y: n.y as number };
    return {
      positions,
      width: serverBounds?.width ?? 2200,
      height: serverBounds?.height ?? 2200,
    };
  }, [nodes, serverBounds?.width, serverBounds?.height]);

  const nodeIds = useMemo(() => nodes.map((n) => n.id), [nodes]);
  const edgeInputs = useMemo(
    () => edges.map((e) => ({ source: e.source, target: e.target })),
    [edges],
  );
  // A stable string signature of the graph's shape so the simulation only re-runs when nodes
  // or edges actually change, independent of object identity from a fresh query response.
  const signature = useMemo(
    () => `${nodeIds.join(',')}|${edgeInputs.map((e) => `${e.source}>${e.target}`).join(',')}`,
    [nodeIds, edgeInputs],
  );

  const clientLayout = useMemo(
    () =>
      computeForceLayout(nodeIds, edgeInputs, {
        iterations: Math.min(260, 120 + nodeIds.length * 2),
      }),
    // signature is the real dependency; nodeIds/edgeInputs are derived from it each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  return serverLayout ?? clientLayout;
}
