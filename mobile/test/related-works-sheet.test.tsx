import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import { useAddPaper, useGraph, useRelatedWorks } from '@/api/queries';
import type {
  GraphBuildJob,
  GraphResponse,
  GraphStatus,
  Paper,
  RelatedWork,
} from '@/api/types';
import { RelatedWorksSheet } from '@/components/RelatedWorksSheet';
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
  {
    slug: 'beta', title: 'Beta Paper', group: 'Reading', list_status: 'unread', cites: [],
    retrieved: true, has_notes: false, session_state: 'unread', arxiv_id: '2601.00002',
  },
];

const STATUS: GraphStatus = {
  has_graph: false,
  built_at: null,
  model: null,
  graph_revision: null,
  graph_stage: null,
  graph_completeness: null,
  graph_needs_enrichment: false,
  total_papers: 2,
  retrievable_papers: 2,
  stale_papers: [],
  removed_papers: [],
  missing_text_papers: [],
  semantic_scholar_enabled: false,
  semantic_scholar_papers: 0,
  semantic_scholar_stale_papers: [],
  retrieval_candidates: {},
  retrieval_errors: {},
};

const RUNNING_JOB: GraphBuildJob = {
  status: 'running',
  phase: 'extraction',
  total: 2,
  ready: 2,
  done: 1,
  current_slug: 'beta',
  current_title: 'Beta Paper',
  per_paper: {
    alpha: { status: 'done', error: null },
    beta: { status: 'extracting', error: null },
  },
  retrieval_candidates: {},
  graph_stage: 'skeleton',
  graph_completeness: null,
  graph_revision: 's1',
  graph_updated_at: '2026-09-06T00:00:00Z',
  graph: null,
  recommendations: null,
  error: null,
  started_at: '2026-09-06T00:00:00Z',
  finished_at: null,
};

const RELATED: RelatedWork = {
  id: 'ext:transformer',
  kind: 'external',
  slug: null,
  title: 'The Annotated Transformer',
  year: 2018,
  venue: '',
  arxiv_id: '1801.00001',
  url: null,
  list_status: null,
  citation_count: 20,
  direction: 'builds_on',
  reason: 'Supplies the attention architecture used here.',
};

const run = jest.fn(async () => undefined);
const resume = jest.fn();
const relatedRefetch = jest.fn(async () => undefined);
const graphRefetch = jest.fn(async () => undefined);

let buildState: GraphBuildState;
let relatedResult: Record<string, unknown>;
let graphResult: Record<string, unknown>;

function graphResponse(status: GraphStatus, build: GraphBuildJob | null = null): GraphResponse {
  return { graph: null, recommendations: [], status, build };
}

function progress(perPaper: GraphBuildProgress['perPaper']): GraphBuildProgress {
  return {
    phase: 'extraction',
    graphStage: 'skeleton',
    total: 2,
    ready: 2,
    done: 1,
    currentSlug: 'beta',
    currentTitle: 'Beta Paper',
    perPaper,
    retrievalCandidates: {},
  };
}

beforeEach(() => {
  buildState = {
    building: false,
    progress: null,
    error: null,
    run,
    resume,
    clearError: jest.fn(),
  };
  relatedResult = {
    data: [], isLoading: false, isError: false, refetch: relatedRefetch,
  };
  graphResult = {
    data: graphResponse(STATUS), isLoading: false, isError: false, refetch: graphRefetch,
  };
  jest.mocked(useAddPaper).mockReturnValue({
    mutateAsync: jest.fn(), isPending: false, isError: false, error: null,
  } as never);
  jest.mocked(useRelatedWorks).mockImplementation(() => relatedResult as never);
  jest.mocked(useGraph).mockImplementation(() => graphResult as never);
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

test('opening an unbuilt sheet never starts paid work until the explicit button is pressed', async () => {
  await renderAsync(sheet());

  expect(screen.getByText('Build related works')).toBeTruthy();
  expect(screen.getByText(/Nothing begins until you tap below/)).toBeTruthy();
  expect(run).not.toHaveBeenCalled();
  expect(useGraphBuild).toHaveBeenCalledWith('project-a', { completionToast: false });

  await fireEventAsync.press(screen.getByText('Build related works'));
  expect(run).toHaveBeenCalledWith(false);
});

test('rejoins a retained build and keeps completed paper events while later work arrives', async () => {
  graphResult = {
    ...graphResult,
    data: graphResponse({ ...STATUS, has_graph: true, graph_revision: 's1' }, RUNNING_JOB),
  };
  buildState = {
    ...buildState,
    building: true,
    progress: progress({ alpha: 'done' }),
  };
  const view = await renderAsync(sheet());

  await waitFor(() => expect(resume).toHaveBeenCalledWith(RUNNING_JOB));
  expect(screen.getByText('Alpha Paper')).toBeTruthy();
  expect(screen.getByText('Analyzed')).toBeTruthy();
  expect(screen.getByText('1 of 2 analyzed')).toBeTruthy();
  expect(screen.queryByText('Beta Paper')).toBeNull();

  buildState = {
    ...buildState,
    progress: progress({ alpha: 'done', beta: 'extracting' }),
  };
  await view.rerenderAsync(sheet());

  expect(screen.getByText('Alpha Paper')).toBeTruthy();
  expect(screen.getByText('Beta Paper')).toBeTruthy();
  expect(screen.getByText('Reading full text')).toBeTruthy();
});

test('keeps related cards visible during a build and refreshes them at graph revisions', async () => {
  relatedResult = { ...relatedResult, data: [RELATED] };
  graphResult = {
    ...graphResult,
    data: graphResponse({ ...STATUS, has_graph: true, graph_revision: 's1' }, RUNNING_JOB),
  };
  buildState = { ...buildState, building: true, progress: progress({ beta: 'extracting' }) };
  const view = await renderAsync(sheet());

  expect(screen.getByText('The Annotated Transformer')).toBeTruthy();
  expect(screen.getByText('Building related works…')).toBeTruthy();

  graphResult = {
    ...graphResult,
    data: graphResponse({ ...STATUS, has_graph: true, graph_revision: 's2' }, RUNNING_JOB),
  };
  await view.rerenderAsync(sheet());

  await waitFor(() => expect(relatedRefetch).toHaveBeenCalledTimes(1));
  expect(screen.getByText('The Annotated Transformer')).toBeTruthy();
});

test('a fresh built graph with no significant edge reports an honest empty result', async () => {
  graphResult = {
    ...graphResult,
    data: graphResponse({ ...STATUS, has_graph: true, graph_revision: 'fresh' }),
  };
  await renderAsync(sheet());

  expect(screen.getByText('No significant related works surfaced for this paper yet.')).toBeTruthy();
  expect(screen.queryByText('Build related works')).toBeNull();
  expect(screen.queryByText('Update related works')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

test('a map-status failure does not blank related cards that loaded successfully', async () => {
  relatedResult = { ...relatedResult, data: [RELATED] };
  graphResult = {
    data: undefined, isLoading: false, isError: true, refetch: graphRefetch,
  };
  await renderAsync(sheet());

  expect(screen.getByText('The Annotated Transformer')).toBeTruthy();
  expect(screen.getByText(/Could not check the map or its current build/)).toBeTruthy();
  expect(screen.queryByText('Build related works')).toBeNull();
});
