// Memoized force-directed layout for the reference graph. Recomputes only when the graph's
// actual shape changes (node set + edge set), not on every render/re-fetch, so panning/zooming
// or opening a detail sheet never triggers an expensive re-layout.

import { useMemo } from 'react';

import type { GraphEdge, GraphNode } from '@/api/types';
import { computeForceLayout, type LayoutResult } from '@/graph/layout';

// Sizes are a significance tier, not a raw citation tally: how many project papers cite this
// one *significantly* (the same signal the "Significant" filter and NodeDetailSheet's "Significant
// in" stat use) — capped so one runaway outlier can't dominate the canvas. Project papers get a
// bigger flat base (they're "your" papers regardless of citation stats) and grow on the same scale.
const SIGNIFICANCE_STEP = 2.6;
const MAX_SIGNIFICANCE_WEIGHT = 8;

// Global citations, on a log scale. Linear is unusable here: the range across a real project runs
// from 0 to about 170,000, so one node would swallow the canvas and every other would be
// identical. Each 10x adds one step, which is how people actually reason about citation counts —
// the gap between 10 and 100 means what the gap between 10,000 and 100,000 means.
//
// Starts at 100 (`CITATION_LOG_FLOOR`) so an ordinary paper is not penalised for being recent or
// niche, and caps at 5 steps (100 → 10,000,000) so the most-cited paper in a project is bigger
// than its neighbours without being a different order of object.
const CITATION_STEP = 2.2;
const CITATION_LOG_FLOOR = 100;
const MAX_CITATION_WEIGHT = 5;

/** How much a node's global citation count adds to its radius. 0 when the count is unknown. */
export function citationWeight(citationCount: number | null | undefined): number {
  if (typeof citationCount !== 'number' || citationCount <= CITATION_LOG_FLOOR) return 0;
  const steps = Math.log10(citationCount / CITATION_LOG_FLOOR);
  return Math.min(steps, MAX_CITATION_WEIGHT);
}

export function nodeRadius(node: GraphNode): number {
  const base = node.kind === 'project' ? 20 : 11;
  const tier = Math.min(node.significant_cited_by_count, MAX_SIGNIFICANCE_WEIGHT);
  // Two independent signals, deliberately kept separate: how much this paper matters INSIDE the
  // project (how many of its papers cite it) and how much it matters outside it. A paper can be
  // central to this reading list and little-cited elsewhere, or a famous paper nothing here
  // builds on, and both facts are worth seeing.
  return base + tier * SIGNIFICANCE_STEP + citationWeight(node.citation_count) * CITATION_STEP;
}

export function useGraphLayout(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  // Fast path: the server precomputed positions (semantic layout: X = time, Y = citation
  // impact — see app/graph_layout.py rules). Use them directly — no
  // client-side O(n²) simulation, so the screen renders instantly at any size. Only kicks in
  // when every rendered node has coordinates; otherwise we fall back to the client sim below.
  //
  // The visible set is often a SUBSET of the graph the server laid out (focused view, filter
  // tabs), scattered across the full canvas — which reads as absurdly long edges on a phone.
  // So rescale the visible nodes' bounding box to a phone-sized canvas. The rescale is
  // monotonic per axis, so relative positions — including both semantic axis orders —
  // are preserved exactly.
  const serverLayout = useMemo<LayoutResult | null>(() => {
    if (!nodes.length || !nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')) {
      return null;
    }
    const MARGIN = 80;
    const W = 1500;
    const xs = nodes.map((n) => n.x as number);
    const ys = nodes.map((n) => n.y as number);
    const xmin = Math.min(...xs);
    const xspan = Math.max(1, Math.max(...xs) - xmin);
    const ymin = Math.min(...ys);
    const yspan = Math.max(1, Math.max(...ys) - ymin);
    // Derive canvas height from the data's own aspect instead of a fixed tall canvas:
    // stretching every visible subset onto ~2200px of y inflated vertical distances, so
    // time-distant citations rendered as very long vertical edges. Clamped so extreme spans
    // can't flatten to a strip; the per-axis rescale stays monotonic, so both semantic
    // axis orders are untouched.
    const H = Math.min(2200, Math.round(W * Math.min(1.15, Math.max(0.55, yspan / xspan))));
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      positions[n.id] = {
        x: MARGIN + (((n.x as number) - xmin) / xspan) * (W - 2 * MARGIN),
        y: MARGIN + (((n.y as number) - ymin) / yspan) * (H - 2 * MARGIN),
      };
    }
    return { positions, width: W, height: H, semantic: true };
  }, [nodes]);

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
