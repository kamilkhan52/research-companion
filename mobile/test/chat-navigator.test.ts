// DR-115 — the navigator against a fake list. What matters here is not the arithmetic (that
// is `chat-navigation.test.ts`) but the three things that bind it to a real inverted FlatList:
// which viewPosition means "top of the row", what retires a remembered landmark, and what an
// unmeasured target does.

import { act, renderHook } from '@testing-library/react-native';

import {
  CHAT_NAV_VIEW_POSITION,
  landingViewOffset,
  useChatNavigator,
  type ScrollableMessageList,
} from '@/hooks/useChatNavigator';

/** A header tall enough to hide the first lines of whatever lands under it. */
const CHROME = 96;

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

test('an index landing passes the inverted-list viewPosition through unchanged', () => {
  // Scoped honestly: Jest cannot exercise the inverted transform, so this pins the constant
  // and its plumbing, NOT that the row lands top-first — the client matching its own constant.
  // The binding itself is derived, for whoever has to re-verify it without a device:
  // VirtualizedList computes `offset = max(0, cellOffset - viewPosition * (visibleLength -
  // frame.length))`, so viewPosition 1 gives `cellOffset + frame.length - visibleLength`, i.e.
  // the cell's content-space END aligned with the viewport's END. `inverted` is a scaleY(-1),
  // so content-space END renders as the visual TOP — and the alignment target holds even when
  // the row is taller than the screen, which is the case this feature exists for. Getting it
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
    viewOffset: 0,   // no overlay chrome in this fixture; see the topClearance tests below
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
    viewOffset: 0,   // no overlay chrome in this fixture; see the topClearance tests below
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
    viewOffset: 0,   // no overlay chrome in this fixture; see the topClearance tests below
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
    viewOffset: 0,   // no overlay chrome in this fixture; see the topClearance tests below
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
    viewOffset: 0,   // no overlay chrome in this fixture; see the topClearance tests below
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

// --- landmarks that no longer describe the reader (Opus review of PR #467) --------------------

test('a scroll we did not issue retires the landmark, even without a finger drag', () => {
  // The blocking review finding. `onScrollBeginDrag` was the ONLY retirement path, on the
  // theory that a drag is the only way the reader moves without us. The chat library's own
  // scroll-to-latest button disproves that: its press scrolls programmatically, so no drag
  // fires, and `messages.length` does not change either, so neither guard clears the landmark.
  // The reader was then teleported by the next step — the exact behaviour the feature promises
  // to prevent. A landmark claims "message N's top is at the top of the viewport", and the
  // viewability callback reports that independently, so the claim is checked before it is used.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([1, 2])));
  act(() => result.current.goUp());                       // lands on 2, landmark = 2
  expect(list.scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 2 }));
  act(() => result.current.onViewableItemsChanged(viewable([2])));   // the jump arrives

  // The scroll-to-latest button fires: the viewport is now at the newest messages. No drag,
  // no length change — only the viewability report moves.
  act(() => result.current.onViewableItemsChanged(viewable([0])));
  list.scrollToIndex.mockClear();
  act(() => result.current.goDown());
  // Stale landmark 2 would have aimed at index 1 — back UP the thread, away from the live
  // edge the reader had just jumped to.
  expect(list.scrollToIndex).not.toHaveBeenCalledWith(
    expect.objectContaining({ index: 1 }));
  expect(list.scrollToOffset).toHaveBeenCalledWith(
    expect.objectContaining({ offset: 0 }));            // straight to live, from topIndex 0
});

test('a landmark the viewport still agrees with survives', () => {
  // The check must not be so eager that it throws away a good landmark — that would undo
  // "repeated presses keep stepping" and re-aim at the same message forever.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp());                        // landmark = 2
  act(() => result.current.onViewableItemsChanged(viewable([2])));  // arrived where it aimed
  act(() => result.current.goUp());
  expect(list.scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 3 }));                // stepped on, did not re-aim at 2
});

