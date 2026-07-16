// R6.5 — a finished graph build announces itself with a quiet toast: builds take minutes and
// tab screens stay mounted, so the poll loop usually settles while the user is elsewhere in
// the app. Errors keep the existing error banner and never toast.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
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
