export interface DiscussionChromeLayoutInput {
  topInset: number;
  headerHeight: number;
  composerHeight: number;
  headerOverlays: boolean;
  listGap: number;
  headerGap: number;
}

/** Extra room above the composer reserved for the bottom-edge fade. The fade stays fully
 * transparent through the part not covered by list padding, then ramps behind the composer. */
export const DISCUSSION_BOTTOM_FADE_EXTENSION = 72;

/** ChatGPT-style breathing room around the floating composer. The side inset deliberately
 * exposes the transcript on both sides; the bottom lift leaves a detectable strip beneath it. */
export const DISCUSSION_COMPOSER_SIDE_INSET = 36;
export const DISCUSSION_COMPOSER_BOTTOM_LIFT = 16;

export function discussionComposerPadding(bottomInset: number) {
  return {
    paddingHorizontal: DISCUSSION_COMPOSER_SIDE_INSET,
    paddingBottom: bottomInset + DISCUSSION_COMPOSER_BOTTOM_LIFT,
  };
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
  const bottomFadeHeight = composerHeight + DISCUSSION_BOTTOM_FADE_EXTENSION;
  return {
    // KeyboardAvoidingView measures its frame relative to its parent. With overlay chrome the
    // Chat frame begins at the screen origin, so adding the status inset would over-translate it.
    // The ordinary in-flow screen starts below both the safe area and header, so it needs both.
    keyboardVerticalOffset: headerOverlays ? 0 : topInset + headerHeight,
    listContentPadding: {
      paddingTop: composerClearance,
      paddingBottom: headerOverlays ? headerHeight + headerGap : listGap,
    },
    scrollButtonBottom: composerClearance,
    bottomFadeHeight,
    // The newest item and scroll control sit `composerClearance` above the screen bottom. Keep
    // the scrim transparent up to that exact boundary; only the region below it should ramp.
    bottomFadeTransparentInset: bottomFadeHeight - composerClearance,
  };
}
