import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHookAsync, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import * as api from '@/api/endpoints';
import { keys } from '@/api/queries';
import type { GraphBuildJob, GraphResponse, ReferenceGraph } from '@/api/types';
import { useGraphBuild } from '@/hooks/useGraphBuild';

const skeleton: ReferenceGraph = {
  built_at: '2026-07-14T00:00:00Z',
  revision: 'skeleton-revision',
  model: 'test-model',
  stage: 'skeleton',
  completeness: {
    total_papers: 2,
    metadata_papers: 2,
    ready_papers: 1,
    analyzed_papers: 0,
    metadata_only_edges: 1,
    full_text_edges: 0,
  },
  nodes: [],
  edges: [],
};

const runningJob: GraphBuildJob = {
  status: 'running',
  phase: 'retrieval',
  total: 2,
  ready: 1,
  done: 0,
  current_slug: 'missing',
  current_title: 'Missing Paper',
  per_paper: { missing: { status: 'retrieving', error: null } },
  retrieval_candidates: {},
  graph_stage: 'skeleton',
  graph_completeness: skeleton.completeness,
  graph_revision: skeleton.revision,
  graph_updated_at: skeleton.built_at,
  graph: null,
  recommendations: null,
  error: null,
  started_at: '2026-07-14T00:00:00Z',
  finished_at: null,
};

function responseFor(graph: ReferenceGraph, build: GraphBuildJob): GraphResponse {
  return {
    graph,
    recommendations: [],
    status: {
      has_graph: true,
      built_at: graph.built_at,
      model: graph.model,
      graph_revision: graph.revision,
      graph_stage: graph.stage,
      graph_completeness: graph.completeness,
      graph_needs_enrichment: graph.stage === 'skeleton',
      total_papers: 2,
      retrievable_papers: graph.completeness.ready_papers,
      stale_papers: graph.stage === 'skeleton' ? ['missing'] : [],
      removed_papers: [],
      missing_text_papers: graph.stage === 'skeleton' ? ['missing'] : [],
      semantic_scholar_enabled: true,
      semantic_scholar_papers: 2,
      semantic_scholar_stale_papers: [],
      retrieval_candidates: {},
      retrieval_errors: {},
    },
    build,
  };
}

test('a pending start from the previous project cannot swallow the new project first tap', async () => {
  let resolveProjectA!: (value: { build: GraphBuildJob }) => void;
  const projectBJob: GraphBuildJob = {
    ...runningJob,
    current_slug: 'project-b-paper',
    current_title: 'Project B Paper',
  };
  jest.mocked(api.startGraphBuild).mockImplementation((pid) => {
    if (pid === 'project-a') {
      return new Promise((resolve) => {
        resolveProjectA = resolve;
      });
    }
    return Promise.resolve({ build: projectBJob });
  });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: projectBJob });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const rendered = await renderHookAsync(
    ({ pid }: { pid: string }) => useGraphBuild(pid),
    { wrapper: Wrapper, initialProps: { pid: 'project-a' } },
  );
  let projectAStart!: Promise<void>;
  act(() => {
    projectAStart = rendered.result.current.run();
  });
  expect(rendered.result.current.building).toBe(true);

  await rendered.rerenderAsync({ pid: 'project-b' });
  expect(rendered.result.current.building).toBe(false);

  await act(async () => rendered.result.current.run());
  expect(api.startGraphBuild).toHaveBeenCalledWith('project-b', false, {});
  expect(rendered.result.current.progress?.currentTitle).toBe('Project B Paper');

  await act(async () => {
    resolveProjectA({ build: runningJob });
    await projectAStart;
  });
  expect(rendered.result.current.progress?.currentTitle).toBe('Project B Paper');

  await rendered.unmountAsync();
  client.clear();
});

test('run(true) forwards force to startGraphBuild (rebuild from scratch)', async () => {
  jest.mocked(api.startGraphBuild).mockResolvedValueOnce({ build: runningJob });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: runningJob });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(
    () => useGraphBuild('project-a'),
    { wrapper: Wrapper },
  );
  await act(async () => { await result.current.run(true); });

  expect(api.startGraphBuild).toHaveBeenCalledWith('project-a', true, {});

  await unmountAsync();
  client.clear();
});

test('promotes a running skeleton into the graph query cache', async () => {
  jest.mocked(api.startGraphBuild).mockResolvedValueOnce({ build: runningJob });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: runningJob });
  jest.mocked(api.getGraph).mockResolvedValueOnce(responseFor(skeleton, runningJob));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(
    () => useGraphBuild('project-a'),
    { wrapper: Wrapper },
  );
  await act(async () => { await result.current.run(); });

  await waitFor(() => {
    const cached = client.getQueryData<GraphResponse>(keys.graph('project-a'));
    expect(cached?.graph?.stage).toBe('skeleton');
    expect(cached?.status.graph_completeness?.metadata_only_edges).toBe(1);
  });
  expect(result.current.building).toBe(true);
  expect(result.current.progress?.phase).toBe('retrieval');
  expect(result.current.progress?.graphStage).toBe('skeleton');
  expect(api.getGraph).toHaveBeenCalledTimes(1);

  await unmountAsync();
  client.clear();
});

test('a late skeleton response cannot overwrite the enriched graph', async () => {
  const enriched: ReferenceGraph = {
    ...skeleton,
    // Same second as the skeleton: revision, not wall-clock time, must distinguish them.
    built_at: skeleton.built_at,
    revision: 'enriched-revision',
    stage: 'enriched',
    completeness: {
      ...skeleton.completeness,
      ready_papers: 2,
      analyzed_papers: 2,
      metadata_only_edges: 0,
      full_text_edges: 1,
    },
  };
  const finishedJob: GraphBuildJob = {
    ...runningJob,
    status: 'done',
    phase: 'complete',
    ready: 2,
    done: 2,
    current_slug: null,
    current_title: null,
    graph_stage: 'enriched',
    graph_completeness: enriched.completeness,
    graph_revision: enriched.revision,
    graph_updated_at: enriched.built_at,
    graph: enriched,
    recommendations: [],
    finished_at: enriched.built_at,
  };
  let resolveSkeleton!: (response: GraphResponse) => void;
  const lateSkeleton = new Promise<GraphResponse>((resolve) => {
    resolveSkeleton = resolve;
  });
  jest.mocked(api.startGraphBuild).mockResolvedValueOnce({ build: runningJob });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValueOnce({ build: finishedJob });
  jest.mocked(api.getGraph).mockReturnValueOnce(lateSkeleton);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(
    () => useGraphBuild('project-a'),
    { wrapper: Wrapper },
  );
  await act(async () => { await result.current.run(); });
  await waitFor(() => {
    expect(client.getQueryData<GraphResponse>(keys.graph('project-a'))?.graph?.stage)
      .toBe('enriched');
  });

  await act(async () => { resolveSkeleton(responseFor(skeleton, runningJob)); });
  expect(client.getQueryData<GraphResponse>(keys.graph('project-a'))?.graph?.stage)
    .toBe('enriched');

  await unmountAsync();
  client.clear();
});
