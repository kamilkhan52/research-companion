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
//
//  • Appending a message shifts every older index by one, so a landmark recorded against the
//    previous array names a different message afterwards. It is dropped on any length change
//    rather than silently aimed somewhere arbitrary.

import { useCallback, useEffect, useRef } from 'react';
import type { ViewToken } from 'react-native';

import { landmarkAfter, stepDown, stepUp, type NavTarget } from '@/lib/chatNavigation';

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

  // Adjusting a ref during render (rather than in an effect) so a press in the same commit as
  // a new message cannot read a landmark that no longer names the message it was recorded for.
  if (countRef.current !== count) {
    countRef.current = count;
    landmarkRef.current = null;
  }

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
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
      if (target.kind === 'live') list.scrollToOffset({ offset: 0, animated });
      else if (target.kind === 'oldest') list.scrollToEnd({ animated });
      else list.scrollToIndex({ index: target.index, viewPosition: CHAT_NAV_VIEW_POSITION, animated });
      landmarkRef.current = landmarkAfter(target, countRef.current);
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

  const goOldest = useCallback(() => scrollTo({ kind: 'oldest' }), [scrollTo]);
  const goLive = useCallback(() => scrollTo({ kind: 'live' }), [scrollTo]);

  // Ref-stable: FlatList requires the viewability pair's identity never to change, and this
  // one is composed with DR-100's first-paint listener at the call site.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let top: number | null = null;
    for (const token of viewableItems) {
      if (typeof token.index === 'number' && (top === null || token.index > top)) top = token.index;
    }
    if (top !== null) topIndexRef.current = top;
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
