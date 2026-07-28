import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHookAsync } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import { apiPost } from '@/api/client';
import * as api from '@/api/endpoints';
import type { ChatJob } from '@/api/types';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';
import { createTestQueryClient } from './queryClient';

jest.mock('@/api/client', () => ({
  apiPost: jest.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super('API error');
      this.status = status;
    }
  },
}));

const baseJob: ChatJob = {
  id: 'chat-job',
  slug: 'paper',
  status: 'running',
  items: [],
  turn: null,
  state: null,
  error: null,
  started_at: '2026-07-06T00:00:00Z',
  finished_at: null,
  delivery_mode: 'listening',
  audio_job_id: null,
  audio_error: null,
  assistant_index: null,
  preview_job_ids: [],
  preview_coordinator_id: null,
  preview_complete: false,
  preview_phase: 'analysis',
  preview_progress: { phase: 'analysis', remaining_known: false },
  timings: {},
  cancelled: false,
};

test('listening turns send delivery mode and hand the completed audio job to the queue', async () => {
  const done: ChatJob = {
    ...baseJob,
    status: 'done',
    turn: {
      role: 'assistant',
      canonical: 'Answer.',
      narration: '',
      state_signal: 'in_discussion',
      proposed_commit: null,
      ts: '2026-07-06T00:00:01Z',
    },
    state: 'in_discussion',
    audio_job_id: 'audio-job',
    assistant_index: 0,
    finished_at: '2026-07-06T00:00:01Z',
  };
  jest.mocked(apiPost).mockResolvedValueOnce({ job: baseJob });
  jest.mocked(api.getChatJob).mockResolvedValueOnce({ job: done });
  const onDone = jest.fn();
  const client = createTestQueryClient();
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(
    () => useStreamingTurn('project', 'paper', 'listening', onDone),
    { wrapper: Wrapper },
  );
  await act(async () => {
    await result.current.run('/turn', { slug: 'paper', text: 'Question' });
  });

  expect(apiPost).toHaveBeenCalledWith('/turn', {
    slug: 'paper',
    text: 'Question',
    delivery_mode: 'listening',
  });
  expect(onDone).toHaveBeenCalledWith(done);
  expect(result.current.previewParentJobId).toBe('chat-job');
  await unmountAsync();
  client.clear();
});

test('failed parent invalidates preview polling before exposing the terminal state', async () => {
  const failed: ChatJob = {
    ...baseJob,
    status: 'error',
    error: 'analysis failed',
    preview_job_ids: ['cue-job'],
    preview_complete: true,
    preview_phase: 'complete',
    finished_at: '2026-07-06T00:00:01Z',
  };
  jest.mocked(apiPost).mockResolvedValueOnce({ job: baseJob });
  jest.mocked(api.getChatJob).mockResolvedValueOnce({ job: failed });
  const client = createTestQueryClient();
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(
    () => useStreamingTurn('project', 'paper', 'listening'),
    { wrapper: Wrapper },
  );
  await act(async () => {
    await result.current.run('/turn', { slug: 'paper', text: 'Question' });
  });

  expect(result.current.previewParentJobId).toBeNull();
  expect(result.current.previewJobIds).toEqual([]);
  expect(result.current.error).toBe('analysis failed');
  await unmountAsync();
  client.clear();
});

test('reports server acceptance before watching the background job', async () => {
  const done: ChatJob = {
    ...baseJob,
    status: 'done',
    finished_at: '2026-07-06T00:00:01Z',
  };
  jest.mocked(apiPost).mockResolvedValueOnce({ job: baseJob });
  jest.mocked(api.getChatJob).mockResolvedValueOnce({ job: done });
  const onAccepted = jest.fn();
  const client = createTestQueryClient();
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result, unmountAsync } = await renderHookAsync(
    () => useStreamingTurn('project', 'paper'),
    { wrapper: Wrapper },
  );

  await act(async () => {
    await result.current.run('/turn', { slug: 'paper', text: 'Question' }, 'Question', onAccepted);
  });

  expect(onAccepted).toHaveBeenCalledTimes(1);
  expect(onAccepted.mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(api.getChatJob).mock.invocationCallOrder[0],
  );
  await unmountAsync();
  client.clear();
});

test('refetches accepted state when the start response is lost', async () => {
  jest.mocked(apiPost).mockRejectedValueOnce(new Error('connection reset'));
  const client = createTestQueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result, unmountAsync } = await renderHookAsync(
    () => useStreamingTurn('project', 'paper'),
    { wrapper: Wrapper },
  );

  await act(async () => {
    await result.current.run('/turn', { slug: 'paper', text: 'Question' });
  });

  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', 'project', 'session', 'paper'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', 'project', 'opening', 'paper'] });
  expect(result.current.error).toBe('connection reset');
  await unmountAsync();
  client.clear();
});

test('an independent thread qualifies the turn body and cache without changing main', async () => {
  const sideJob: ChatJob = {
    ...baseJob,
    thread_id: 'side-thread',
    delivery_mode: 'reading',
  };
  const done: ChatJob = {
    ...sideJob,
    status: 'done',
    finished_at: '2026-07-06T00:00:01Z',
  };
  jest.mocked(apiPost).mockResolvedValueOnce({ job: sideJob });
  jest.mocked(api.getChatJob).mockResolvedValueOnce({ job: done });
  const client = createTestQueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result, unmountAsync } = await renderHookAsync(
    () => useStreamingTurn('project', 'paper', 'reading', undefined, 'side-thread'),
    { wrapper: Wrapper },
  );

  await act(async () => {
    await result.current.run('/turn', { slug: 'paper', text: 'Challenge the premise' });
  });

  expect(apiPost).toHaveBeenCalledWith('/turn', {
    slug: 'paper',
    text: 'Challenge the premise',
    delivery_mode: 'reading',
    thread_id: 'side-thread',
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['project', 'project', 'session', 'paper', 'side-thread'],
  });
  await unmountAsync();
  client.clear();
});

// R12.2 follow-up (sol P1): a resume() started for one thread must never attach its job to
// a different thread — the last-opened-thread restore switches the conversation right after
// mount, while the main-thread active-job lookup can still be in flight.
test('a thread switch mid-resume never attaches the old thread’s job', async () => {
  const qc = createTestQueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  let resolveLookup: (value: { job: ChatJob | null }) => void = () => undefined;
  jest.mocked(api.getActiveChatJob).mockReturnValue(
    new Promise((resolve) => {
      resolveLookup = resolve;
    }),
  );
  const poll = jest.mocked(api.getChatJob);
  poll.mockClear();

  const hook = await renderHookAsync(
    ({ threadId }: { threadId: string }) =>
      useStreamingTurn('proj', 'paper', 'reading', undefined, threadId),
    { initialProps: { threadId: 'main' }, wrapper },
  );
  act(() => {
    void hook.result.current.resume();
  });

  // The last-opened-thread restore lands while the main lookup is still in flight.
  await act(async () => hook.rerenderAsync({ threadId: 'thread-b' }));
  // Now main's lookup resolves with an active job — it belongs to the old conversation.
  await act(async () => {
    resolveLookup({ job: baseJob });
  });

  expect(hook.result.current.streaming).toBe(false); // must not adopt main's job
  expect(poll).not.toHaveBeenCalled(); // and must not start polling it
  await hook.unmountAsync();
});
