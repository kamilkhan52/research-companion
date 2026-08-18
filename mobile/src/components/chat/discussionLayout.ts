export interface DiscussionChromeLayoutInput {
  topInset: number;
  headerHeight: number;
  composerHeight: number;
  headerOverlays: boolean;
  listGap: number;
  headerGap: number;
}

/**
 * Geometry shared by the inverted transcript, keyboard avoidance, and scroll-to-latest button.
 *
 * In the chat library's inverted list, paddingTop is the visual bottom and paddingBottom is the
 * visual top. Keeping all three consumers in one calculation prevents a chrome change from
 * clearing the composer while accidentally hiding the oldest message (or vice versa).
 */
export function discussionChromeLayout({
  topInset,
  headerHeight,
  composerHeight,
  headerOverlays,
  listGap,
  headerGap,
}: DiscussionChromeLayoutInput) {
  const composerClearance = composerHeight + listGap;
  return {
    // The safe area always belongs to the library's keyboard model. An in-flow header consumes
    // additional height; an overlay header does not.
    keyboardVerticalOffset: topInset + (headerOverlays ? 0 : headerHeight),
    listContentPadding: {
      paddingTop: composerClearance,
      paddingBottom: headerOverlays ? headerHeight + headerGap : listGap,
    },
    scrollButtonBottom: composerClearance,
  };
}