test('the live-edge landmark is exempt, since it makes no claim about the top row', () => {
  // Parked at the newest message, whichever row fits above it is at the visual top — so an
  // equality check against topIndex would spuriously retire a landmark that is perfectly good.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8 }),
  );
  act(() => result.current.goLive());                      // landmark = LIVE_EDGE
  act(() => result.current.onViewableItemsChanged(viewable([3])));  // some older row on screen
  act(() => result.current.goUp());
  // From the live edge, up is the NEWEST message's own top — not topIndex 3's neighbour.
  expect(list.scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 0 }));
});

test('start-of-thread re-issues once, because scrollToEnd never reports a failure', () => {
  // `scrollToEnd` derives its offset from the average row length and cannot fail, so the
  // bounded re-aim that protects index targets does not cover it — on a thread of screen-tall
  // rows the first landing can be far short. This is the control the ledger row asks Kamil to
  // check ("the double-chevrons reach the very start of the thread").
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 40 }),
  );
  act(() => result.current.goOldest());
  expect(list.scrollToEnd).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(200));
  expect(list.scrollToEnd).toHaveBeenCalledTimes(2);       // corrected after the rows measured
  act(() => jest.advanceTimersByTime(2000));
  expect(list.scrollToEnd).toHaveBeenCalledTimes(2);       // exactly one correction, not a loop
});

test('another jump cancels the start-of-thread correction', () => {
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 40 }),
  );
  act(() => result.current.goOldest());
  act(() => result.current.goLive());
  act(() => jest.advanceTimersByTime(500));
  expect(list.scrollToEnd).toHaveBeenCalledTimes(1);       // the pending correction was dropped
});

test('a shrinking list retires the pending correction instead of throwing past the end', () => {
  // `messages` shrinks while mounted — retrying a turn and editing a user turn both truncate
  // it. `scrollToIndex` throws a hard invariant when the index is past the end, and this one
  // would have fired from a timer, uncaught.
  const list = fakeList();
  const { result, rerender } = renderHook<
    ReturnType<typeof useChatNavigator>, { count: number }
  >(({ count }) => useChatNavigator({ listRef: { current: list }, count }),
    { initialProps: { count: 30 } });
  act(() => result.current.onScrollToIndexFailed({ index: 27, averageItemLength: 100 }));
  rerender({ count: 4 });                                  // the thread was truncated
  list.scrollToIndex.mockClear();
  act(() => jest.advanceTimersByTime(500));
  expect(list.scrollToIndex).not.toHaveBeenCalled();
});

test('stepping keeps working when viewability lags the animated scroll', () => {
  // The trap in the retirement check, and the reason it tracks ARRIVAL rather than comparing
  // the landmark to topIndex at press time. Viewability reports lag an animated scroll, so a
  // second press mid-travel reads a stale top row. Compared naively that looks like "the reader
  // moved", the landmark is thrown away, and the rail re-aims at the message it just left —
  // stepping stalls. Reports that do not match the target in flight must mean nothing.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 12 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp());                                 // aims at 2
  act(() => result.current.onViewableItemsChanged(viewable([2])));  // arrives
  act(() => result.current.goUp());                                 // aims at 3
  // Mid-flight report still naming the row we are leaving — not the reader moving.
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp());
  expect(list.scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 4 }));    // kept stepping; did not stall back on 2 or 3
});

test('taking over the scroll cancels the start-of-thread correction', () => {
  // Introduced by the correction itself: tap ⌃⌃, change your mind inside RETRY_DELAY_MS, and
  // the timer yanked you back to the start of the thread out of your own drag.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 40 }),
  );
  act(() => result.current.goOldest());
  act(() => result.current.onScrollBeginDrag());
  act(() => jest.advanceTimersByTime(500));
  expect(list.scrollToEnd).toHaveBeenCalledTimes(1);     // no unasked-for second jump
});

// --- landing clear of the floating header (Kamil's 2026-09-02 remark on DR-115) ---------------

test('the chrome clearance is applied as a NEGATIVE viewOffset, because the list is inverted', () => {
  // The sign is the whole finding. VirtualizedList SUBTRACTS viewOffset from the offset it
  // computes; `inverted` is a scaleY(-1), so a smaller offset moves content UP — further behind
  // the header, i.e. exactly the direction Kamil reported ("the top of the message is hidden by
  // the title"). Positive would have made his report worse rather than fixing it.
  expect(landingViewOffset(CHROME)).toBe(-CHROME);
  // …and no chrome means a plain 0, not the -0 that negation gives, which is not Object.is-equal.
  expect(Object.is(landingViewOffset(0), 0)).toBe(true);

  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8, topClearance: CHROME }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp());
  expect(list.scrollToIndex).toHaveBeenCalledWith({
    index: 2,
    viewPosition: CHAT_NAV_VIEW_POSITION,
    viewOffset: -CHROME,
    animated: true,
  });
});

