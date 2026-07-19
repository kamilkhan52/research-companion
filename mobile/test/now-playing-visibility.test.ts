import { shouldShowStackNowPlaying } from '@/lib/nowPlayingVisibility';

test('the root mini-player yields to the full player and returns on other stack screens', () => {
  expect(shouldShowStackNowPlaying('/player')).toBe(false);
  expect(shouldShowStackNowPlaying('/paper/awq')).toBe(true);
  expect(shouldShowStackNowPlaying('/settings')).toBe(true);
});

test('tab screens keep using the tab-bar mini-player instead of the root copy', () => {
  for (const path of ['/', '/discover', '/notes', '/graph']) {
    expect(shouldShowStackNowPlaying(path)).toBe(false);
  }
});
