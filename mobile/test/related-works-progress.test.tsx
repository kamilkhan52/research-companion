// DR-141 follow-up (Kamil, device, 2026-09-23): "Even while the works were being analyzed, the
// total analyzed count remained 0 which seemed like a bug", and, after the build finished,
// "never really populated the list or given me anything to see as Related Works. The messaging
// still seems like it's pending some work."
import { renderAsync, screen } from '@testing-library/react-native';

import { useAddPaper, useGraph, useRelatedWorks } from '@/api/queries';
import type { GraphResponse, GraphStatus, Paper } from '@/api/types';
import { buildCounter, RelatedWorksSheet } from '@/components/RelatedWorksSheet';
import { useGraphBuild, type GraphBuildProgress, type GraphBuildState } from '@/hooks/useGraphBuild';

jest.mock('@/api/queries', () => ({
  useAddPaper: jest.fn(),
  useGraph: jest.fn(),
  useRelatedWorks: jest.fn(),
}));
jest.mock('@/hooks/useGraphBuild', () => ({ useGraphBuild: jest.fn() }));

const PAPERS: Paper[] = [
  {
    slug: 'alpha', title: 'Alpha Paper', group: 'Reading', list_status: 'read', cites: [],
    retrieved: true, has_notes: true, session_state: 'committed', arxiv_id: '2601.00001',
  },
];

const STATUS: GraphStatus = {
  has_graph: true,
  built_at: '2026-09-23T13:51:22Z',
  model: 'm',
  graph_revision: 'r1',
  graph_stage: 'enriched',
  graph_completeness: null,
  graph_needs_enrichment: false,
  total_papers: 65,
  retrievable_papers: 65,
  stale_papers: [],
  removed_papers: [],
  missing_text_papers: [],
  semantic_scholar_enabled: false,
  semantic_scholar_papers: 0,
  semantic_scholar_stale_papers: [],
  retrieval_candidates: {},
  retrieval_errors: {},
};

function progress(over: Partial<GraphBuildProgress>): GraphBuildProgress {
  return {
    phase: 'extraction',
    graphStage: 'skeleton',
    total: 65,
    ready: 65,
    done: 0,
    currentSlug: null,
    currentTitle: null,
    perPaper: {},
    retrievalCandidates: {},
    ...over,
  };
}

let buildState: GraphBuildState;
let status: GraphStatus;

beforeEach(() => {
  status = STATUS;
  buildState = {
    building: false, progress: null, error: null,
    run: jest.fn(async () => undefined), resume: jest.fn(), clearError: jest.fn(),
  };
  jest.mocked(useAddPaper).mockReturnValue({
    mutateAsync: jest.fn(), isPending: false, isError: false, error: null,
  } as never);
  jest.mocked(useRelatedWorks).mockImplementation(() => ({
    data: [], isLoading: false, isError: false, refetch: jest.fn(),
  }) as never);
  jest.mocked(useGraph).mockImplementation(() => ({
    data: { graph: null, recommendations: [], status, build: null } as GraphResponse,
    isLoading: false, isError: false, refetch: jest.fn(async () => undefined),
  }) as never);
  jest.mocked(useGraphBuild).mockImplementation(() => buildState);
});

function sheet() {
  return (
    <RelatedWorksSheet
      pid="project-a"
      slug="alpha"
      papers={PAPERS}
      visible
      onClose={() => {}}
      onOpenPaper={() => {}}
    />
  );
}

test('the mapping step counts mapped papers instead of reading "0 analyzed"', () => {
  // His first screenshot: header "0 of 65 analyzed" above rows each ticked "References mapped".
  const mapping = progress({
    phase: 'metadata',
    perPaper: { a: 'metadata_cached', b: 'metadata_cached', c: 'metadata_cached', d: 'metadata' },
  });
  expect(buildCounter(mapping)).toBe('3 of 65 mapped');
  expect(buildCounter(mapping)).not.toMatch(/analyzed/);
});

test('each step reports in its own terms, and analysis still counts analyses', () => {
  expect(buildCounter(progress({ phase: 'preparing' }))).toBe('Starting…');
  expect(buildCounter(progress({ phase: 'retrieval', ready: 40 }))).toBe('40 with full text');
  expect(buildCounter(progress({ phase: 'extraction', done: 38 }))).toBe('38 of 65 analyzed');
  expect(buildCounter(progress({ phase: 'complete', done: 65 }))).toBe('65 of 65 analyzed');
});

test('the sheet header uses the step counter while references are being mapped', async () => {
  buildState = {
    ...buildState,
    building: true,
    progress: progress({ phase: 'metadata', perPaper: { alpha: 'metadata_cached' } }),
  };
  await renderAsync(sheet());
  expect(screen.getByText('1 of 65 mapped')).toBeTruthy();
  expect(screen.queryByText('0 of 65 analyzed')).toBeNull();
});

test('an empty list caused by a failed reference read says so and points at the retry', async () => {
  status = {
    ...STATUS,
    stale_papers: ['alpha'],
    extraction_errors: { alpha: "No parseable references in the model's response." },
  };
  await renderAsync(sheet());
  expect(screen.getByText(/references could not be read on the last build/)).toBeTruthy();
  expect(screen.queryByText('No significant related works surfaced for this paper yet.')).toBeNull();
  expect(screen.getByText('Update related works')).toBeTruthy();
});

test('another paper failing does not change this paper\'s honest empty result', async () => {
  status = {
    ...STATUS,
    stale_papers: ['beta'],
    extraction_errors: { beta: 'No response after 480s (hard deadline).' },
  };
  await renderAsync(sheet());
  expect(screen.getByText('No significant related works surfaced for this paper yet.')).toBeTruthy();
  expect(screen.queryByText(/references could not be read/)).toBeNull();
});

test('a server without the field behaves as before', async () => {
  await renderAsync(sheet());
  expect(screen.getByText('No significant related works surfaced for this paper yet.')).toBeTruthy();
});
