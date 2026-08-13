// The layout hook's laziness contract: when the server supplied semantic coordinates for every
// visible node, the O(n²·iterations) client force simulation must not run AT ALL — it used to
// execute on every filter/page change and be thrown away (`serverLayout ?? clientLayout`, both
// eager useMemos).

import { renderHook } from '@testing-library/react-native';

import type { GraphEdge, GraphNode } from '@/api/types';
import { useGraphLayout } from '@/hooks/useGraphLayout';
import { computeForceLayout } from '@/graph/layout';

jest.mock('@/graph/layout', () => {
  const actual = jest.requireActual('@/graph/layout');
  return { ...actual, computeForceLayout: jest.fn(actual.computeForceLayout) };
});

const node = (id: string, coords?: { x: number; y: number }): GraphNode => ({
  id,
  title: id,
  kind: 'external',
  authors: [],
  year: 2024,
  citation_count: 0,
  cited_by_project_count: 0,
  significant_cited_by_count: 0,
  ...coords,
} as unknown as GraphNode);

const edge = (source: string, target: string): GraphEdge =>
  ({ source, target, significant: false } as unknown as GraphEdge);

beforeEach(() => {
  (computeForceLayout as jest.Mock).mockClear();
});

test('server-laid-out graphs never run the client simulation', () => {
  const nodes = [node('a', { x: 0, y: 0 }), node('b', { x: 10, y: 4 })];
  const { result, rerender } = renderHook(
    ({ ns }: { ns: GraphNode[] }) => useGraphLayout(ns, [edge('a', 'b')]),
    { initialProps: { ns: nodes } },
  );

  expect(result.current.semantic).toBe(true);
  expect(result.current.positions.a).toBeDefined();
  expect(computeForceLayout).not.toHaveBeenCalled();

  // A fresh query response: same shape, new object identities — still no simulation.
  rerender({ ns: [node('a', { x: 0, y: 0 }), node('b', { x: 10, y: 4 })] });
  expect(computeForceLayout).not.toHaveBeenCalled();
});

test('a node without server coordinates falls back to the simulation', () => {
  const make = () => [node('a', { x: 0, y: 0 }), node('b')];
  const { result, rerender } = renderHook(
    ({ ns }: { ns: GraphNode[] }) => useGraphLayout(ns, [edge('a', 'b')]),
    { initialProps: { ns: make() } },
  );

  expect(computeForceLayout).toHaveBeenCalledTimes(1);
  expect(result.current.semantic).toBeFalsy();
  expect(result.current.positions.a).toBeDefined();
  expect(result.current.positions.b).toBeDefined();

  // A poll refetch delivers the same shape with fresh object identities — the build stage does
  // this continuously, and it is where the fallback path lives. The simulation must not re-run
  // (Opus review: depending on `nodes` identity re-ran it on every poll).
  rerender({ ns: make() });
  expect(computeForceLayout).toHaveBeenCalledTimes(1);

  // The build stage also assigns coordinates progressively. The simulation reads none of them,
  // so a partial coordinate update on a still-incomplete graph must not re-run it either.
  rerender({ ns: [node('a', { x: 5, y: 0 }), node('b')] });
  expect(computeForceLayout).toHaveBeenCalledTimes(1);
});

test('on the server path, a coordinate change is a new layout', () => {
  // `c` is interior to the bounding box — a corner node would rescale to the same normalized
  // position either way, since the rescale maps the box onto a fixed canvas.
  const make = (cx: number) => [
    node('a', { x: 0, y: 0 }),
    node('b', { x: 10, y: 4 }),
    node('c', { x: cx, y: 2 }),
  ];
  const { result, rerender } = renderHook(
    ({ ns }: { ns: GraphNode[] }) => useGraphLayout(ns, [edge('a', 'b')]),
    { initialProps: { ns: make(5) } },
  );
  const before = result.current.positions.c;
  rerender({ ns: make(8) });
  expect(result.current.positions.c).not.toEqual(before);
  expect(computeForceLayout).not.toHaveBeenCalled();
});
