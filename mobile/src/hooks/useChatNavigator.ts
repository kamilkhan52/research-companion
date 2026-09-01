// DR-115 — drives the discussion transcript's landmark rail against the chat library's
// inverted FlatList. The geometry lives in `@/lib/chatNavigation`; this hook owns the state
// that geometry needs (where the last step landed, what is at the top of the viewport) and
// the one genuinely awkward part of the platform: `scrollToIndex` on a list of unmeasured,
// wildly unequal rows.
//
// Three things are worth knowing before changing this:
//
//  • `viewPosition: 1` is the TOP of a row here. The list is inverted, so its scroll space is
//    flipped: viewPosition 0 aligns a row's visual BOTTOM with the viewport bottom and 1
//    aligns its visual TOP with the viewport top. That holds even when the row is taller than
//    the screen, which is the case this feature exists for.
//
//  • A manual scroll invalidates the remembered landmark, and `onScrollBeginDrag` is how we
//    know: it fires only for a real finger drag, never for a programmatic scroll, so it
//    separates "the reader moved" from "we moved" without inspecting offsets. (Offsets were
//    the other candidate and DR-089 records why they are not trustworthy here — there is no
//    synchronous ground truth to compare against under the inverted transform.)
//    That listener alone is NOT enough, though, and assuming it was is the bug the first cut
//    shipped: a finger drag is not the only way the reader moves without us. The chat library
//    renders its own scroll-to-latest button, whose press scrolls PROGRAMMATICALLY — no drag
//    event, and no length change either — so a landmark recorded before it survived into a
//    thread the reader had already left, and the next step teleported them.
//    Rather than chase each such path, the viewability report is used as the second signal:
//    every jump records the top row it is travelling toward (`pendingTopRef`), reports are
//    ignored until one MATCHES it, and after that a report naming any other row means someone
//    moved the reader without telling us, so the landmark is retired.
//    Checking the landmark against `topIndex` at PRESS time was tried first and is wrong:
//    viewability lags an animated scroll, so a second press arriving mid-travel reads a stale
//    top row, wrongly concludes the landmark is dead, and stepping stalls on the same message.
//    Arrival-tracking is what distinguishes "still travelling" from "the reader moved".
//
//  • Appending a message shifts every older index by one, so a landmark recorded against the
//    previous array names a different message afterwards. It is dropped on any length change
//    rather than silently aimed somewhere arbitrary.

import { useCallback, useEffect, useRef } from 'react';
import type { ViewToken } from 'react-native';

import { LIVE_EDGE, landmarkAfter, stepDown, stepUp, type NavTarget } from '@/lib/chatNavigation';

/** Inverted list ⇒ 1 puts the row's visual TOP at the top of the viewport. */
export const CHAT_NAV_VIEW_POSITION = 1;

/** How long to let cells mount after an approximate landing before aiming again. */
const RETRY_DELAY_MS = 140;
/** After this many corrections the approximate landing is where the reader stays — a target
 *  that keeps failing is a list that keeps re-measuring, and retrying forever would fight it. */
const MAX_RETRIES = 2;

/** The subset of FlatList's imperative surface this hook uses. Typed structurally so the
 *  library's own ref (a gesture-handler FlatList) satisfies it without a cast. */
export interface ScrollableMessageList {
  scrollToIndex(params: { index: number; animated?: boolean; viewPosition?: number }): void;
  scrollToOffset(params: { offset: number; animated?: boolean }): void;
  scrollToEnd(params?: { animated?: boolean }): void;
}

export interface ScrollToIndexFailedInfo {
  index: number;
  averageItemLength: number;
}