test('the re-aim after an unmeasured target clears the same chrome, both times', () => {
  // Two landings, one target: the approximate offset (which cannot use viewOffset at all, so it
  // ADDS the clearance — inverted, larger offset moves content down) and the exact correction.
  // If only one of them carried it, a far jump would settle under the header for the very rows
  // this feature exists to reach.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 40, topClearance: CHROME }),
  );
  act(() => result.current.onScrollToIndexFailed({ index: 30, averageItemLength: 400 }));
  expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 12000 + CHROME, animated: true });
  act(() => void jest.runOnlyPendingTimers());
  expect(list.scrollToIndex).toHaveBeenCalledWith(
    expect.objectContaining({ index: 30, viewOffset: -CHROME }));
});

test('a cleared landing still counts as arriving, though the message above shows its foot', () => {
  // The band held clear of the header is filled by the FOOT of the message above the target,
  // and `itemVisiblePercentThreshold: 1` reports a sliver as viewable — so the top row after a
  // cleared landing is legitimately target+1. Demanding equality would leave every jump
  // permanently "in flight", which silently disables the retirement below: the landmark would
  // survive a scroll-to-latest tap again, the P1 this hook already paid for once.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8, topClearance: CHROME }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp());                                    // aims at 2
  act(() => result.current.onViewableItemsChanged(viewable([2, 3])));  // arrives; 3's foot shows

  // Now the library's own scroll-to-latest button fires: no drag, no length change.
  act(() => result.current.onViewableItemsChanged(viewable([0])));
  list.scrollToIndex.mockClear();
  act(() => result.current.goDown());
  expect(list.scrollToIndex).not.toHaveBeenCalled();                   // not the stale 2 - 1 = 1
  expect(list.scrollToOffset).toHaveBeenCalledWith(
    expect.objectContaining({ offset: 0 }));
});

test('the neighbour showing its foot does not retire the landmark it belongs to', () => {
  // The other half of the same tolerance, and the half that needs a DOWN press to prove: from
  // landmark 2 the next step down is 1, whereas a landmark wrongly retired would count from the
  // reported top row (3) and go to 2 — back to the message the reader is already reading.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 8, topClearance: CHROME }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([2])));
  act(() => result.current.goUp());                                    // lands on 2
  act(() => result.current.onViewableItemsChanged(viewable([2, 3])));  // 3's foot under the header
  act(() => result.current.onViewableItemsChanged(viewable([2, 3])));  // and again, settled
  act(() => result.current.goDown());
  expect(list.scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 1 }));
});

test('a target that exhausts its corrections stops claiming the reader is on it', () => {
  // Out of corrections the reader is at an APPROXIMATION, but the landmark said otherwise and
  // pendingTopRef was still suppressing the retirement that would have caught it — so the next
  // step counted from a message the reader was never on, skipping several.
  const list = fakeList();
  const { result } = renderHook(() =>
    useChatNavigator({ listRef: { current: list }, count: 40 }),
  );
  act(() => result.current.onViewableItemsChanged(viewable([26])));
  // With no landmark, stepUp aims at the message the reader is INSIDE — 26, not 26+1.
  act(() => result.current.goUp());
  for (let i = 0; i < 3; i += 1) {
    act(() => result.current.onScrollToIndexFailed({ index: 26, averageItemLength: 100 }));
    act(() => jest.advanceTimersByTime(200));
  }
  // It gave up around 26-ish; the viewport says so and is now believed.
  act(() => result.current.onViewableItemsChanged(viewable([26])));
  list.scrollToIndex.mockClear();
  act(() => result.current.goUp());
  // 26 again — the head of the message the reader is actually inside, which is what stepUp
  // does with no landmark. The lie would have given 27, a message they never reached.
  expect(list.scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 26 }));
});
