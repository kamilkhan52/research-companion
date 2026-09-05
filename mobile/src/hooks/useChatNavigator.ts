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
//
//  • The viewport's top edge is NOT where the reader can start reading. The discussion header
//    floats OVER the transcript, so a row aligned flush with the top edge has its first lines
//    behind the title (Kamil, 2026-09-02: "while the top of the message is technically on
//    screen, it is hidden by the title"). Every index landing therefore clears `topClearance`
//    px — the same distance the list's own visual-top padding already gives the oldest
//    message. `viewOffset` carries it, and its sign is inverted here: see `landingViewOffset`.
//    Two consequences that are not obvious and are both handled below: the list clamps its
//    computed offset at 0 BEFORE subtracting viewOffset, so a landing that was already at the
//    live edge gets the clearance added on top of it (`scheduleSnapCheck`); and the cleared
//    band is filled by older rows, so a viewability report after a landing names one of THEM
//    as the top row (`describesLanding`).
//
//  • "Start of thread" was the ONE landing that fix did not cover, and it stayed broken in
//    exactly the reported way (DR-127, Kamil: "when scrolling to top of summary… it hides some
//    of the summary headers behind the UI. But when I manually scroll all the way up, it shows
//    perfectly"). It had its own primitive, `scrollToEnd`, which computes its offset from CELL
//    metrics plus the list's footer and is blind to `contentContainerStyle` padding — and the
//    list's visual-top padding IS `topClearance`. So it stopped that clearance short of the end
//    a finger reaches, landing the oldest message's top flush behind the header, while a manual
//    drag to the true end showed it correctly. No primitive lands it right, so the extreme now
//    takes the SAME cleared `scrollToIndex` landing as every other row. `scrollToEnd` survives
//    only as an APPROACH to an unmeasured last row, where the list's own end estimate beats
//    `averageItemLength * index`.

import { useCallback, useEffect, useRef } from 'react';
import type { ViewToken } from 'react-native';

import { LIVE_EDGE, landmarkAfter, stepDown, stepUp, type NavTarget } from '@/lib/chatNavigation';

/** Inverted list ⇒ 1 puts the row's visual TOP at the top of the viewport. */
export const CHAT_NAV_VIEW_POSITION = 1;

/** How long to let cells mount after an approximate landing before aiming again. */
const RETRY_DELAY_MS = 140;
/** Quiet time after the last scroll event at which a landing is treated as settled. Short
 *  enough to be invisible, long enough not to read an offset mid-travel. */
const SETTLE_QUIET_MS = 160;
/** After this many corrections the approximate landing is where the reader stays — a target
 *  that keeps failing is a list that keeps re-measuring, and retrying forever would fight it. */
const MAX_RETRIES = 2;

/** The subset of FlatList's imperative surface this hook uses. Typed structurally so the
 *  library's own ref (a gesture-handler FlatList) satisfies it without a cast. */
export interface ScrollableMessageList {
  scrollToIndex(params: {
    index: number;
    animated?: boolean;
    viewPosition?: number;
    viewOffset?: number;
  }): void;
  scrollToOffset(params: { offset: number; animated?: boolean }): void;
  scrollToEnd(params?: { animated?: boolean }): void;
}

export interface ScrollToIndexFailedInfo {
  index: number;
  averageItemLength: number;
}

/** The scroll events the chat library forwards arrive in reanimated's shape (a top-level
 *  `contentOffset`), not RN's `nativeEvent` shape — the same pair DR-089 reads. */
export interface ScrollLikeEvent {
  contentOffset?: { y?: number };
  nativeEvent?: { contentOffset?: { y?: number } };
}

/** What to pass as `viewOffset` to leave `topClearance` px of chrome above the landing.
 *
 *  The sign is the trap. VirtualizedList computes `offset = max(0, cellOffset - viewPosition *
 *  (visibleLength - frame.length)) - viewOffset`, so a POSITIVE viewOffset scrolls to a SMALLER
 *  offset — and under `inverted` (a scaleY(-1)) a smaller offset moves content UP the screen,
 *  i.e. further behind the header. Clearing chrome at the visual top therefore needs a NEGATIVE
 *  viewOffset, the opposite of the same request on an upright list.
 *
 *  `|| 0` keeps a bare zero out of the `-0` the negation would otherwise produce: it reads
 *  identically but is not `Object.is`-equal, which quietly costs an afternoon in a test. */
export function landingViewOffset(topClearance: number) {
  return -topClearance || 0;
}

