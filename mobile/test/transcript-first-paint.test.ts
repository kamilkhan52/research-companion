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
