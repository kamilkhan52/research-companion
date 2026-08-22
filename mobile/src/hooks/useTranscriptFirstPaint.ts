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
