import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import { createTestQueryClient } from './queryClient';
import {
  getActiveReaderJob,
  getReaderJob,
  getRetrievalJob,
  startReaderJob,
  startRetrievalJob,
} from '@/api/endpoints';
import type { ReaderCandidate, ReaderJob, TranscriptEntry } from '@/api/types';
import {
  deferReaderOffer,
  isReaderOfferDeferred,
  markReaderAutoFetchAttempted,
  readerAutoFetchAttempted,
} from '@/lib/readerOffer';
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
//: What the server says a pass may read. `undefined` on purpose by default, so every existing
//: test still exercises the fallback a pre-DR-155 server (or a cached payload) leaves behind.
let mockMaxTargets: number | undefined;
jest.mock('@/api/queries', () => ({
  keys: { session: (...parts: string[]) => ['session', ...parts] },
  useReaderCandidates: () => ({
    data: { assistant_index: 0, candidates: mockCandidates, max_targets: mockMaxTargets },
  }),
}));

jest.mock('@/lib/readerOffer', () => ({
  deferReaderOffer: jest.fn(),
  isReaderOfferDeferred: jest.fn(async () => false),
  // The durable auto-fetch memory (Opus review of #503). Default: nothing tried yet, so the
  // existing auto-fetch tests exercise the same path they always did.
  readerAutoFetchAttempted: jest.fn(async () => new Set<string>()),
  markReaderAutoFetchAttempted: jest.fn(),
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

function mountOffer(client = createTestQueryClient(), focused = true) {
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
    focused,
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


// ---------------------------------------------------------------------------------------------
// The five findings of the independent Opus review of #503. Each of these buys a paid retrieval
// (an unresolvable paper escalates to the ~$0.10 agentic hunt) or puts a window over a screen the
// reader chose, so each is pinned.

describe('the bounds on automatic fetching (review of #503)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getActiveReaderJob as jest.Mock).mockResolvedValue({ job: null });
    (isReaderOfferDeferred as jest.Mock).mockResolvedValue(false);
    (readerAutoFetchAttempted as jest.Mock).mockResolvedValue(new Set<string>());
    (startRetrievalJob as jest.Mock).mockResolvedValue({
      job: { id: 'ret', status: 'running', retrieved: false, phase: 'hunting', error: null },
    });
    mockCandidates = [{ slug: 'ghost', title: 'Ghost', year: null, has_text: false }];
  });

  test('a paper already auto-fetched once is never auto-fetched again', async () => {
    // The memory is DURABLE. An in-memory set lives only as long as the screen, so re-entering
    // a paper whose PDF cannot be resolved re-bought the hunt every single time.
    (readerAutoFetchAttempted as jest.Mock).mockResolvedValue(new Set(['ghost']));
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.offer?.candidates).toHaveLength(1));
    await act(async () => undefined);
    expect(startRetrievalJob).not.toHaveBeenCalled();
    // ...and the reader can still ask explicitly. The bound is on the AUTOMATIC pass only.
    await act(async () => { await view.result.current.fetchCandidate('ghost'); });
    expect(startRetrievalJob).toHaveBeenCalledWith('p1', 'ghost', {});
    view.unmount();
  });

  test('an auto-fetch records itself, so the next entry into the paper does not repeat it', async () => {
    const view = mountOffer();
    await waitFor(() => expect(startRetrievalJob).toHaveBeenCalled());
    expect(markReaderAutoFetchAttempted).toHaveBeenCalledWith('p1', 'ghost');
    view.unmount();
  });

  test('unreadable storage refuses the automatic fetch rather than repeating it', async () => {
    // Treating a storage failure as "nothing attempted" would re-run the very hunts this
    // prevents. The failure mode has to be a button press, not a bill.
    (readerAutoFetchAttempted as jest.Mock).mockResolvedValue(new Set(['ghost']));
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.offer?.candidates).toHaveLength(1));
    await act(async () => undefined);
    expect(startRetrievalJob).not.toHaveBeenCalled();
    view.unmount();
  });

  test('the automatic pass has a total budget, not a concurrency limit', async () => {
    // The old bound was a `slice(0, 8)` taken from the currently-unfetched list on EVERY change.
    // As fetches landed, `has_text` flipped and the list shrank, so fresh candidates kept
    // entering the first eight and the real total was unbounded. Reproducing that needs the list
    // to actually shrink — a static candidate list makes the buggy code look bounded, which is
    // how this test passed against the bug on its first draft.
    mockCandidates = Array.from({ length: 30 }, (_, i) => (
      { slug: `p${i}`, title: `Paper ${i}`, year: null, has_text: false }
    ));
    (startRetrievalJob as jest.Mock).mockImplementation(async (_pid, slug) => {
      // The fetch lands immediately: the paper now has text, so it leaves the missing list.
      mockCandidates = mockCandidates.map((c) => (c.slug === slug ? { ...c, has_text: true } : c));
      return { job: { id: `ret-${slug}`, status: 'done', retrieved: true, phase: 'done', error: null } };
    });

    const view = mountOffer();
    await waitFor(() => expect(startRetrievalJob).toHaveBeenCalled());
    // Drive the effect repeatedly, as re-renders do on a live screen. The hazard is
    // unboundedness, so what is asserted is that the count STOPS GROWING — not that it reached
    // some floor, which the bug also satisfies.
    let previous = -1;
    for (let i = 0; i < 8 && previous !== (startRetrievalJob as jest.Mock).mock.calls.length; i += 1) {
      previous = (startRetrievalJob as jest.Mock).mock.calls.length;
      view.rerender(undefined as never);
      await act(async () => undefined);
    }
    expect((startRetrievalJob as jest.Mock).mock.calls.length).toBe(previous);
    expect(previous).toBeLessThanOrEqual(8);
    view.unmount();
  });
});

