import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import { createTestQueryClient } from './queryClient';
import {
  getActiveReaderJob,
  getReaderJob,
  getRetrievalJob,
  startRetrievalJob,
} from '@/api/endpoints';
import type { ReaderCandidate, ReaderJob, TranscriptEntry } from '@/api/types';
import { deferReaderOffer, isReaderOfferDeferred } from '@/lib/readerOffer';
import { useReaderBriefing } from '@/hooks/useReaderBriefing';

jest.mock('@/api/endpoints', () => ({
  cancelReaderJob: jest.fn(),
  getActiveReaderJob: jest.fn(),
  getReaderJob: jest.fn(),
  getRetrievalJob: jest.fn(),
  startReaderJob: jest.fn(),
  startRetrievalJob: jest.fn(),
}));

let mockCandidates: ReaderCandidate[] = [];
jest.mock('@/api/queries', () => ({
  keys: { session: (...parts: string[]) => ['session', ...parts] },
  useReaderCandidates: () => ({ data: { assistant_index: 0, candidates: mockCandidates } }),
}));

jest.mock('@/lib/readerOffer', () => ({
  deferReaderOffer: jest.fn(),
  isReaderOfferDeferred: jest.fn(async () => false),
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

test('a setup-only route does not look up a reader job with placeholder ids', async () => {
  const client = createTestQueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  const view = renderHook(() => useReaderBriefing({
    pid: '',
    slug: '',
    threadId: 'main',
    enabled: false,
    state: null,
    transcript: [],
    streaming: false,
    deliveryMode: 'reading',
    resumeTurn: jest.fn(async () => undefined),
  }), { wrapper });

  await act(async () => undefined);
  expect(getActiveReaderJob).not.toHaveBeenCalled();
  expect(view.result.current.job).toBeNull();
  expect(view.result.current.offer).toBeNull();
});


// ---------------------------------------------------------------- DR-145: window and fetching

const TRANSCRIPT = [{
  role: 'assistant',
  assistant_index: 0,
  chat_job_id: 'summary',
}] as TranscriptEntry[];

function mountOffer(client = createTestQueryClient()) {
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useReaderBriefing({
    pid: 'p1',
    slug: 'flint',
    threadId: 'main',
    state: 'in_discussion',
    transcript: TRANSCRIPT,
    streaming: false,
    deliveryMode: 'reading',
    resumeTurn: jest.fn(async () => undefined),
  }), { wrapper });
}

describe('the offer window (DR-145)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getActiveReaderJob as jest.Mock).mockResolvedValue({ job: null });
    (isReaderOfferDeferred as jest.Mock).mockResolvedValue(false);
    mockCandidates = [{ slug: 'h3', title: 'H3', year: 2025, has_text: true }];
  });

  test('presents itself once and records that it has, so re-entry only leaves the indicator', async () => {
    const first = mountOffer();
    await waitFor(() => expect(first.result.current.offerOpen).toBe(true));
    expect(deferReaderOffer).toHaveBeenCalledWith('p1', 'flint', 'main', 'job:summary');
    act(() => first.result.current.closeOffer());
    // Closing is never an answer: the offer survives so the indicator can reopen it.
    expect(first.result.current.offerOpen).toBe(false);
    expect(first.result.current.offer?.candidates).toHaveLength(1);
    act(() => first.result.current.openOffer());
    expect(first.result.current.offerOpen).toBe(true);
    first.unmount();

    (isReaderOfferDeferred as jest.Mock).mockResolvedValue(true);
    const second = mountOffer();
    await waitFor(() => expect(second.result.current.offer).not.toBeNull());
    expect(second.result.current.offerOpen).toBe(false);
    second.unmount();
  });

  test('a response whose only cited papers are unfetched still earns an offer', async () => {
    mockCandidates = [{ slug: 'ghost', title: 'Ghost', year: null, has_text: false }];
    (startRetrievalJob as jest.Mock).mockResolvedValue({
      job: { id: 'ret-1', status: 'running', retrieved: false, phase: 'hunting', error: null },
    });
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.offer?.candidates).toHaveLength(1));
    view.unmount();
  });
});

describe('fetching a candidate\'s text (DR-145)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getActiveReaderJob as jest.Mock).mockResolvedValue({ job: null });
    (isReaderOfferDeferred as jest.Mock).mockResolvedValue(false);
    mockCandidates = [
      { slug: 'h3', title: 'H3', year: 2025, has_text: true },
      { slug: 'ghost', title: 'Ghost', year: null, has_text: false },
    ];
  });

  test('the app tries on its own, once per paper, and re-reads the candidates when it lands', async () => {
    jest.useFakeTimers();
    (startRetrievalJob as jest.Mock).mockResolvedValue({
      job: { id: 'ret-1', status: 'running', retrieved: false, phase: 'hunting', error: null },
    });
    (getRetrievalJob as jest.Mock).mockResolvedValue({
      job: { id: 'ret-1', status: 'done', retrieved: true, phase: 'done', error: null },
    });
    const client = createTestQueryClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const view = mountOffer(client);

    await waitFor(() => expect(startRetrievalJob).toHaveBeenCalled());
    // The paper that already has text is never fetched, and no summary turn is asked for.
    expect(startRetrievalJob).toHaveBeenCalledTimes(1);
    expect(startRetrievalJob).toHaveBeenCalledWith('p1', 'ghost', {});
    expect(view.result.current.fetching.ghost).toEqual({ status: 'running' });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(view.result.current.fetching.ghost).toBeUndefined());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['session', 'p1', 'flint', 'main', 'reader-candidates'],
    });

    // Re-rendering the offer must not re-fetch a paper already attempted.
    view.rerender(undefined as never);
    await act(async () => undefined);
    expect(startRetrievalJob).toHaveBeenCalledTimes(1);
    view.unmount();
    jest.useRealTimers();
  });

  test('a fetch that fails leaves a retryable row rather than an error over the discussion', async () => {
    jest.useFakeTimers();
    (startRetrievalJob as jest.Mock).mockResolvedValue({
      job: { id: 'ret-2', status: 'running', retrieved: false, phase: 'hunting', error: null },
    });
    (getRetrievalJob as jest.Mock).mockResolvedValue({
      job: {
        id: 'ret-2', status: 'error', retrieved: false, phase: 'hunting',
        error: 'No PDF could be found.',
      },
    });
    const view = mountOffer();
    await waitFor(() => expect(startRetrievalJob).toHaveBeenCalledTimes(1));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(view.result.current.fetching.ghost).toEqual({
      status: 'error', error: 'No PDF could be found.',
    }));
    expect(view.result.current.error).toBeNull();

    // Asking again is the reader's call, and it does start a second attempt.
    await act(async () => {
      void view.result.current.fetchCandidate('ghost');
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(startRetrievalJob).toHaveBeenCalledTimes(2);
    view.unmount();
    jest.useRealTimers();
  });

  test('a retrieval that needs a source chosen says so instead of reporting a failure', async () => {
    jest.useFakeTimers();
    (startRetrievalJob as jest.Mock).mockResolvedValue({
      job: {
        id: 'ret-3', status: 'done', retrieved: false, phase: 'confirmation', error: null,
      },
    });
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.fetching.ghost).toEqual({ status: 'needs_choice' }));
    expect(getRetrievalJob).not.toHaveBeenCalled();
    view.unmount();
    jest.useRealTimers();
  });
});
