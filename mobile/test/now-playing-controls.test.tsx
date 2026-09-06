// DR-103 — Kamil: "Redesign the mini player to include more controls. I think the paper title
// may be made smaller, and controls for next and previous sentence can be added besides the play
// and pause. The paper title in this view is already available at the top."
//
// Sentence jump already existed as `sentence-seek.seekSentence` (the full player's ▮◀/▶▮
// buttons), which estimates sentence boundaries from the narration text and falls back to a
// timed skip — so the mini bar carries the same control rather than a second implementation.

import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import TrackPlayer, { useActiveTrack, useIsPlaying } from 'react-native-track-player';

import { NowPlaying } from '@/components/NowPlaying';

jest.mock('expo-router', () => ({
  router: { navigate: jest.fn() },
  usePathname: () => '/paper/awq',
}));

const mockPublishDiscussionJump = jest.fn();
jest.mock('@/audio/AudioProvider', () => ({
  useAudio: () => ({
    prep: null,
    cancelPrep: jest.fn(),
    dismiss: jest.fn(async () => undefined),
    publishDiscussionJump: mockPublishDiscussionJump,
  }),
}));

let mockFollowNarration = false;
jest.mock('@/store/listening', () => ({
  useListeningMode: () => ({ followNarrationInDiscussion: mockFollowNarration }),
}));

jest.mock('../sentence-seek', () => ({
  ...jest.requireActual('../sentence-seek'),
  seekSentence: jest.fn(async () => 'sentence'),
}));

const { seekSentence } = jest.requireMock('../sentence-seek') as { seekSentence: jest.Mock };
const { router } = jest.requireMock('expo-router') as { router: { navigate: jest.Mock } };

const TITLE = 'HBF Sucks! A Full-Stack Characterization of High-Bandwidth Flash';

beforeEach(() => {
  seekSentence.mockClear();
  seekSentence.mockResolvedValue('sentence');
  mockPublishDiscussionJump.mockClear();
  router.navigate.mockClear();
  mockFollowNarration = false;
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue(undefined);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValue([]);
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 0, duration: 0, buffered: 0 });
  jest.mocked(useActiveTrack).mockReturnValue({ title: TITLE } as never);
  jest.mocked(useIsPlaying).mockReturnValue({ playing: true, bufferingDuringPlay: false } as never);
});

afterEach(() => {
  jest.mocked(useActiveTrack).mockReset();
  jest.mocked(useIsPlaying).mockReset();
});

test('a loaded track offers previous/next sentence beside play/pause', async () => {
  await renderAsync(<NowPlaying inset={false} />);

  await fireEventAsync.press(screen.getByLabelText('Previous sentence'));
  expect(seekSentence).toHaveBeenCalledWith(expect.anything(), -1, expect.any(Number));

  await fireEventAsync.press(screen.getByLabelText('Next sentence'));
  expect(seekSentence).toHaveBeenCalledWith(expect.anything(), 1, expect.any(Number));

  // Play/pause stays where it was — the sentence jumps are additions, not replacements.
  expect(screen.getByLabelText('Pause')).toBeTruthy();
});

test('the title gives up size to make room, since the top bar already carries it', async () => {
  await renderAsync(<NowPlaying inset={false} />);
  const title = screen.getByText(TITLE);
  const style = StyleSheet.flatten(title.props.style) as { fontSize?: number };
  expect(style.fontSize).toBeLessThan(15); // was 15/semibold before DR-103
});

test('with nothing loaded there is no sentence to jump to', async () => {
  // The preparing card (no track yet) must not offer seek controls for audio that does not
  // exist; `now-playing-keyboard.test.tsx` covers the rest of that state's shape.
  jest.mocked(useActiveTrack).mockReturnValue(undefined as never);
  await renderAsync(<NowPlaying inset={false} />);
  expect(screen.queryByLabelText('Next sentence')).toBeNull();
  expect(screen.queryByTestId('now-playing-wrap')).toBeNull();  // no prep either
});