export function useChatNavigator({
  listRef,
  count,
  animated = true,
}: {
  listRef: { current: ScrollableMessageList | null };
  count: number;
  /** False under the OS reduce-motion preference: the jump still happens, without the travel. */
  animated?: boolean;
}) {
  const landmarkRef = useRef<number | null>(null);
  const topIndexRef = useRef<number | null>(null);
  const countRef = useRef(count);
  const retryRef = useRef<{ index: number; attempts: number } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oldestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The top row a jump of ours is travelling toward, or null once it has arrived. */
  const pendingTopRef = useRef<number | null>(null);

  // Adjusting a ref during render (rather than in an effect) so a press in the same commit as
  // a new message cannot read a landmark that no longer names the message it was recorded for.
  if (countRef.current !== count) {
    countRef.current = count;
    landmarkRef.current = null;
    pendingTopRef.current = null;
    // The in-flight correction is aimed at an index in the OLD array. `messages` can shrink
    // while mounted — retrying a turn and editing a user turn both truncate it, and a turn
    // ending drops the optimistic echo plus the streaming row — and `scrollToIndex` throws an
    // invariant if the index is past the end. Retire the retry with the landmark.
    retryRef.current = null;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (oldestTimer.current) clearTimeout(oldestTimer.current);
  }, []);

  const scrollTo = useCallback(
    (target: NavTarget) => {
      const list = listRef.current;
      if (!list) return;
      retryRef.current = null;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      if (oldestTimer.current) {
        clearTimeout(oldestTimer.current);
        oldestTimer.current = null;
      }
      if (target.kind === 'live') list.scrollToOffset({ offset: 0, animated });
      else if (target.kind === 'oldest') list.scrollToEnd({ animated });
      else list.scrollToIndex({ index: target.index, viewPosition: CHAT_NAV_VIEW_POSITION, animated });
      landmarkRef.current = landmarkAfter(target, countRef.current);
      // What the viewport's top row should become once this scroll lands. Until a report
      // matches it, incoming reports are this scroll TRAVELLING, not evidence the reader moved
      // on their own — which is the distinction that makes the retirement below safe.
      pendingTopRef.current = target.kind === 'live' ? null : landmarkRef.current;
    },
    [animated, listRef],
  );

  const goUp = useCallback(() => {
    const target = stepUp({
      landmark: landmarkRef.current,
      topIndex: topIndexRef.current,
      count: countRef.current,
    });
    if (target) scrollTo(target);
  }, [scrollTo]);

  const goDown = useCallback(() => {
    const target = stepDown({
      landmark: landmarkRef.current,
      topIndex: topIndexRef.current,
      count: countRef.current,
    });
    if (target) scrollTo(target);
  }, [scrollTo]);

  const goOldest = useCallback(() => {
    scrollTo({ kind: 'oldest' });
    // `scrollToEnd` derives its offset from the list's AVERAGE row length, which on a thread
    // of unmeasured, screen-tall responses can be far out — and unlike an index target it
    // never reports a failure, so nothing corrects it. The index path got a bounded re-aim for
    // exactly this reason; "start of thread" needs one too, and it is the control Kamil's
    // ledger row asks him to check. One re-issue after the same settling delay, by which time
    // the rows near the end have measured. Cheap, and no index arithmetic to get wrong.
    if (oldestTimer.current) clearTimeout(oldestTimer.current);
    oldestTimer.current = setTimeout(() => {
      oldestTimer.current = null;
      listRef.current?.scrollToEnd({ animated });
    }, RETRY_DELAY_MS);
  }, [animated, listRef, scrollTo]);

  const goLive = useCallback(() => scrollTo({ kind: 'live' }), [scrollTo]);

  // Ref-stable: FlatList requires the viewability pair's identity never to change, and this
  // one is composed with DR-100's first-paint listener at the call site.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let top: number | null = null;
    for (const token of viewableItems) {
      if (typeof token.index === 'number' && (top === null || token.index > top)) top = token.index;
    }
    if (top === null) return;
    topIndexRef.current = top;
    if (pendingTopRef.current !== null) {
      // A jump of ours is still travelling. Reports along the way name rows we are passing,
      // not where the reader chose to be, so nothing is concluded from them until one matches.
      if (top === pendingTopRef.current) pendingTopRef.current = null;
      return;
    }
    // Settled, and the top row is not the one the landmark claims. Something moved the reader
    // that we did not issue and no drag announced — the chat library's own scroll-to-latest
    // button is the known case. Retire the landmark rather than teleport them from it; the
    // next step then aims from `topIndex`, i.e. from where they demonstrably are.
    //
    // LIVE_EDGE is exempt: it is the one landmark that makes no claim about the top row, since
    // parked at the newest message whichever row fits above it is at the visual top.
    if (landmarkRef.current !== null && landmarkRef.current !== LIVE_EDGE
        && top !== landmarkRef.current) {
      landmarkRef.current = null;
    }
  }).current;

  /** A finger drag — not one of our jumps — so the remembered landmark no longer describes
   *  where the reader is. */
  const onScrollBeginDrag = useCallback(() => {
    landmarkRef.current = null;
  }, []);

  /** `scrollToIndex` can only land exactly on a row the list has already measured, and this
   *  list deliberately renders a tiny window (DR-100). Approximate first so the cells around
   *  the target mount, then aim again — a bounded number of times. */
  const onScrollToIndexFailed = useCallback(
    (info: ScrollToIndexFailedInfo) => {
      const list = listRef.current;
      if (!list) return;
      list.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated });
      const state = retryRef.current?.index === info.index
        ? retryRef.current
        : { index: info.index, attempts: 0 };
      retryRef.current = state;
      if (state.attempts >= MAX_RETRIES) return;
      state.attempts += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        if (retryRef.current?.index !== info.index) return;
        // The list can have shrunk since the failure; scrollToIndex throws past the end.
        if (info.index >= countRef.current) return;
        listRef.current?.scrollToIndex({
          index: info.index,
          viewPosition: CHAT_NAV_VIEW_POSITION,
          animated,
        });
      }, RETRY_DELAY_MS);
    },
    [animated, listRef],
  );

  return { goUp, goDown, goOldest, goLive, onViewableItemsChanged, onScrollBeginDrag, onScrollToIndexFailed };
}
