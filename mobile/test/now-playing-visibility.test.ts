import { shouldShowStackNowPlaying } from '@/lib/nowPlayingVisibility';
import { TAB_META } from '@/app/(tabs)/_layout';

test('the bottom bar has exactly the three combined-surface destinations', () => {
  expect(Object.fromEntries(Object.entries(TAB_META).map(([key, value]) => [key, value.label])))
    .toEqual({ index: 'Library', notes: 'Notes', graph: 'Map' });
});

test('the root mini-player yields to the full player and returns on other stack screens', () => {
  expect(shouldShowStackNowPlaying('/player')).toBe(false);
  expect(shouldShowStackNowPlaying('/paper/awq')).toBe(true);
  expect(shouldShowStackNowPlaying('/settings')).toBe(true);
});

test('tab screens keep using the tab-bar mini-player instead of the root copy', () => {
  // /discover remains a hidden tab-owned redirect so saved links do not flash a second player
  // before landing on Map.
  for (const path of ['/', '/discover', '/notes', '/graph']) {
    expect(shouldShowStackNowPlaying(path)).toBe(false);
  }
});
