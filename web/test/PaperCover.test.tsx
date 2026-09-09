import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_POLL_MAX_ATTEMPTS, PaperCover } from '@/components/PaperCover';
import { useAuthenticatedImage } from '@/hooks/useAuthenticatedImage';
import { renderHook } from '@testing-library/react';

const api = vi.hoisted(() => ({ getPaperCover: vi.fn(), paperCoverPath: vi.fn(), apiBlob: vi.fn() }));
vi.mock('@/api/endpoints', () => ({
  getPaperCover: api.getPaperCover,
  paperCoverPath: (pid: string, slug: string) => `/api/projects/${pid}/papers/${slug}/cover.png`,
}));
vi.mock('@/api/client', () => ({ apiBlob: api.apiBlob }));

const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  // jsdom has neither; the leak these stand in for is the whole reason the hook exists.
  URL.createObjectURL = vi.fn(() => { n += 1; const u = `blob:${n}`; created.push(u); return u; });
  URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
  api.apiBlob.mockResolvedValue(new Blob(['png']));
  api.getPaperCover.mockResolvedValue({ status: 'ready' });
});

/** jsdom has no IntersectionObserver. This one starts unobserved and only reports intersection
 *  when a test says so, which is the point: the component must ask for NOTHING until then. */
const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];

function stubIntersectionObserver() {
  observers.length = 0;
  class Stub {
    private entry: { callback: IntersectionObserverCallback; disconnected: boolean };
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }
    observe() {}
    unobserve() {}
    disconnect() { this.entry.disconnected = true; }
    takeRecords() { return []; }
    root = null; rootMargin = ''; thresholds = [];
  }
  vi.stubGlobal('IntersectionObserver', Stub);
}

