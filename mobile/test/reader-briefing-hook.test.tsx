import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import { createTestQueryClient } from './queryClient';
import { getActiveReaderJob, getReaderJob } from '@/api/endpoints';
import type { ReaderJob, TranscriptEntry } from '@/api/types';
import { useReaderBriefing } from '@/hooks/useReaderBriefing';

jest.mock('@/api/endpoints', () => ({
  cancelReaderJob: jest.fn(),
  getActiveReaderJob: jest.fn(),
  getReaderJob: jest.fn(),
  startReaderJob: jest.fn(),
}));

jest.mock('@/api/queries', () => ({
  keys: { session: (...parts: string[]) => ['session', ...parts] },
  useReaderCandidates: () => ({ data: { assistant_index: 0, candidates: [] } }),
}));

jest.mock('@/lib/readerOffer', () => ({
  dismissReaderOffer: jest.fn(),
  isReaderOfferDismissed: jest.fn(async () => false),
  readerOfferKeyFor: () => 'job:summary',
}));

jest.mock('@/components/SpendRefusalSheet', () => ({
  presentSpendJobRefusal: jest.fn(),
  presentSpendRefusal: jest.fn(() => false),
}));

const cancelledUnfinished: ReaderJob = {
  id: 'reader-cancelled',
  status: 'cancelled',
  error: null,
  refusal: null,
  slug: 'flint',
  thread_id: 'main',
  assistant_index: 0,
  targets: [{ slug: 'h3', title: 'H3', status: 'reading', error: null }],
  current: 'h3',
  delivery_mode: 'reading',
  briefs: [],
  waiting: false,
  stopped_reason: null,
  analysis_job_id: null,
  analysis_error: null,
  analysis_refusal: null,
  started_at: '2026-09-05T00:00:00+00:00',
  finished_at: null,
};

test('a remount reattaches to a cancelled pass whose paid worker is still unwinding', async () => {
  jest.useFakeTimers();
  (getActiveReaderJob as jest.Mock).mockResolvedValue({ job: cancelledUnfinished });
  (getReaderJob as jest.Mock).mockResolvedValue({
    job: { ...cancelledUnfinished, current: null, finished_at: '2026-09-05T00:00:02+00:00' },
  });
  const client = createTestQueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const transcript = [{
    role: 'assistant',
    assistant_index: 0,
    chat_job_id: 'summary',
  }] as TranscriptEntry[];

  const view = renderHook(() => useReaderBriefing({
    pid: 'p1',
    slug: 'flint',
    threadId: 'main',
    state: 'in_discussion',
    transcript,
    streaming: false,
    deliveryMode: 'reading',
    resumeTurn: jest.fn(async () => undefined),
  }), { wrapper });

  await waitFor(() => expect(view.result.current.job?.id).toBe('reader-cancelled'));
  expect(getActiveReaderJob).toHaveBeenCalledWith('p1', 'flint', 'main');
  expect(view.result.current.offer).toBeNull();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1500);
  });
  expect(getReaderJob).toHaveBeenCalledWith('p1', 'reader-cancelled');
  expect(view.result.current.job?.finished_at).not.toBeNull();
  view.unmount();
  jest.useRealTimers();
});