test('a sentence jump publishes the post-seek semantic target and opens its exact Discussion', async () => {
  mockFollowNarration = true;
  const slotId = 'project-a:paper-a--abcdef123456:2#ctag';
  const narration = 'First sentence. Second sentence. Third sentence.';
  // The render hook can still describe the old track. The imperative read after the awaited
  // seek is the other side of the contract and must win.
  jest.mocked(useActiveTrack).mockReturnValue({ title: 'Old paper' } as never);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({
    id: 'full-track',
    slotId,
    narration,
  } as never);
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
    // The player deliberately pre-rolls 0.75 s before the second boundary (10 s). The explicit
    // resolver steps just past it, so Discussion highlights sentence 2 immediately.
    position: 9.25,
    duration: 30,
    buffered: 30,
  });
  await renderAsync(<NowPlaying inset={false} />);

  await fireEventAsync.press(screen.getByLabelText('Next sentence'));
  // The explicit 0.8 s resolver crosses the requested boundary, while the passive 0.35 s
  // resolver remains on the pre-roll sentence. Both come from the same post-seek progress.
  expect(mockPublishDiscussionJump).toHaveBeenCalledWith(slotId, 1, 0);
  expect(router.navigate).toHaveBeenCalledWith({
    pathname: '/paper/[slug]',
    params: { slug: 'paper-a', project: 'project-a', thread: 'abcdef123456' },
  });
});

test('a progressive track jump uses the new segment start even while progress is still zero', async () => {
  mockFollowNarration = true;
  seekSentence.mockResolvedValueOnce('track');
  const slotId = 'project-a:paper-a:2#ctag';
  const narration = 'First sentence. Second sentence. Third sentence.';
  jest.mocked(useActiveTrack).mockReturnValue({ id: 'segment-0', title: TITLE } as never);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({
    id: 'segment-1',
    slotId,
    narration,
    segmentIndex: 1,
    sentenceText: 'Third sentence.',
  } as never);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValue([
    {
      id: 'other-segment-0',
      slotId: 'project-a:other-paper:0#ctag',
      segmentIndex: 0,
      sentenceText: 'Unrelated queued narration whose length must not shift this slot.',
    },
    { id: 'segment-0', slotId, segmentIndex: 0, sentenceText: 'First sentence. Second sentence.' },
    { id: 'segment-1', slotId, segmentIndex: 1, sentenceText: 'Third sentence.' },
  ] as never);
  // This is the stale/empty progress value that previously made the jump disappear.
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 0, duration: 0, buffered: 0 });
  await renderAsync(<NowPlaying inset={false} />);

  await fireEventAsync.press(screen.getByLabelText('Next sentence'));
  expect(mockPublishDiscussionJump).toHaveBeenCalledWith(slotId, 2, 2);
  expect(router.navigate).toHaveBeenCalledWith({
    pathname: '/paper/[slug]',
    params: { slug: 'paper-a', project: 'project-a', thread: 'main' },
  });
});

test('the off setting and legacy ids seek without forcing Discussion navigation', async () => {
  const render = await renderAsync(<NowPlaying inset={false} />);
  await fireEventAsync.press(screen.getByLabelText('Next sentence'));
  expect(seekSentence).toHaveBeenCalledTimes(1);
  expect(mockPublishDiscussionJump).not.toHaveBeenCalled();
  expect(router.navigate).not.toHaveBeenCalled();

  await render.unmountAsync();
  seekSentence.mockClear();
  mockFollowNarration = true;
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({
    id: 'project-a:paper-a:2',
    narration: 'Only sentence.',
  } as never);
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
    position: 1,
    duration: 10,
    buffered: 10,
  });
  await renderAsync(<NowPlaying inset={false} />);
  await fireEventAsync.press(screen.getByLabelText('Next sentence'));
  expect(seekSentence).toHaveBeenCalledTimes(1);
  expect(mockPublishDiscussionJump).not.toHaveBeenCalled();
  expect(router.navigate).not.toHaveBeenCalled();
});
