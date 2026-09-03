import {
  discussionChromeLayout,
  discussionComposerPadding,
} from '@/components/chat/discussionLayout';

test('the floating composer exposes transcript at its sides and beneath the pill', () => {
  expect(discussionComposerPadding(24)).toEqual({
    paddingHorizontal: 36,
    paddingBottom: 40,
  });
});

test('overlay chrome clears both ends without double-counting the header for the keyboard', () => {
  expect(discussionChromeLayout({
    topInset: 34,
    headerHeight: 68,
    composerHeight: 84,
    headerOverlays: true,
    listGap: 8,
    headerGap: 24,
  })).toEqual({
    keyboardVerticalOffset: 0,
    // Inverted list: paddingTop is the visual composer edge; paddingBottom is the visual header.
    listContentPadding: { paddingTop: 92, paddingBottom: 92 },
    scrollButtonBottom: 92,
    topClearance: 92,
    bottomFadeHeight: 156,
    bottomFadeTransparentInset: 64,
  });
});

test('a landmark jump clears the same header the oldest message already clears', () => {
  // DR-115 round 2. The list's visual-top padding is what keeps the oldest message out from
  // under the floating title; `topClearance` is that same distance, handed to the navigation
  // rail so every OTHER landing matches it. If they ever drift apart, "start of thread" and
  // "one message up" stop landing the same way — which is the report this exists to answer.
  const layout = discussionChromeLayout({
    topInset: 34,
    headerHeight: 68,
    composerHeight: 84,
    headerOverlays: true,
    listGap: 8,
    headerGap: 24,
  });
  expect(layout.topClearance).toBe(layout.listContentPadding.paddingBottom);
});

test('an in-flow header remains part of the keyboard offset', () => {
  expect(discussionChromeLayout({
    topInset: 34,
    headerHeight: 68,
    composerHeight: 84,
    headerOverlays: false,
    listGap: 8,
    headerGap: 24,
  })).toEqual({
    keyboardVerticalOffset: 102,
    listContentPadding: { paddingTop: 92, paddingBottom: 8 },
    scrollButtonBottom: 92,
    // Nothing floats over the transcript, so a jump has no chrome to clear.
    topClearance: 0,
    bottomFadeHeight: 156,
    bottomFadeTransparentInset: 64,
  });
});

test('the bottom scrim remains transparent through the newest-item clearance', () => {
  const layout = discussionChromeLayout({
    topInset: 34,
    headerHeight: 68,
    composerHeight: 84,
    headerOverlays: true,
    listGap: 8,
    headerGap: 24,
  });

  expect(
    layout.listContentPadding.paddingTop + layout.bottomFadeTransparentInset,
  ).toBe(layout.bottomFadeHeight);
  expect(layout.scrollButtonBottom + layout.bottomFadeTransparentInset).toBe(
    layout.bottomFadeHeight,
  );
});
