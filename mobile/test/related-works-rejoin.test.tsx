import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { GraphBuildJob, GraphResponse, GraphStatus, Paper } from '@/api/types';
import { RelatedWorksSheet } from '@/components/RelatedWorksSheet';

const PAPER: Paper = {
  slug: 'alpha', title: 'Alpha Paper', group: 'Reading', list_status: 'read', cites: [],
  retrieved: true, has_notes: true, session_state: 'committed', arxiv_id: '2601.00001',
};

const STATUS: GraphStatus = {
  has_graph: false,
  built_at: null,
  model: null,
  graph_revision: null,
  graph_stage: null,
  graph_completeness: null,
  graph_needs_enrichment: false,
  total_papers: 1,
  retrievable_papers: 1,
  stale_papers: [],
  removed_papers: [],
  missing_text_papers: [],
  semantic_scholar_enabled: true,
  semantic_scholar_papers: 0,
  semantic_scholar_stale_papers: ['alpha'],
  retrieval_candidates: {},
  retrieval_errors: {},
};

const EARLY_RUNNING_JOB: GraphBuildJob = {
  status: 'running',
  phase: 'metadata',
  total: 1,
  ready: 1,
  done: 0,
  current_slug: 'alpha',
  current_title: 'Alpha Paper',
  per_paper: { alpha: { status: 'metadata', error: null } },
  retrieval_candidates: {},
  // Deliberately before the first persisted skeleton: useGraphBuild cannot refresh the graph
  // query from this snapshot, so only the sheet's reopen read can discover it.
  graph_stage: null,
  graph_completeness: null,
  graph_revision: null,
  graph_updated_at: null,
  graph: null,
  recommendations: null,
  error: null,
  started_at: '2026-09-06T00:00:00Z',
  finished_at: null,
};

function response(build: GraphBuildJob | null): GraphResponse {
  return { graph: null, recommendations: [], status: STATUS, build };
}

test('closing and reopening inside query staleTime fetches and rejoins the early running job', async () => {
  await setBaseUrl('https://api.test');
  let serverBuild: GraphBuildJob | null = null;
  jest.mocked(api.getGraph).mockImplementation(async () => response(serverBuild));
  jest.mocked(api.getRelated).mockResolvedValue({ related: [] });
  jest.mocked(api.startGraphBuild).mockImplementation(async () => {
    serverBuild = EARLY_RUNNING_JOB;
    return { build: EARLY_RUNNING_JOB };
  });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: EARLY_RUNNING_JOB });

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const renderSheet = (visible: boolean) => (
    <QueryClientProvider client={client}>
      <RelatedWorksSheet
        pid="project-a"
        slug="alpha"
        papers={[PAPER]}
        visible={visible}
        onClose={() => {}}
        onOpenPaper={() => {}}
      />
    </QueryClientProvider>
  );

  const view = await renderAsync(renderSheet(true));
  await waitFor(() => expect(screen.getByText('Build related works')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Build related works'));
  await waitFor(() => expect(screen.getByText('Building related works…')).toBeTruthy());

  await view.rerenderAsync(renderSheet(false));
  expect(screen.queryByText('Building related works…')).toBeNull();
  const graphReadsBeforeReopen = jest.mocked(api.getGraph).mock.calls.length;

  await view.rerenderAsync(renderSheet(true));

  await waitFor(() => {
    expect(api.getGraph).toHaveBeenCalledTimes(graphReadsBeforeReopen + 1);
  });
  await waitFor(() => expect(screen.getByText('Building related works…')).toBeTruthy());
  expect(screen.getByText('Alpha Paper')).toBeTruthy();
  expect(screen.queryByText('Build related works')).toBeNull();

  await view.unmountAsync();
  client.clear();
});
