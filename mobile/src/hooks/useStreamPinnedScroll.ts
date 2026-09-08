// DR-089 — keep the transcript still while the reader has scrolled up during a streaming
// turn, by PAUSING THE REVEAL rather than chasing the viewport.
//
// The transcript is an inverted FlatList whose newest item grows as text streams in. Every
// corrective approach tried against that growth lost on the emulator:
//   - `maintainVisibleContentPosition` alone: the viewport still slid ~80 px/s while
//     scrolled up (and its own adjustments overshoot — RN's anchor math does not survive
//     the inverted transform on Android).
//   - An explicit scrollToOffset-by-growth guard: fought the reader's momentum flings, and
//     with mVCP active double-corrected; with mVCP removed it still drifted, because each
//     correction is computed from an offset the platform may not have applied yet — there
//     is no synchronous ground truth to correct against.
// The stable fix: while the reader is away from the live edge, the streamed message simply
// stops growing on screen (useSmoothText holds its reveal; the arriving text banks in the
// buffer). Nothing grows ⇒ nothing can drift — deterministically. Scrolling back within the
// follow threshold (or tapping scroll-to-bottom) resumes the reveal, which catches up
// smoothly and, after a long read, jump-cuts near live via the reveal's existing MAX_LAG.
// The server-side transcript is untouched; only presentation timing changes.
//
// `away` is derived from the scroll events the chat library forwards to `listProps.
// onScroll` — NOTE these arrive in reanimated's event shape (top-level `contentOffset`),
// not the RN `nativeEvent` shape, so both are read.

import { createContext, useCallback, useContext, useState } from 'react';

/** Matches the library's own scrollToBottomOffset default (200): within it the reader is
 *  "following" and the reveal runs; beyond it they are reading history and it holds. */
export const PIN_FOLLOW_THRESHOLD = 200;

/** Either shape the list can hand us: reanimated's flattened payload on the JS thread, or a
 *  plain RN synthetic event. `layoutMeasurement` is the viewport, which DR-151 measures a seek
 *  against; it is optional because neither shape guarantees it. */
type ScrollLikeEvent = {
  contentOffset?: { y?: number };
  layoutMeasurement?: { height?: number };
  nativeEvent?: {
    contentOffset?: { y?: number };
    layoutMeasurement?: { height?: number };
  };
};

/** True while the streamed reveal should hold still (reader away from the live edge during
 *  a streaming turn). Consumed by SmoothMarkdown; provided by DiscussionThread. */
export const RevealPausedContext = createContext(false);

export function useRevealPaused(): boolean {
  return useContext(RevealPausedContext);
}

/** Tracks whether the reader has scrolled beyond `threshold` from the inverted list's live
 *  edge (offset 0 = newest). State, not a ref: crossing the threshold must re-render the
 *  provider so the paused flag reaches the streaming message. */
export function useReaderAwayFromLive(threshold: number = PIN_FOLLOW_THRESHOLD) {
  const [away, setAway] = useState(false);

  const onScroll = useCallback(
    (event: ScrollLikeEvent) => {
      const y = event?.contentOffset?.y ?? event?.nativeEvent?.contentOffset?.y;
      if (typeof y !== 'number') return;
      setAway(y > threshold);
    },
    [threshold],
  );

  return { away, onScroll };
}
