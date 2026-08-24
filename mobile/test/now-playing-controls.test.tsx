// DR-103 — Kamil: "Redesign the mini player to include more controls. I think the paper title
// may be made smaller, and controls for next and previous sentence can be added besides the play
// and pause. The paper title in this view is already available at the top."
//
// Sentence jump already existed as `sentence-seek.seekSentence` (the full player's ▮◀/▶▮
// buttons), which estimates sentence boundaries from the narration text and falls back to a
// timed skip — so the mini bar carries the same control rather than a second implementation.

import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { useActiveTrack, useIsPlaying } from 'react-native-track-player';

import { NowPlaying } from '@/components/NowPlaying';

jest.mock('expo-router', () => ({
  router: { navigate: jest.fn() },
  usePathname: () => '/paper/awq',
}));

jest.mock('@/audio/AudioProvider', () => ({
  useAudio: () => ({ prep: null, cancelPrep: jest.fn(), dismiss: jest.fn(async () => undefined) }),
}));

jest.mock('../sentence-seek', () => ({
  seekSentence: jest.fn(async () => 'sentence'),
  SENTENCE_SEEK_PREROLL_SECONDS: 0.75,
}));

const { seekSentence } = jest.requireMock('../sentence-seek') as { seekSentence: jest.Mock };

const TITLE = 'HBF Sucks! A Full-Stack Characterization of High-Bandwidth Flash';

beforeEach(() => {
  seekSentence.mockClear();
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
