// D17/D18 — the first tap on Build Graph (and Discover Search) must keep the running view.
// The hooks set their running flag optimistically, which starts the status poll immediately;
// that first poll can land BEFORE the start POST registers the job server-side, and the
// "no job" (or previous settled job) snapshot must not flip the running view back off.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHookAsync } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import * as api from '@/api/endpoints';
import type { DiscoveryJob, GraphBuildJob } from '@/api/types';
import { useDiscoveryRun } from '@/hooks/useDiscoveryRun';
import { useGraphBuild } from '@/hooks/useGraphBuild';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

const runningBuild = {
  status: 'running',
  phase: 'preparing',
  per_paper: {},
  total: 0,
  ready: 0,
  done: 0,
  current_title: null,
  retrieval_candidates: {},
  graph_revision: null,
  graph_stage: null,
  graph: null,
} as unknown as GraphBuildJob;

const settledBuild = { ...runningBuild, status: 'done' } as unknown as GraphBuildJob;

afterEach(() => {
  jest.mocked(api.startGraphBuild).mockReset();
  jest.mocked(api.getGraphBuildStatus).mockReset();
  jest.mocked(api.startDiscovery).mockReset();
  jest.mocked(api.getDiscovery).mockReset();
});

test('graph build first tap survives an early "no job" poll', async () => {
  let resolveStart: (value: { build: GraphBuildJob }) => void = () => undefined;
  jest.mocked(api.startGraphBuild).mockReturnValue(
    new Promise((resolve) => {
      resolveStart = resolve;
    }),
  );
  // The server does not know the job yet — the pre-fix behavior applied this and reverted.
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: null } as never);

  const hook = await renderHookAsync(() => useGraphBuild('proj'), { wrapper });
  act(() => {
    void hook.result.current.run();
  });
  expect(hook.result.current.building).toBe(true);

  await act(async () => Promise.resolve()); // flush the immediate poll tick
  expect(hook.result.current.building).toBe(true); // the early null must be ignored

  await act(async () => {
    resolveStart({ build: runningBuild });
  });
  expect(hook.result.current.building).toBe(true);
  await hook.unmountAsync();
});

test('graph build first tap ignores the previous settled job in the registry', async () => {
  let resolveStart: (value: { build: GraphBuildJob }) => void = () => undefined;
  jest.mocked(api.startGraphBuild).mockReturnValue(
    new Promise((resolve) => {
      resolveStart = resolve;
    }),
  );
  // The status endpoint still reports the PREVIOUS finished build while the POST is in flight.
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: settledBuild } as never);

  const hook = await renderHookAsync(() => useGraphBuild('proj'), { wrapper });
  act(() => {
    void hook.result.current.run();
  });
  await act(async () => Promise.resolve());
  expect(hook.result.current.building).toBe(true); // stale settled job must not revert the view

  await act(async () => {
    resolveStart({ build: runningBuild });
  });
  expect(hook.result.current.building).toBe(true);
  await hook.unmountAsync();
});

test('discover search first tap survives an early "no job" poll', async () => {
  let resolveStart: (value: { job: DiscoveryJob }) => void = () => undefined;
  jest.mocked(api.startDiscovery).mockReturnValue(
    new Promise((resolve) => {
      resolveStart = resolve;
    }),
  );
  jest.mocked(api.getDiscovery).mockResolvedValue({ job: null } as never);

  const hook = await renderHookAsync(() => useDiscoveryRun('proj'), { wrapper });
  act(() => {
    void hook.result.current.run('memory systems for LLM serving');
  });
  expect(hook.result.current.running).toBe(true);

  await act(async () => Promise.resolve());
  expect(hook.result.current.running).toBe(true);

  await act(async () => {
    resolveStart({ job: { status: 'running' } as DiscoveryJob });
  });
  expect(hook.result.current.running).toBe(true);
  await hook.unmountAsync();
});
