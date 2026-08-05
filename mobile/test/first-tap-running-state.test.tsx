// D17/D18 — the first tap on Build Graph (and Discover Search) must keep the running view.
// The hooks set their running flag optimistically, which starts the status poll immediately;
// that first poll can land BEFORE the start POST registers the job server-side, and the
// "no job" (or previous settled job) snapshot must not flip the running view back off.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHookAsync } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import * as api from '@/api/endpoints';
import type { DiscoveryJob, GraphBuildJob } from '@/api/types';
import { useDiscoveryRun } from '@/hooks/useDiscoveryRun';
import { useGraphBuild } from '@/hooks/useGraphBuild';
import { createTestQueryClient } from './queryClient';

const qc = createTestQueryClient();
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
  jest.mocked(api.cancelDiscovery).mockReset();
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

test('a poll that began before the start settled cannot apply its stale read afterwards', async () => {
  // The GET can READ the server before the job registers but RESOLVE after the POST does —
  // dropping must key off when the poll began, not just when it resolved.
  let resolveStart: (value: { build: GraphBuildJob }) => void = () => undefined;
  jest.mocked(api.startGraphBuild).mockReturnValue(
    new Promise((resolve) => {
      resolveStart = resolve;
    }),
  );
  let resolvePoll: (value: { build: GraphBuildJob | null }) => void = () => undefined;
  jest.mocked(api.getGraphBuildStatus).mockReturnValue(
    new Promise((resolve) => {
      resolvePoll = resolve;
    }) as never,
  );

  const hook = await renderHookAsync(() => useGraphBuild('proj'), { wrapper });
  act(() => {
    void hook.result.current.run();
  });
  await act(async () => Promise.resolve()); // the immediate poll is now in flight
  await act(async () => {
    resolveStart({ build: runningBuild }); // POST settles first…
  });
  await act(async () => {
    resolvePoll({ build: null }); // …then the poll's pre-registration read arrives
  });
  expect(hook.result.current.building).toBe(true);
  await hook.unmountAsync();
});

test('a lost start response reconciles against a running job instead of failing', async () => {
  jest.mocked(api.startGraphBuild).mockRejectedValue(new Error('tunnel timeout'));
  jest.mocked(api.getGraphBuildStatus).mockResolvedValue({ build: runningBuild } as never);

  const hook = await renderHookAsync(() => useGraphBuild('proj'), { wrapper });
  await act(async () => hook.result.current.run());
  expect(hook.result.current.building).toBe(true); // recovered the real backend build
  expect(hook.result.current.error).toBeNull();
  await hook.unmountAsync();
});

test('a project switch mid-start resets discovery and discards the old response', async () => {
  let resolveStart: (value: { job: DiscoveryJob }) => void = () => undefined;
  jest
    .mocked(api.startDiscovery)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    )
    .mockResolvedValueOnce({ job: { status: 'running' } as DiscoveryJob } as never);
  jest.mocked(api.getDiscovery).mockResolvedValue({ job: null } as never);

  const hook = await renderHookAsync(
    ({ pid }: { pid: string }) => useDiscoveryRun(pid),
    { initialProps: { pid: 'proj-a' }, wrapper },
  );
  act(() => {
    void hook.result.current.run('goals for project a');
  });
  expect(hook.result.current.running).toBe(true);

  await act(async () => hook.rerenderAsync({ pid: 'proj-b' }));
  expect(hook.result.current.running).toBe(false); // switching resets the optimistic state

  await act(async () => {
    resolveStart({ job: { status: 'running' } as DiscoveryJob }); // A's late response
  });
  expect(hook.result.current.running).toBe(false); // …must not populate B's UI

  // And B's own first tap is not blocked by A's aborted start. Once B's start settles, the
  // server genuinely knows the job, so the status poll reports it running.
  jest
    .mocked(api.getDiscovery)
    .mockResolvedValue({ job: { status: 'running' } as DiscoveryJob } as never);
  let accepted = false;
  await act(async () => {
    accepted = await hook.result.current.run('goals for project b');
  });
  expect(hook.result.current.error).toBeNull();
  expect(accepted).toBe(true);
  expect(hook.result.current.running).toBe(true);
  await hook.unmountAsync();
});

test('discover Stop ignores a stale running poll that resolves after cancellation', async () => {
  const running = { status: 'running', phase: 'gated', finds: [] } as unknown as DiscoveryJob;
  const cancelled = { ...running, status: 'cancelled' } as DiscoveryJob;
  jest.mocked(api.startDiscovery).mockResolvedValue({ job: running });
  let resolvePoll: (value: { job: DiscoveryJob | null }) => void = () => undefined;
  jest.mocked(api.getDiscovery).mockReturnValue(
    new Promise((resolve) => {
      resolvePoll = resolve;
    }) as never,
  );
  jest.mocked(api.cancelDiscovery).mockResolvedValue({ job: cancelled });

  const hook = await renderHookAsync(() => useDiscoveryRun('proj'), { wrapper });
  await act(async () => hook.result.current.run('memory systems'));
  expect(hook.result.current.job?.status).toBe('running');
  await act(async () => Promise.resolve()); // immediate poll is now in flight

  let stopped = false;
  await act(async () => {
    stopped = await hook.result.current.cancel();
  });
  expect(stopped).toBe(true);
  expect(hook.result.current.running).toBe(false);
  expect(hook.result.current.job?.status).toBe('cancelled');

  await act(async () => {
    resolvePoll({ job: running });
  });
  expect(hook.result.current.running).toBe(false);
  expect(hook.result.current.job?.status).toBe('cancelled');
  await hook.unmountAsync();
});

test('a lost Stop response reconciles against the cancelled backend job', async () => {
  const running = { status: 'running', phase: 'gated', finds: [] } as unknown as DiscoveryJob;
  const cancelled = { ...running, status: 'cancelled' } as DiscoveryJob;
  jest.mocked(api.startDiscovery).mockResolvedValue({ job: running });
  jest.mocked(api.cancelDiscovery).mockRejectedValue(new Error('tunnel timeout'));
  // The first call is the immediate status poll. The second is Stop's reconciliation read.
  jest.mocked(api.getDiscovery)
    .mockResolvedValueOnce({ job: running } as never)
    .mockResolvedValueOnce({ job: cancelled } as never);

  const hook = await renderHookAsync(() => useDiscoveryRun('proj'), { wrapper });
  await act(async () => hook.result.current.run('memory systems'));
  await act(async () => Promise.resolve());

  let stopped = false;
  await act(async () => {
    stopped = await hook.result.current.cancel();
  });
  expect(stopped).toBe(true);
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.running).toBe(false);
  expect(hook.result.current.job?.status).toBe('cancelled');
  await hook.unmountAsync();
});

test('reopening Discover restores a cancelled snapshot without restarting polling', async () => {
  const cancelled = {
    status: 'cancelled', phase: 'gated', finds: [{ title: 'Partial' }],
  } as unknown as DiscoveryJob;
  const hook = await renderHookAsync(() => useDiscoveryRun('proj'), { wrapper });
  act(() => hook.result.current.resume(cancelled));
  expect(hook.result.current.running).toBe(false);
  expect(hook.result.current.job).toBe(cancelled);
  expect(api.getDiscovery).not.toHaveBeenCalled();
  await hook.unmountAsync();
});
