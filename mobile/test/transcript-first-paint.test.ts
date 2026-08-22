// DR-100 — the discussion skeleton must cover the transcript until the list actually shows
// a message. Session data arriving (~10ms) is not the same event as the first frame of a
// heavy transcript committing (measured seconds on a long thread) — tearing the skeleton
// down on data-arrival is exactly the blank screen Kamil reported.

import { act, renderHook } from '@testing-library/react-native';

import {
  FIRST_PAINT_CEILING_MS,
  useTranscriptFirstPaint,
} from '@/hooks/useTranscriptFirstPaint';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('holds until the first non-empty viewable set, then paints', () => {
  const { result } = renderHook(() => useTranscriptFirstPaint(true));
  expect(result.current.painted).toBe(false);
  act(() => result.current.onViewableItemsChanged({ viewableItems: [] }));
  expect(result.current.painted).toBe(false); // empty set = nothing on screen yet
  act(() =>
    result.current.onViewableItemsChanged({
      viewableItems: [{ isViewable: true } as never],
    }),
  );
  expect(result.current.painted).toBe(true);
});

test('an empty transcript never shows the overlay', () => {
  const { result } = renderHook(() => useTranscriptFirstPaint(false));
  expect(result.current.painted).toBe(true);
});

test('the ceiling tears the overlay down even if viewability never fires', () => {
  const { result } = renderHook(() => useTranscriptFirstPaint(true));
  act(() => void jest.advanceTimersByTime(FIRST_PAINT_CEILING_MS + 1));
  expect(result.current.painted).toBe(true);
});

test('the viewability pair is identity-stable across renders (FlatList requirement)', () => {
  const { result, rerender } = renderHook(() => useTranscriptFirstPaint(true));
  const config = result.current.viewabilityConfig;
  const handler = result.current.onViewableItemsChanged;
  rerender(undefined);
  expect(result.current.viewabilityConfig).toBe(config);
  expect(result.current.onViewableItemsChanged).toBe(handler);
});

test('a transcript that later gains content does not resurrect the overlay', () => {
  const { result, rerender } = renderHook(
    ({ has }: { has: boolean }) => useTranscriptFirstPaint(has),
    { initialProps: { has: false } },
  );
  expect(result.current.painted).toBe(true);
  rerender({ has: true });
  expect(result.current.painted).toBe(true);
});

// DR-101 — the skeleton must be committed and pulsing BEFORE the heavy transcript mount
// blocks the JS thread; mounting both in one commit left the pulse queued behind seconds of
// work and the reader saw a frozen skeleton.
describe('useDeferredFirstMount', () => {
  test('defers exactly two frames, then mounts', () => {
    const { useDeferredFirstMount } = require('@/hooks/useTranscriptFirstPaint');
    const raf: FrameRequestCallback[] = [];
    const spy = jest
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => raf.push(cb));
    try {
      const { result } = renderHook(() => useDeferredFirstMount(true));
      expect(result.current).toBe(false);
      act(() => void raf.shift()!(0)); // frame 1: skeleton painted
      expect(result.current).toBe(false);
      act(() => void raf.shift()!(0)); // frame 2: pulse started
      expect(result.current).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('no deferral when there is nothing heavy to wait for', () => {
    const { useDeferredFirstMount } = require('@/hooks/useTranscriptFirstPaint');
    const { result } = renderHook(() => useDeferredFirstMount(false));
    expect(result.current).toBe(true);
  });
});
