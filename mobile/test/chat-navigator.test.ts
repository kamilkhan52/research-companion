// DR-115 — the navigator against a fake list. What matters here is not the arithmetic (that
// is `chat-navigation.test.ts`) but the three things that bind it to a real inverted FlatList:
// which viewPosition means "top of the row", what retires a remembered landmark, and what an
// unmeasured target does.

import { act, renderHook } from '@testing-library/react-native';

import {
  CHAT_NAV_VIEW_POSITION,
  useChatNavigator,
  type ScrollableMessageList,
} from '@/hooks/useChatNavigator';

function fakeList() {
  return {
    scrollToIndex: jest.fn(),
    scrollToOffset: jest.fn(),
    scrollToEnd: jest.fn(),
  } satisfies ScrollableMessageList;
}

function viewable(indices: number[]) {
  return { viewableItems: indices.map((index) => ({ index })) as never[] };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('an index landing aligns the row\'s TOP with the viewport top', () => {
  // The list is inverted, so viewPosition 1 — not 0 — is the top of a row. Getting this
  // backwards would leave the reader at the FOOT of the response they asked to jump to.
  expect(CHAT_NAV_VIEW_POSITION).toBe(1);
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 6 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([1, 2])));
  act(() => result.current.goUp());
  expect(list.scrollToIndex).toHaveBeenCalledWith({
    index: 2,
    viewPosition: 1,
    animated: true,
  });
});

test('the top of the viewport is the LARGEST viewable index, not the first reported', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([3, 5, 4])));
  act(() => result.current.goDown());
  expect(list.scrollToIndex).toHaveBeenCalledWith({
    index: 4,
    viewPosition: 1,
    animated: true,
  });
});

test('repeated presses keep stepping instead of re-aiming at the same message', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp());
  act(() => result.current.goUp());
  act(() => result.current.goUp());
  expect(list.scrollToIndex.mock.calls.map(([call]) => call.index)).toEqual([2, 3, 4]);
});

test('a finger drag retires the landmark, so the next step re-aims at where the reader stopped', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp()); // landmark = 2
  act(() => result.current.onScrollBeginDrag());
  act(() => result.current.onViewableItemsChanged(viewable([6])));
  act(() => result.current.goUp());
  expect(list.scrollToIndex).toHaveBeenLastCalledWith({
    index: 6,
    viewPosition: 1,
    animated: true,
  });
});

test('a new message retires the landmark, because every older index has shifted', () => {
  const list = fakeList();
  const { result, rerender } = renderHook(
    ({ count }: { count: number }) => useChatNavigator({ listRef: { current: list }, count }),
    { initialProps: { count: 8 } },
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp()); // landmark = 2
  rerender({ count: 9 }); // a turn landed; message 2 is now message 3
  act(() => result.current.onViewableItemsChanged(viewable([3])));
  act(() => result.current.goUp());
  // Aimed afresh at what is on screen, not at the stale landmark + 1.
  expect(list.scrollToIndex).toHaveBeenLastCalledWith({
    index: 3,
    viewPosition: 1,
    animated: true,
  });
});

test('the extremes use the exact primitives, not an index landing', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 6 }),
  );
  act(() => result.current.goOldest());
  expect(list.scrollToEnd).toHaveBeenCalledWith({ animated: true });
  act(() => result.current.goLive());
  expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  expect(list.scrollToIndex).not.toHaveBeenCalled();
});

test('stepping up from the live edge shows the newest message rather than skipping it', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 6 }),
  );
  act(() => result.current.goLive());
  act(() => result.current.goUp());
  expect(list.scrollToIndex).toHaveBeenCalledWith({
    index: 0,
    viewPosition: 1,
    animated: true,
  });
});

test('an unmeasured target lands approximately, then aims again — a bounded number of times', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 40 }),
  );
  const fail = () => result.current.onScrollToIndexFailed({ index: 30, averageItemLength: 400 });

  act(() => fail());
  expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 12000, animated: true });
  act(() => void jest.runOnlyPendingTimers());
  expect(list.scrollToIndex).toHaveBeenCalledTimes(1);

  act(() => fail());
  act(() => void jest.runOnlyPendingTimers());
  expect(list.scrollToIndex).toHaveBeenCalledTimes(2);

  // Third failure for the same target: approximate landing only. Retrying forever would fight
  // a list that is still re-measuring.
  act(() => fail());
  act(() => void jest.runOnlyPendingTimers());
  expect(list.scrollToIndex).toHaveBeenCalledTimes(2);
  expect(list.scrollToOffset).toHaveBeenCalledTimes(3);
});

test('a new jump cancels a pending correction for the previous target', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 40 }),
  );
  act(() => result.current.onScrollToIndexFailed({ index: 30, averageItemLength: 400 }));
  act(() => result.current.goLive());
  act(() => void jest.runOnlyPendingTimers());
  // Only the live-edge scroll happened; no late correction dragged the reader back to 30.
  expect(list.scrollToIndex).not.toHaveBeenCalled();
});

test('reduce motion keeps the jump and drops the travel', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 6, animated: false }),
  );
  act(() => result.current.goLive());
  expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
});

test('the viewability handler is identity-stable across renders (FlatList requirement)', () => {
  const list = fakeList();
  const { result, rerender } = renderHook(
    ({ count }: { count: number }) => useChatNavigator({ listRef: { current: list }, count }),
    { initialProps: { count: 6 } },
  );
  const handler = result.current.onViewableItemsChanged;
  rerender({ count: 7 });
  expect(result.current.onViewableItemsChanged).toBe(handler);
});