function scrollIntoView() {
  for (const observer of observers) {
    if (!observer.disconnected) {
      observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useAuthenticatedImage', () => {
  it('revokes the object URL it created when the caller goes away', async () => {
    const { result, unmount } = renderHook(() => useAuthenticatedImage('/cover.png'));
    await waitFor(() => expect(result.current).toBe('blob:1'));

    unmount();

    expect(revoked).toEqual(['blob:1']);
  });

  it('revokes a blob that arrives after the caller has gone', async () => {
    // The URL exists by then. Dropping it on the floor is exactly the leak this hook is for.
    let land!: (blob: Blob) => void;
    api.apiBlob.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    const { unmount } = renderHook(() => useAuthenticatedImage('/cover.png'));

    unmount();
    land(new Blob(['png']));

    // Wait for the URL to actually exist first. Asserting `revoked` equals `created` straight
    // away passes while BOTH are still empty — which is the assertion succeeding before the
    // thing it describes has happened, not evidence that it did.
    await waitFor(() => expect(created).toHaveLength(1));
    await waitFor(() => expect(revoked).toEqual(['blob:1']));
  });

  it('loads nothing, and revokes nothing, for a null path', async () => {
    const { result } = renderHook(() => useAuthenticatedImage(null));
    await waitFor(() => expect(result.current).toBeNull());
    expect(api.apiBlob).not.toHaveBeenCalled();
  });

  it('reports no image rather than throwing when the fetch fails', async () => {
    api.apiBlob.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useAuthenticatedImage('/cover.png'));
    await waitFor(() => expect(api.apiBlob).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});

describe('PaperCover', () => {
  beforeEach(() => stubIntersectionObserver());

  it('asks for nothing until the row is actually on screen', async () => {
    // `/cover` calls `cover_jobs.ensure`, which SPAWNS a render that downloads the paper's PDF.
    // One per library row on mount is a burst of arXiv fetches from a single address, and being
    // rate-limited for it breaks retrieval, not thumbnails.
    render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await Promise.resolve();
    expect(api.getPaperCover).not.toHaveBeenCalled();

    await act(async () => { scrollIntoView(); });

    await waitFor(() => expect(api.getPaperCover).toHaveBeenCalledWith('p1', 'attention'));
  });

  it('shows the cached page once the render is ready', async () => {
    render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await act(async () => { scrollIntoView(); });

    const img = await screen.findByTestId('cover-attention');
    expect(img).toHaveAttribute('src', 'blob:1');
    // The card's own heading says the title beside this; announcing it again reads every row twice.
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders no image when there is no cover to show', async () => {
    api.getPaperCover.mockResolvedValue({ status: 'unavailable' });
    const { container } = render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await act(async () => { scrollIntoView(); });

    await waitFor(() => expect(api.getPaperCover).toHaveBeenCalled());
    expect(container.querySelector('img')).toBeNull();
    // Terminal server-side: a failed render is never retried, so neither is the question.
    expect(api.apiBlob).not.toHaveBeenCalled();
  });

  it('stops asking after a render that never resolves', async () => {
    vi.useFakeTimers();
    api.getPaperCover.mockResolvedValue({ status: 'pending' });
    render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await act(async () => { scrollIntoView(); });

    for (let i = 0; i < COVER_POLL_MAX_ATTEMPTS + 5; i += 1) {
      await vi.advanceTimersByTimeAsync(3000);
    }

    // Without the bound, one stuck paper has the whole library asking after it forever.
    expect(api.getPaperCover.mock.calls.length).toBeLessThanOrEqual(COVER_POLL_MAX_ATTEMPTS);
  });

  it('stops polling the moment a pending render lands', async () => {
    vi.useFakeTimers();
    api.getPaperCover
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'ready' });
    render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await act(async () => { scrollIntoView(); });

    await vi.advanceTimersByTimeAsync(3000);
    const settled = api.getPaperCover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);

    expect(api.getPaperCover.mock.calls.length).toBe(settled);
  });

  it('asks about the new paper, not the old one, when the row changes', async () => {
    // The second paper's cover deliberately never becomes ready, so ANY image left on screen
    // after the change is the first paper's — which is the whole property under test.
    api.getPaperCover.mockResolvedValueOnce({ status: 'ready' }).mockResolvedValue({ status: 'pending' });
    const { rerender, container } = render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await act(async () => { scrollIntoView(); });
    await screen.findByTestId('cover-attention');

    rerender(<PaperCover pid="p1" slug="resnet" title="ResNet" />);

    await waitFor(() => expect(api.getPaperCover).toHaveBeenCalledWith('p1', 'resnet'));
    // The first paper's blob must not outlive its row.
    await waitFor(() => expect(revoked).toContain('blob:1'));
    // And the PROPERTY, not the lines that provide it: two separate resets each clear this, so
    // removing either alone changes nothing. Only an assertion about what is ON SCREEN can see
    // the wrong paper's first page sitting under the new paper's title.
    await waitFor(() => expect(container.querySelector('img.paper-cover')).toBeNull());
  });

  it('stops asking once the answer is terminal', async () => {
    // A failed render is never retried server-side, so neither is the question — and an
    // `unavailable` paper polling ten times is exactly the multiplier that made the burst worse.
    vi.useFakeTimers();
    api.getPaperCover.mockResolvedValue({ status: 'unavailable' });
    render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await act(async () => { scrollIntoView(); });
    await vi.advanceTimersByTimeAsync(0);

    const settled = api.getPaperCover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);

    expect(settled).toBe(1);
    expect(api.getPaperCover.mock.calls.length).toBe(1);
  });

  it('does not fire a scheduled poll after the row is gone', async () => {
    vi.useFakeTimers();
    api.getPaperCover.mockResolvedValue({ status: 'pending' });
    const { unmount } = render(<PaperCover pid="p1" slug="attention" title="Attention" />);
    await act(async () => { scrollIntoView(); });
    await vi.advanceTimersByTimeAsync(0);
    const before = api.getPaperCover.mock.calls.length;

    unmount();
    await vi.advanceTimersByTimeAsync(30000);

    expect(api.getPaperCover.mock.calls.length).toBe(before);
  });
});
