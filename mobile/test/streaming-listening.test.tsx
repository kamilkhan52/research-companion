import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHookAsync } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import { apiPost } from '@/api/client';
import * as api from '@/api/endpoints';
import type { ChatJob } from '@/api/types';
import { useStreamingTurn } from '@/hooks/useStreamingTurn';

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  await unmountAsync();
  client.clear();
});