describe('the offer window does not open over another screen (review of #503)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getActiveReaderJob as jest.Mock).mockResolvedValue({ job: null });
    (isReaderOfferDeferred as jest.Mock).mockResolvedValue(false);
    (readerAutoFetchAttempted as jest.Mock).mockResolvedValue(new Set<string>());
    mockCandidates = [{ slug: 'h3', title: 'H3', year: 2025, has_text: true }];
  });

  test('a response landing while the reader is elsewhere does not raise the window', async () => {
    const view = mountOffer(createTestQueryClient(), false);
    await waitFor(() => expect(view.result.current.offer?.candidates).toHaveLength(1));
    await act(async () => undefined);
    expect(view.result.current.offerOpen).toBe(false);
    // And the offer is not SPENT: a window the reader never saw must still get its one chance.
    expect(deferReaderOffer).not.toHaveBeenCalled();
    view.unmount();
  });

  test('coming back to the paper gives the window its chance', async () => {
    const view = mountOffer(createTestQueryClient(), true);
    await waitFor(() => expect(view.result.current.offerOpen).toBe(true));
    expect(deferReaderOffer).toHaveBeenCalled();
    view.unmount();
  });
});


// ------------------------------------------------------------------ DR-155: the pass limit
//
// "I tried to stress test it with as many papers I could. It gives me this error. Is there a
// limit?" — Kamil, on a response citing seventeen unread papers. There was, and only the
// request validator knew it: every readable candidate was ticked, the button offered to read
// all seventeen, and the server answered with a list of pydantic error objects.

describe('the pass limit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getActiveReaderJob as jest.Mock).mockResolvedValue({ job: null });
    (isReaderOfferDeferred as jest.Mock).mockResolvedValue(false);
    (readerAutoFetchAttempted as jest.Mock).mockResolvedValue(new Set<string>());
    // Nothing ever lands, so `has_text` only changes when a test says so.
    (startRetrievalJob as jest.Mock).mockResolvedValue({
      job: { id: 'ret', status: 'done', retrieved: false, phase: 'done', error: null },
    });
    mockMaxTargets = 3;
    mockCandidates = Array.from({ length: 5 }, (_, i) => (
      { slug: `p${i}`, title: `Paper ${i}`, year: null, has_text: true }
    ));
  });

  test('the default selection stops at what one pass reads', async () => {
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.offer?.candidates).toHaveLength(5));
    await act(async () => undefined);
    expect([...view.result.current.selected]).toEqual(['p0', 'p1', 'p2']);
    expect(view.result.current.maxTargets).toBe(3);
    view.unmount();
  });

  test('ticking past the limit is refused, and unticking makes room', async () => {
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.selected.size).toBe(3));

    act(() => view.result.current.toggle('p4'));
    expect(view.result.current.selected.has('p4')).toBe(false);
    expect(view.result.current.selected.size).toBe(3);

    act(() => view.result.current.toggle('p0'));
    act(() => view.result.current.toggle('p4'));
    expect([...view.result.current.selected].sort()).toEqual(['p1', 'p2', 'p4']);
    view.unmount();
  });

  test('a paper whose text arrives mid-offer fills only room the reader left', async () => {
    mockCandidates = [
      ...Array.from({ length: 3 }, (_, i) => (
        { slug: `p${i}`, title: `Paper ${i}`, year: null, has_text: true }
      )),
      { slug: 'late', title: 'Late arrival', year: null, has_text: false },
    ];
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.selected.size).toBe(3));

    // Its fetch lands with the selection already full: it must not displace a chosen paper,
    // and it must not push the selection past what the server will accept.
    mockCandidates = mockCandidates.map((c) => (
      c.slug === 'late' ? { ...c, has_text: true } : c
    ));
    view.rerender(undefined as never);
    await act(async () => undefined);
    expect([...view.result.current.selected].sort()).toEqual(['p0', 'p1', 'p2']);

    // Make room, and the arrival is now takeable.
    act(() => view.result.current.toggle('p1'));
    act(() => view.result.current.toggle('late'));
    expect([...view.result.current.selected].sort()).toEqual(['late', 'p0', 'p2']);
    view.unmount();
  });

  test('a server that does not report the cap still bounds the selection at eight', async () => {
    mockMaxTargets = undefined;
    mockCandidates = Array.from({ length: 17 }, (_, i) => (
      { slug: `p${i}`, title: `Paper ${i}`, year: null, has_text: true }
    ));
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.offer?.candidates).toHaveLength(17));
    await act(async () => undefined);
    expect(view.result.current.maxTargets).toBe(8);
    expect(view.result.current.selected.size).toBe(8);
    view.unmount();
  });

  test('start sends no more targets than the pass accepts', async () => {
    (startReaderJob as jest.Mock).mockResolvedValue({
      job: { id: 'reader-1', status: 'running', targets: [], finished_at: null },
    });
    (getReaderJob as jest.Mock).mockResolvedValue({
      job: { id: 'reader-1', status: 'done', targets: [], finished_at: 'x', analysis_job_id: null },
    });
    const view = mountOffer();
    await waitFor(() => expect(view.result.current.selected.size).toBe(3));
    await act(async () => { await view.result.current.start(); });
    expect(startReaderJob).toHaveBeenCalledWith('p1', 'flint', ['p0', 'p1', 'p2'], expect.anything());
    view.unmount();
  });
});
