// The streamed-text reveal buffer: chars arrive in lumps, the hook paints them on a timer.
// Pins the adaptive cadence added for long turns — every tick re-renders (and re-parses) the
// whole message, so past a size threshold the tick halves while chars-per-second holds.

import { act, renderHook } from '@testing-library/react-native';

import { useSmoothText } from '@/hooks/useSmoothText';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks(); // the pace test spies on global setInterval; don't leak it
});

test('exactly one interval is alive across target changes', () => {
  const setSpy = jest.spyOn(global, 'setInterval');
  const clearSpy = jest.spyOn(global, 'clearInterval');
  const { rerender, unmount } = renderHook(
    ({ text }: { text: string }) => useSmoothText(text),
    { initialProps: { text: 'first chunk of text' } },
  );
  act(() => jest.advanceTimersByTime(66));
  rerender({ text: 'first chunk of text, grown' });
  act(() => jest.advanceTimersByTime(66));
  rerender({ text: 'first chunk of text, grown further' });
  act(() => jest.advanceTimersByTime(66));

  // Each target change tears down the previous interval before creating the next: at any
  // moment intervals-created exceeds intervals-cleared by exactly the one that is live.
  expect(setSpy.mock.calls.length).toBe(clearSpy.mock.calls.length + 1);
  unmount();
  expect(setSpy.mock.calls.length).toBe(clearSpy.mock.calls.length);
});

test('reveals the full target and never goes backwards', () => {
  const { result, rerender } = renderHook(({ text }: { text: string }) => useSmoothText(text), {
    initialProps: { text: 'Hello, world.' },
  });

  let previous = result.current.length;
  for (let i = 0; i < 40; i++) {
    act(() => jest.advanceTimersByTime(33));
    expect(result.current.length).toBeGreaterThanOrEqual(previous);
    previous = result.current.length;
  }
  expect(result.current).toBe('Hello, world.');

  // More text arrives: the reveal continues from where it was, still monotonic.
  rerender({ text: 'Hello, world. And more.' });
  for (let i = 0; i < 60; i++) act(() => jest.advanceTimersByTime(33));
  expect(result.current).toBe('Hello, world. And more.');
});

test('a shrunken target (retry/reset) snaps down instead of un-typing', () => {
  const { result, rerender } = renderHook(({ text }: { text: string }) => useSmoothText(text), {
    initialProps: { text: 'A long first response body.' },
  });
  for (let i = 0; i < 80; i++) act(() => jest.advanceTimersByTime(33));
  expect(result.current).toBe('A long first response body.');

  rerender({ text: 'Short' });
  expect(result.current).toBe('Short');
});

test('long messages tick at half rate but reveal at the same chars per second', () => {
  jest.spyOn(global, 'setInterval');

  // Catch a run up, append a fixed 400-char burst (below MAX_LAG so no jump-cut), and measure
  // one second of reveal. The pinned property: the cadence halves past the size threshold
  // (33 → 66 ms interval) while chars-per-second stays equal, because per-tick steps scale by
  // the same factor (each tick moves backlog·CATCH_UP·pace).
  const measure = (base: number) => {
    const text = 'x'.repeat(base);
    const run = renderHook(({ t }: { t: string }) => useSmoothText(t), { initialProps: { t: text } });
    act(() => jest.advanceTimersByTime(5000)); // fully caught up
    expect(run.result.current.length).toBe(base);
    run.rerender({ t: text + 'y'.repeat(400) });
    const before = run.result.current.length;
    act(() => jest.advanceTimersByTime(1000));
    const revealed = run.result.current.length - before;
    const tick = (setInterval as unknown as jest.Mock).mock.calls.at(-1)![1] as number;
    run.unmount();
    return { revealed, tick };
  };

  const short = measure(3000);
  const long = measure(8000);

  expect(short.tick).toBe(33);
  expect(long.tick).toBe(66);
  // Equal chars-per-second within one coarse tick's rounding.
  expect(Math.abs(long.revealed - short.revealed)).toBeLessThanOrEqual(30);
  expect(short.revealed).toBeGreaterThan(300); // the burst is actually being consumed
});
