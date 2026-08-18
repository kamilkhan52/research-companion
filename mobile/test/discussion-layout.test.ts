import { discussionChromeLayout } from '@/components/chat/discussionLayout';

test('overlay chrome clears both ends without double-counting the header for the keyboard', () => {
  expect(discussionChromeLayout({
    topInset: 34,
    headerHeight: 68,
    composerHeight: 84,
    headerOverlays: true,
    listGap: 8,
    headerGap: 24,
  })).toEqual({
    keyboardVerticalOffset: 34,
    // Inverted list: paddingTop is the visual composer edge; paddingBottom is the visual header.
    listContentPadding: { paddingTop: 92, paddingBottom: 92 },
    scrollButtonBottom: 92,
  });
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
  });
});
