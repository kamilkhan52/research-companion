import { act, renderHook } from '@testing-library/react-native';

import {
  DISCUSSION_SKELETON_DELAY_MS,
  INITIAL_SKELETON_DELAY_MS,
  useDelayedInitialSkeleton,
} from '@/hooks/useDelayedInitialSkeleton';

type Inputs = { loading: boolean; hasData: boolean };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('delays an empty-cache skeleton so fast responses never flash it', () => {
  const hook = renderHook<boolean, Inputs>(
    ({ loading, hasData }) => useDelayedInitialSkeleton(loading, hasData),
    { initialProps: { loading: true, hasData: false } },
  );

  expect(hook.result.current).toBe(false);
  act(() => jest.advanceTimersByTime(INITIAL_SKELETON_DELAY_MS - 1));
  expect(hook.result.current).toBe(false);
  act(() => jest.advanceTimersByTime(1));
  expect(hook.result.current).toBe(true);
});

test('cached data suppresses the skeleton during a background refresh', () => {
  const hook = renderHook<boolean, Inputs>(
    ({ loading, hasData }) => useDelayedInitialSkeleton(loading, hasData),
    { initialProps: { loading: true, hasData: false } },
  );

  act(() => jest.advanceTimersByTime(INITIAL_SKELETON_DELAY_MS));
  expect(hook.result.current).toBe(true);

  hook.rerender({ loading: true, hasData: true });
  expect(hook.result.current).toBe(false);
  act(() => jest.runOnlyPendingTimers());
  expect(hook.result.current).toBe(false);
});

test('a completed fast load cancels its pending skeleton', () => {
  const hook = renderHook<boolean, Inputs>(
    ({ loading, hasData }) => useDelayedInitialSkeleton(loading, hasData),
    { initialProps: { loading: true, hasData: false } },
  );

  hook.rerender({ loading: false, hasData: true });
  act(() => jest.runOnlyPendingTimers());
  expect(hook.result.current).toBe(false);
});

test('discussion loads get a longer grace period than ordinary screens', () => {
  const hook = renderHook<boolean, Inputs>(
    ({ loading, hasData }) => useDelayedInitialSkeleton(
      loading,
      hasData,
      DISCUSSION_SKELETON_DELAY_MS,
    ),
    { initialProps: { loading: true, hasData: false } },
  );

  act(() => jest.advanceTimersByTime(INITIAL_SKELETON_DELAY_MS));
  expect(hook.result.current).toBe(false);
  act(() => jest.advanceTimersByTime(DISCUSSION_SKELETON_DELAY_MS - INITIAL_SKELETON_DELAY_MS));
  expect(hook.result.current).toBe(true);
});

test('an already-earned shared deadline is visible on the first render', () => {
  const hook = renderHook(() => useDelayedInitialSkeleton(true, false, 0));

  expect(hook.result.current).toBe(true);
});
