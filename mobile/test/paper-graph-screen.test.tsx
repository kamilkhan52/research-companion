// The per-paper reference graph screen: the summary counts, the building/empty states, and the
// ego canvas. The Skia canvas and the node sheet are mocked to nulls — this exercises the
// screen's state logic (loading / building / not-built offer / ego summary), not the renderer.

import { render } from '@testing-library/react-native';

jest.mock('@/components/graph/GraphCanvas', () => ({ GraphCanvas: () => null }));
jest.mock('@/components/graph/NodeDetailSheet', () => ({ NodeDetailSheet: () => null }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ slug: 'deepstack' }),
}));
jest.mock('@/store/project', () => ({ useActiveProject: () => ({ activePid: 'proj' }) }));

const mockUsePaperGraph = jest.fn();
jest.mock('@/api/queries', () => ({ usePaperGraph: (...a: unknown[]) => mockUsePaperGraph(...a) }));

import PaperGraphScreen from '@/app/paper-graph/[slug]';
import type { GraphNode } from '@/api/types';

const node = (id: string, kind: 'project' | 'external' = 'external'): GraphNode =>
  ({ id, kind, slug: kind === 'project' ? id : null, title: id, authors: [], venue: '',
     year: 2025, arxiv_id: null, doi: null, url: null, group: null, list_status: null,
     cited_by_project_count: 0, significant_cited_by_count: 0, cites_count: 0 } as GraphNode);

const ego = {
  center_id: 'deepstack',
  nodes: [node('deepstack', 'project'), node('r1'), node('r2')],
  edges: [],
  references_count: 2,
  citers_count: 0,
  external_citer_count: 42,
  capped: false,
  layout: { algo: 'ego-v1' },
};

test('shows the reference / citer / external summary from the ego', () => {
  mockUsePaperGraph.mockReturnValue({ data: { ego, build: null }, isLoading: false });
  const { getByText } = render(<PaperGraphScreen />);
  expect(getByText(/references/)).toBeTruthy();
  expect(getByText(/cite it here/)).toBeTruthy();
  expect(getByText(/cite it elsewhere/)).toBeTruthy();   // external count present
  expect(getByText('42')).toBeTruthy();
});

test('hides the external-citer stat when the count is zero or not scanned', () => {
  mockUsePaperGraph.mockReturnValue({
    data: { ego: { ...ego, external_citer_count: null }, build: null }, isLoading: false });
  const { queryByText } = render(<PaperGraphScreen />);
  expect(queryByText(/cite it elsewhere/)).toBeNull();
});

test('offers to open the Map when no ego (graph not built), never an error', () => {
  mockUsePaperGraph.mockReturnValue({ data: { ego: null, build: null }, isLoading: false });
  const { getByText } = render(<PaperGraphScreen />);
  expect(getByText('No reference map yet')).toBeTruthy();
  expect(getByText('Open the Map')).toBeTruthy();
});

test('shows a building state while the graph is building', () => {
  mockUsePaperGraph.mockReturnValue({
    data: { ego: null, build: { status: 'running' } }, isLoading: false });
  const { getByText } = render(<PaperGraphScreen />);
  expect(getByText('Building the reference map…')).toBeTruthy();
});
