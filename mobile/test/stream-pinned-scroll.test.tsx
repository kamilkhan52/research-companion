// DR-089 — Kamil (2026-08-20): "When chat is scrolled up, it keeps scrolling during
// generation… find the right way to fix this so it doesn't reappear." The fix pauses the
// streamed REVEAL while the reader is away from the live edge: nothing grows, so nothing
// can drag the viewport — the mechanism every offset-correction attempt lost to (see
// useStreamPinnedScroll's header). These tests pin both halves: the away detection from
// the chat library's forwarded scroll events, and useSmoothText holding under `paused`.

import { act, renderHook } from '@testing-library/react-native';

import { PIN_FOLLOW_THRESHOLD, useReaderAwayFromLive } from '@/hooks/useStreamPinnedScroll';
import { useSmoothText } from '@/hooks/useSmoothText';

describe('useReaderAwayFromLive', () => {
  // The chat library forwards scroll events in reanimated's shape: top-level contentOffset.
  test('flips on beyond the follow threshold and off on return', () => {
    const { result } = renderHook(() => useReaderAwayFromLive());
    expect(result.current.away).toBe(false);
    act(() => result.current.onScroll({ contentOffset: { y: PIN_FOLLOW_THRESHOLD + 1 } }));
    expect(result.current.away).toBe(true);
    act(() => result.current.onScroll({ contentOffset: { y: PIN_FOLLOW_THRESHOLD } }));
    expect(result.current.away).toBe(false);
  });

  test('reads the RN nativeEvent shape too, in case the wiring ever changes', () => {
    const { result } = renderHook(() => useReaderAwayFromLive());
    act(() => result.current.onScroll({ nativeEvent: { contentOffset: { y: 900 } } }));
    expect(result.current.away).toBe(true);
  });

  test('an event without an offset changes nothing', () => {
    const { result } = renderHook(() => useReaderAwayFromLive());
    act(() => result.current.onScroll({ contentOffset: { y: 900 } }));
    act(() => result.current.onScroll({}));
    expect(result.current.away).toBe(true);
  });
});

describe('useSmoothText paused', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const LONG = 'x'.repeat(600);

  test('paused holds the reveal exactly where it was while text keeps arriving', () => {
    const { result, rerender } = renderHook(
      ({ text, paused }: { text: string; paused: boolean }) => useSmoothText(text, paused),
      { initialProps: { text: LONG, paused: false } },
    );
    act(() => void jest.advanceTimersByTime(500));
    const revealedBeforePause = result.current.length;
    expect(revealedBeforePause).toBeGreaterThan(0);

    rerender({ text: LONG, paused: true });
    act(() => void jest.advanceTimersByTime(5000));
    expect(result.current.length).toBe(revealedBeforePause);

    // More text arrives while paused — still held.
    rerender({ text: LONG + LONG, paused: true });
    act(() => void jest.advanceTimersByTime(5000));
    expect(result.current.length).toBe(revealedBeforePause);
  });

  test('unpausing resumes the reveal and catches up', () => {
    const { result, rerender } = renderHook(
      ({ text, paused }: { text: string; paused: boolean }) => useSmoothText(text, paused),
      { initialProps: { text: LONG, paused: true } },
    );
    act(() => void jest.advanceTimersByTime(2000));
    expect(result.current.length).toBe(0);

    rerender({ text: LONG, paused: false });
    act(() => void jest.advanceTimersByTime(30000));
    expect(result.current).toBe(LONG);
  });

  test('paused never truncates text already revealed', () => {
    const { result, rerender } = renderHook(
      ({ text, paused }: { text: string; paused: boolean }) => useSmoothText(text, paused),
      { initialProps: { text: LONG, paused: false } },
    );
    act(() => void jest.advanceTimersByTime(30000));
    expect(result.current).toBe(LONG);
    rerender({ text: LONG, paused: true });
    expect(result.current).toBe(LONG);
  });
});
