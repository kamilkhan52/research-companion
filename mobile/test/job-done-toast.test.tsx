// R6.5 — a finished graph build announces itself with a quiet toast: builds take minutes and
// tab screens stay mounted, so the poll loop usually settles while the user is elsewhere in
// the app. Errors keep the existing error banner and never toast.

import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from './queryClient';
import { act, renderHookAsync, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import * as api from '@/api/endpoints';
import type { GraphBuildJob } from '@/api/types';
import { useGraphBuild } from '@/hooks/useGraphBuild';
import { showToast } from '@/ui/Toast';

jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));

const baseJob: GraphBuildJob = {
  status: 'running',
  phase: 'extraction',
  total: 1,
  ready: 1,
  done: 0,
  current_slug: 'p',
  current_title: 'Paper P',
  per_paper: { p: { status: 'extracting', error: null } },
  retrieval_candidates: {},
  graph_stage: null,
  graph_completeness: null,
  graph_revision: null,
  graph_updated_at: null,
  graph: null,
  recommendations: null,
  error: null,
  started_at: '2026-07-16T00:00:00Z',
  finished_at: null,
};

function harness() {
  const client = createTestQueryClient();
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

afterEach(() => {
  jest.mocked(showToast).mockClear();
});

test('a build that settles as done fires the ready toast once', async () => {
  jest.mocked(api.startGraphBuild).mockResolvedValueOnce({ build: baseJob });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({
    build: { ...baseJob, status: 'done', finished_at: '2026-07-16T00:05:00Z' },
  });
  const { client, Wrapper } = harness();

  const { result, unmountAsync } = await renderHookAsync(
    () => useGraphBuild('project-a'),
    { wrapper: Wrapper },
  );
  await act(async () => { await result.current.run(); });

  await waitFor(() => expect(result.current.building).toBe(false));
  expect(showToast).toHaveBeenCalledTimes(1);
  expect(showToast).toHaveBeenCalledWith('Reference map ready');

  await unmountAsync();
  client.clear();
});

// DR-069 — the codex-designed control-rail toast ("Map updated · N papers") needs a real count
// to be a signal rather than a chime; falls back to the old copy when a settled job carries no
// graph (shouldn't happen on a real 'done' job, but the toast must not crash or say "· undefined").
//
// Opus review: `total_papers` (the reading-list count) and `nodes.length` (that PLUS every
// external work the graph cites) are genuinely different numbers on a real project — the fixture
// below deliberately keeps them apart (3 vs 12) so a regression back to `total_papers` fails
// this test instead of passing by coincidence.
test('a build that settles as done with a graph reports the node count, matching the header', async () => {
  jest.mocked(api.startGraphBuild).mockResolvedValueOnce({ build: baseJob });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({
    build: {
      ...baseJob,
      status: 'done',
      finished_at: '2026-07-16T00:05:00Z',
      graph: {
        built_at: '2026-07-16T00:05:00Z',
        revision: 'r1',
        model: 'm',
        stage: 'enriched',
        completeness: {
          total_papers: 3, metadata_papers: 3, ready_papers: 3,
          analyzed_papers: 3, metadata_only_edges: 0,
        },
        nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })),
        edges: [],
      },
    } as never,
  });
  const { client, Wrapper } = harness();

  const { result, unmountAsync } = await renderHookAsync(
    () => useGraphBuild('project-a'),
    { wrapper: Wrapper },
  );
  await act(async () => { await result.current.run(); });

  await waitFor(() => expect(result.current.building).toBe(false));
  expect(showToast).toHaveBeenCalledWith('Map updated · 12 papers');

  await unmountAsync();
  client.clear();
});

test('a build that settles as error keeps the banner and never toasts', async () => {
  jest.mocked(api.startGraphBuild).mockResolvedValueOnce({ build: baseJob });
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({
    build: { ...baseJob, status: 'error', error: 'boom', finished_at: '2026-07-16T00:05:00Z' },
  });
  const { client, Wrapper } = harness();

  const { result, unmountAsync } = await renderHookAsync(
    () => useGraphBuild('project-a'),
    { wrapper: Wrapper },
  );
  await act(async () => { await result.current.run(); });

  await waitFor(() => expect(result.current.error).toBe('boom'));
  expect(showToast).not.toHaveBeenCalled();

  await unmountAsync();
  client.clear();
});