/** Does a viewability report spanning rows `bottom`…`top` describe a landing on `index`?
 *
 *  Not equality, once chrome is being cleared. The landing deliberately leaves `topClearance`
 *  px above the target, and that band is filled by WHATEVER fits in it — which on this screen
 *  is routinely two rows, since the message above an assistant response is the one-line user
 *  turn that prompted it, and `itemVisiblePercentThreshold: 1` reports a 4% sliver of the
 *  response above THAT as viewable too. So the reported top row is `index + k` for a k this
 *  hook cannot compute, and `index + 1` is a guess, not a bound.
 *
 *  What can be checked is the shape a landing leaves behind: the target is on screen, and
 *  everything above it in the report is OLDER than it. Getting this too narrow does not fail
 *  loudly — it means no jump ever registers as having arrived, which leaves `pendingTopRef`
 *  set forever and silently disables the retirement below, bringing back the stale-landmark
 *  teleport that PR #467's review round added it to prevent. */
function describesLanding(top: number, bottom: number, index: number, topClearance: number) {
  if (top === index) return true;
  if (topClearance <= 0) return false;
  return top > index && bottom <= index;
}

export function useChatNavigator({
  listRef,
  count,
  animated = true,
  topClearance = 0,
}: {
  listRef: { current: ScrollableMessageList | null };
  count: number;
  /** False under the OS reduce-motion preference: the jump still happens, without the travel. */
  animated?: boolean;
  /** Px of overlay chrome at the top of the viewport that a landing must sit clear of. */
  topClearance?: number;
}) {
  const landmarkRef = useRef<number | null>(null);
  const topIndexRef = useRef<number | null>(null);
  const countRef = useRef(count);
  const retryRef = useRef<{ index: number; attempts: number } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The top row a jump of ours is travelling toward, or null once it has arrived. */
  const pendingTopRef = useRef<number | null>(null);
  // Held in a ref, not a dependency. The header is measured after first paint, so this value
  // changes once, early — and `onViewableItemsChanged` may never change identity (FlatList's
  // requirement) while the rest travel in `listProps`, which is cheapest left alone.
  const clearanceRef = useRef(topClearance);
  clearanceRef.current = topClearance;
  // Mirrored for the same reason: the snap below runs from a timer and a ref-stable scroll
  // handler, and the OS reduce-motion preference resolves a moment after mount.
  const animatedRef = useRef(animated);
  animatedRef.current = animated;
  /** Last scroll offset the list reported. 0 is the live edge (the list is inverted). */
  const offsetRef = useRef(0);
  /** Set while an index landing may still need correcting back to the live edge. */
  const snapArmedRef = useRef(false);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    // Same reasoning for the live-edge correction: it was armed for a landing in the old array,
    // and a new message moves the live edge itself.
    snapArmedRef.current = false;
    if (snapTimer.current) {
      clearTimeout(snapTimer.current);
      snapTimer.current = null;
    }
  }

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (snapTimer.current) clearTimeout(snapTimer.current);
  }, []);

  const cancelSnap = useCallback(() => {
    snapArmedRef.current = false;
    if (snapTimer.current) {
      clearTimeout(snapTimer.current);
      snapTimer.current = null;
    }
  }, []);

  const cancelRetry = useCallback(() => {
    retryRef.current = null;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  // The correction for a landing that CLAMPED at the live edge.
  //
  // `scrollToIndex` clamps its computed offset at 0 BEFORE subtracting viewOffset — the max()
  // in VirtualizedList sits inside — so when the target and everything newer than it already
  // fit on one screen, the list issues our clearance ON TOP of a landing that was already at
  // the live edge. The thread then parks `topClearance` px short of the bottom and the newest
  // message's tail disappears behind the floating composer: the very chrome Kamil asked us to
  // respect in the same breath as the header.
  //
  // The test is exact about WHETHER the clamp bound. The list issues `max(0, natural) +
  // clearance`, so a SETTLED offset at or below the clearance can only mean `natural <= 0`;
  // and it never fires on a landing that did not clamp, because the list's visual-top padding
  // IS `topClearance`, which makes `natural + clearance <= maxOffset` for every row — so a
  // `natural > 0` landing always settles strictly above the band and cannot be truncated into
  // it by the content end. (That property depends on the padding and the clearance staying the
  // same number; `discussion-layout.test.ts` is what keeps them so.)
  //
  // It is APPROXIMATE about where to land, in one band. When `-clearance < natural <= 0` the
  // ideal landing is `natural + clearance`, part-way, but the settled offset is `clearance` in
  // that case too — indistinguishable from a full clamp with nothing to tell them apart. The
  // correction goes to the live edge, which is what the un-cleared list did there anyway, so
  // this restores base behaviour rather than regressing it. Do not read "exact" as "pixel
  // perfect in every case".
  //
  // Settled matters: mid-travel the offset passes through the band on any jump away from the
  // bottom, which is why this runs on a quiet period after the last scroll event rather than on
  // a fixed delay. One residual race, named rather than fixed: both the forwarded scroll events
  // and this timer run on the JS thread, so a >160 ms stall right after an in-band frame (this
  // surface stalls exactly there — DR-100/DR-101) can let the timer win and snap a reader out
  // of their own upward jump. Requiring two consecutive in-band samples is the obvious
  // hardening and is WRONG: a jump landing on the band from ABOVE reports it once, at the end,
  // so the guard would silently disable the correction for every downward jump — the P1 this
  // exists for. One recoverable tap, against re-breaking the common case.
  const scheduleSnapCheck = useCallback(() => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => {
      snapTimer.current = null;
      if (!snapArmedRef.current) return;
      snapArmedRef.current = false;
      if (offsetRef.current > 0 && offsetRef.current <= clearanceRef.current) {
        listRef.current?.scrollToOffset({ offset: 0, animated: animatedRef.current });
      }
    }, SETTLE_QUIET_MS);
  }, [listRef]);

  /** Every scroll event, ours and the reader's. Only records where the list is — the landmark
   *  is never inferred from an offset (DR-089: there is no synchronous ground truth to compare
   *  one against under the inverted transform). */
  const onScroll = useCallback((event: ScrollLikeEvent) => {
    const y = event?.contentOffset?.y ?? event?.nativeEvent?.contentOffset?.y;
    if (typeof y !== 'number') return;
    offsetRef.current = y;
    if (snapArmedRef.current) scheduleSnapCheck();
  }, [scheduleSnapCheck]);

  const scrollTo = useCallback(
    (target: NavTarget) => {
      const list = listRef.current;
      if (!list) return;
      cancelRetry();
      cancelSnap();
      if (target.kind === 'live') list.scrollToOffset({ offset: 0, animated });
      else {
        // DR-127 — "start of thread" is just the LAST ROW, landed the way every other row is.
        // It used to have its own primitive; see the note at the top of this file for why that
        // primitive can never clear the header.
        const index = target.kind === 'oldest' ? countRef.current - 1 : target.index;
        if (index < 0) return;                    // an empty thread has no row to aim at
        list.scrollToIndex({
          index,
          viewPosition: CHAT_NAV_VIEW_POSITION,
          viewOffset: landingViewOffset(clearanceRef.current),
          animated,
        });
        // Only an index landing can clamp at the live edge with the clearance added on top —
        // and only one that is not the OLDEST row. That row's natural landing is <= 0 only when
        // the whole thread fits above the fold, and there the clamp already gives the right
        // answer: the list's maximum offset is `natural + clearance` exactly (its visual-top
        // padding IS the clearance), so the native clamp lands the oldest top the full
        // clearance below the header. Correcting THAT to the live edge would eat into the very
        // clearance the reader asked for, in the one direction that cannot be what they meant.
        // That equality also assumes no `ListFooterComponent` — the chat library maps the
        // INVERTED list's footer to its load-earlier block, which this screen never enables. Turn
        // that on and the maximum grows by the footer, so this row's landing could clamp short
        // and would want the correction back.
        if (clearanceRef.current > 0 && index < countRef.current - 1) {
          snapArmedRef.current = true;
          scheduleSnapCheck();
        }
      }
      landmarkRef.current = landmarkAfter(target, countRef.current);
      // What the viewport's top row should become once this scroll lands. Until a report
      // matches it, incoming reports are this scroll TRAVELLING, not evidence the reader moved
      // on their own — which is the distinction that makes the retirement below safe.
      pendingTopRef.current = target.kind === 'live' ? null : landmarkRef.current;
    },
    [animated, cancelRetry, cancelSnap, listRef, scheduleSnapCheck],
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

  // The bespoke re-aim this used to carry is gone with the bespoke primitive: an index target
  // reports its own failure, so the shared bounded re-aim in `onScrollToIndexFailed` now covers
  // the extreme too — and unlike the old one it finishes on an EXACT landing rather than a
  // second estimate.
  const goOldest = useCallback(() => scrollTo({ kind: 'oldest' }), [scrollTo]);

  const goLive = useCallback(() => scrollTo({ kind: 'live' }), [scrollTo]);
  const goToIndex = useCallback((index: number) => {
    if (index < 0 || index >= countRef.current) return;
    scrollTo({ kind: 'index', index });
  }, [scrollTo]);

  // Ref-stable: FlatList requires the viewability pair's identity never to change, and this
  // one is composed with DR-100's first-paint listener at the call site.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let top: number | null = null;
    let bottom: number | null = null;
    for (const token of viewableItems) {
      if (typeof token.index !== 'number') continue;
      if (top === null || token.index > top) top = token.index;
      if (bottom === null || token.index < bottom) bottom = token.index;
    }
    if (top === null || bottom === null) return;
    // NOTE this is the row at the viewport's top EDGE, which with an overlay header is the row
    // hidden BEHIND the title rather than the first one the reader can read. `stepUp` aims here
    // when it has no landmark, so after a hand-scroll it can start one message further back
    // than "the message you are inside". Pre-existing (the header predates the rail) and not
    // fixable from viewability alone, which carries no geometry — recorded so the next reader
    // does not mistake it for the clearance below.
    topIndexRef.current = top;
    if (pendingTopRef.current !== null) {
      // A jump of ours is still travelling. Reports along the way name rows we are passing,
      // not where the reader chose to be, so nothing is concluded from them until one matches.
      if (describesLanding(top, bottom, pendingTopRef.current, clearanceRef.current)) {
        pendingTopRef.current = null;
      }
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
        && !describesLanding(top, bottom, landmarkRef.current, clearanceRef.current)) {
      landmarkRef.current = null;
      // NOT the queued re-aim, though — unlike a drag, this branch is reachable from our OWN
      // movement. An approximate landing that OVERSHOOTS reports arrival first and then, as the
      // travel continues past the target, a report whose bottom row is newer than it: a
      // retirement, raised by the very inaccuracy the re-aim exists to correct. Cancelling here
      // would strand the reader on the overshoot. (DR-115 did cancel the extreme's own timer
      // here; that timer was a second ESTIMATE, not a correction, so it had nothing to lose.)
    }
  }).current;

  /** A finger drag — not one of our jumps — so the remembered landmark no longer describes
   *  where the reader is. */
  const onScrollBeginDrag = useCallback(() => {
    landmarkRef.current = null;
    // The reader is driving now: a correction computed for OUR landing would fight them.
    cancelSnap();
    // Same for a queued re-aim: tapping a landmark and changing your mind within
    // RETRY_DELAY_MS yanked you back out of your own drag — a movement nobody asked for at the
    // moment it happens. DR-115 guarded only "start of thread", which had its own timer; that
    // extreme now shares the index re-aim (DR-127), so the guard belongs on the shared one.
    cancelRetry();
  }, [cancelRetry, cancelSnap]);

  /** `scrollToIndex` can only land exactly on a row the list has already measured, and this
   *  list deliberately renders a tiny window (DR-100). Approximate first so the cells around
   *  the target mount, then aim again — a bounded number of times. */
  const onScrollToIndexFailed = useCallback(
    (info: ScrollToIndexFailedInfo) => {
      const list = listRef.current;
      if (!list) return;
      // Inverted list ⇒ a larger offset moves content DOWN, so the chrome clearance is ADDED
      // here where the exact landing SUBTRACTS it as a viewOffset. Both put the target's top
      // the same distance below the header; this one only gets there approximately.
      //
      // For the OLDEST row, `scrollToEnd` is the better approach: it estimates from the list's
      // own cell metrics — measured where it can, the average only beyond them — rather than
      // from `averageItemLength * index` alone, which on a thread of wildly unequal rows can
      // stop far short. It is only ever an APPROACH here: being blind to the list's visual-top
      // padding is precisely why the landing itself could not be left to it (DR-127), and the
      // re-aim below is what lands.
      if (info.index >= countRef.current - 1) list.scrollToEnd({ animated });
      else {
        list.scrollToOffset({
          offset: Math.max(0, info.averageItemLength * info.index + clearanceRef.current),
          animated,
        });
      }
      const state = retryRef.current?.index === info.index
        ? retryRef.current
        : { index: info.index, attempts: 0 };
      retryRef.current = state;
      if (state.attempts >= MAX_RETRIES) {
        // Out of corrections: the reader is at an APPROXIMATION of the target, not the target.
        // The landmark says otherwise and `pendingTopRef` is still suppressing the retirement
        // that would catch it — so both would go on lying, and the next step would skip
        // messages. Drop them and let the step aim from `topIndex` instead.
        landmarkRef.current = null;
        pendingTopRef.current = null;
        return;
      }
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
          viewOffset: landingViewOffset(clearanceRef.current),
          animated,
        });
      }, RETRY_DELAY_MS);
    },
    [animated, listRef],
  );

  return {
    goUp,
    goDown,
    goOldest,
    goLive,
    goToIndex,
    onScroll,
    onViewableItemsChanged,
    onScrollBeginDrag,
    onScrollToIndexFailed,
  };
}
