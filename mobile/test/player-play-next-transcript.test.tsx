// DR-156 — TrackPlayer owns the playback identity. The full player used to choose its
// transcript from AudioProvider.currentId instead, so a Play-next skip could move the native
// player first and leave the old response's words on screen indefinitely.

import { renderAsync, screen } from '@testing-library/react-native';
import {
  useActiveTrack,
  useIsPlaying,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player';

import PlayerScreen from '@/app/player';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn() }),
}));

const mockAudio = {
  currentId: 'project:paper:0#cold',
  narrationById: {
    'project:paper:0#cold': 'Words from the previous response.',
    'project:paper:1#cnew': 'Words from the active response.',
  },
  prep: null,
  playlistAutoplay: false,
  setPlaylistAutoplay: jest.fn(),
  playNextResponse: jest.fn(async () => true),
  cancelPrep: jest.fn(),
};

jest.mock('@/audio/AudioProvider', () => ({
  useAudio: () => mockAudio,
}));

jest.mock('@/store/listening', () => ({
  useListeningMode: () => ({
    listeningMode: true,
    narrationFace: 'serif',
    narrationTextScale: 1,
  }),
  narrationTextStyle: () => ({ fontSize: 19, lineHeight: 29 }),
}));

jest.mock('@/components/player/NarrationSettingsButton', () => ({
  NarrationSettingsButton: () => null,
}));

beforeEach(() => {
  jest.mocked(useActiveTrack).mockReturnValue({
    id: 'native-track-1',
    slotId: 'project:paper:1#cnew',
    title: 'Paper',
    narration: 'Words from the active response.',
  } as never);
  jest.mocked(useIsPlaying).mockReturnValue({
    playing: false,
    bufferingDuringPlay: false,
  } as never);
  jest.mocked(usePlaybackState).mockReturnValue({ state: 'paused' } as never);
  jest.mocked(useProgress).mockReturnValue({ position: 0, duration: 30, buffered: 30 });
});

test('the rolling text follows the active audio when the provider id is still stale', async () => {
  await renderAsync(<PlayerScreen />);

  expect(screen.getByText('Words from the active response.')).toBeTruthy();
  expect(screen.queryByText('Words from the previous response.')).toBeNull();
});
