// DR-100 — hold the discussion skeleton over the transcript until the list has actually
// painted a message, instead of dropping it the moment session DATA arrives.
//
// Measured on the emulator (HBF thread, cold caches): the session response returns in ~10ms,
// but the inverted list's first commit takes seconds — a single huge assistant message
// (hundreds of Markdown blocks, dozens of TeX→SVG equations) is one uninterruptible mount on
// the JS thread. Between "data arrived" and "first frame committed" the reader stared at a
// BLANK surface. List tuning (initialNumToRender etc.) cut the total from ~4.7s to ~2.5s but
// cannot shrink that one dominant item, so the honest fix for perception is to keep the
// skeleton mounted until the list itself says a message is visible.
//
// The "painted" signal is onViewableItemsChanged with a non-empty viewable set — NOT
// onContentSizeChange, because the list's padded contentContainer reports height > 0 even
// before any item has mounted, which would tear the skeleton down onto the very blank it
// exists to cover. A hard timeout is the backstop so a render failure can never strand a
// pulsing skeleton forever. Both callbacks are ref-stable: FlatList requires the viewability
// pair's identity to never change across renders.

import { useEffect, useRef, useState } from 'react';
import type { ViewabilityConfig, ViewToken } from 'react-native';

/** If no item reports viewable by then, show the transcript anyway — a stuck skeleton is
 *  worse than a slow paint, and the ceiling only fires when something is already wrong. */
export const FIRST_PAINT_CEILING_MS = 6000;

/** DR-101 — mount the heavy transcript one beat AFTER the skeleton has committed.
 *
 *  The overlay skeleton and the transcript used to mount in the SAME commit, so the
 *  skeleton's pulse (an Animated.loop started from a mount effect) could not begin until
 *  that multi-second commit finished — which is exactly when the overlay is torn down. The
 *  reader saw a frozen skeleton (logcat: the reduce-motion resolve and the loop start both
 *  queued behind the blocked JS thread). Deferring the transcript by two frames commits the
 *  skeleton alone (milliseconds), lets its native-driver pulse start on the UI thread —
 *  where it keeps running while JS is busy — and only then pays for the big mount. */
export function useDeferredFirstMount(defer: boolean): boolean {
  const [mounted, setMounted] = useState(!defer);
  useEffect(() => {
    if (mounted) return;
    let second = 0;
    // Frame 1 paints the skeleton; frame 2 gives its animation loop a started frame.
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setMounted(true));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return mounted;
}

export function useTranscriptFirstPaint(hasContent: boolean) {
  // An empty transcript has nothing to wait for — painted from the start. `hasContent` is
  // read once: this hook models the INITIAL mount, and a later transcript change must not
  // resurrect the overlay over an already-live surface.
  const [painted, setPainted] = useState(!hasContent);

  useEffect(() => {
    if (painted) return;
    const ceiling = setTimeout(() => setPainted(true), FIRST_PAINT_CEILING_MS);
    return () => clearTimeout(ceiling);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const viewabilityRef = useRef({
    viewabilityConfig: { itemVisiblePercentThreshold: 1 } satisfies ViewabilityConfig,
    onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0) setPainted(true);
    },
  });

  return {
    painted,
    viewabilityConfig: viewabilityRef.current.viewabilityConfig,
    onViewableItemsChanged: viewabilityRef.current.onViewableItemsChanged,
  };
}
