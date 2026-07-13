import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderAsync, waitFor } from '@testing-library/react-native';
import TrackPlayer, { Event } from 'react-native-track-player';

import { setBaseUrl } from '@/api/config';
import { AudioProvider, useAudio } from '@/audio/AudioProvider';
import { ProjectProvider } from '@/store/project';
import { ListeningProvider } from '@/store/listening';
import {
  clearPlaybackSnapshot,
  PLAYBACK_SNAPSHOT_KEY,
  savePlaybackProgress,
} from '../playback-persistence';

const playbackService = require('../service') as () => Promise<void>;

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ProjectProvider>
      <ListeningProvider>
        <AudioProvider>{children}</AudioProvider>
      </ListeningProvider>
    </ProjectProvider>
  );
}

test('background progress persists a header-free final-audio queue and queue end clears it', async () => {
  jest.mocked(TrackPlayer.getQueue).mockResolvedValue([
    {
      id: 'project-a:paper-a:2',
      slotId: 'project-a:paper-a:2',
      sourceUrl: '/api/audio/final.mp3',
      url: 'https://old.test/api/audio/final.mp3',
      title: 'Paper A',
      narration: 'Spoken answer.',
      headers: { Authorization: 'Bearer secret' },
    },
    { id: 'preview:late', url: 'https://old.test/api/audio/cue.mp3' },
  ] as never);
  await playbackService();
  const registrations = jest.mocked(TrackPlayer.addEventListener).mock.calls;
  const progress = registrations.find(([event]) => event === Event.PlaybackProgressUpdated)?.[1];
  const ended = registrations.find(([event]) => event === Event.PlaybackQueueEnded)?.[1];
  expect(progress).toBeDefined();
  expect(ended).toBeDefined();

  await act(async () => {
    await progress?.({ track: 0, position: 42, duration: 120, buffered: 60 } as never);
  });
  await waitFor(() => expect(AsyncStorage.getItem(PLAYBACK_SNAPSHOT_KEY))
    .resolves.not.toBeNull());
  const stored = JSON.parse(await AsyncStorage.getItem(PLAYBACK_SNAPSHOT_KEY) ?? 'null');
  expect(stored).toMatchObject({
    slotId: 'project-a:paper-a:2',
    position: 42,
    duration: 120,
    tracks: [{ id: 'project-a:paper-a:2', sourceUrl: '/api/audio/final.mp3' }],
  });
  expect(JSON.stringify(stored)).not.toContain('secret');
  expect(JSON.stringify(stored)).not.toContain('preview:late');

  await act(async () => { await ended?.({ track: 0, position: 120 } as never); });
  await waitFor(() => expect(AsyncStorage.getItem(PLAYBACK_SNAPSHOT_KEY)).resolves.toBeNull());
});

test('provider restores the stable item and position without autoplay when Listening is off', async () => {
  await setBaseUrl('https://api.test');
  await AsyncStorage.setItem(PLAYBACK_SNAPSHOT_KEY, JSON.stringify({
    version: 1,
    slotId: 'project-a:paper-a:2',
    title: 'Paper A',
    position: 42,
    duration: 120,
    tracks: [{
      id: 'project-a:paper-a:2',
      slotId: 'project-a:paper-a:2',
      sourceUrl: '/api/audio/final.mp3',
      title: 'Paper A',
    }],
  }));
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce(undefined);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([]);
  let currentId: string | null = null;
  function Probe() {
    currentId = useAudio().currentId;
    return null;
  }

  await renderAsync(<Wrapper><Probe /></Wrapper>);

  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledWith([
    expect.objectContaining({
      id: 'project-a:paper-a:2',
      url: 'https://api.test/api/audio/final.mp3',
    }),
  ]));
  expect(TrackPlayer.seekTo).toHaveBeenCalledWith(42);
  expect(TrackPlayer.play).not.toHaveBeenCalled();
  await waitFor(() => expect(currentId).toBe('project-a:paper-a:2'));
});

test('provider always restores paused even when Listening is on', async () => {
  await setBaseUrl('https://api.test');
  await AsyncStorage.setItem('rc.listeningMode', 'true');
  await AsyncStorage.setItem(PLAYBACK_SNAPSHOT_KEY, JSON.stringify({
    version: 1,
    slotId: 'project-a:paper-a:2',
    title: 'Paper A',
    position: 7,
    duration: 120,
    tracks: [{
      id: 'project-a:paper-a:2',
      slotId: 'project-a:paper-a:2',
      sourceUrl: '/api/audio/final.mp3',
      title: 'Paper A',
    }],
  }));
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce(undefined);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([]);

  await renderAsync(<Wrapper><></></Wrapper>);

  await waitFor(() => expect(TrackPlayer.seekTo).toHaveBeenCalledWith(7));
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('queue-end cleanup wins over an in-flight progress write', async () => {
  let releaseQueue!: () => void;
  const queueReady = new Promise<void>((resolve) => { releaseQueue = resolve; });
  jest.mocked(TrackPlayer.getQueue).mockImplementationOnce(async () => {
    await queueReady;
    return [{
      id: 'project-a:paper-a:2',
      slotId: 'project-a:paper-a:2',
      sourceUrl: '/api/audio/final.mp3',
    }] as never;
  });

  const save = savePlaybackProgress(TrackPlayer, { track: 0, position: 10, duration: 100 });
  const clear = clearPlaybackSnapshot();
  releaseQueue();
  await Promise.all([save, clear]);

  await expect(AsyncStorage.getItem(PLAYBACK_SNAPSHOT_KEY)).resolves.toBeNull();
});

test('an existing native track is forced paused and exposed after relaunch', async () => {
  await AsyncStorage.setItem(PLAYBACK_SNAPSHOT_KEY, JSON.stringify({
    version: 1,
    slotId: 'project-a:paper-a:2',
    title: 'Paper A',
    position: 9,
    duration: 120,
    tracks: [{
      id: 'project-a:paper-a:2',
      slotId: 'project-a:paper-a:2',
      sourceUrl: '/api/audio/final.mp3',
      title: 'Paper A',
    }],
  }));
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce({
    id: 'project-a:paper-a:2',
    slotId: 'project-a:paper-a:2',
    title: 'Paper A',
    narration: 'Spoken answer.',
  } as never);
  let audio!: ReturnType<typeof useAudio>;
  function Probe() {
    audio = useAudio();
    return null;
  }

  await renderAsync(<Wrapper><Probe /></Wrapper>);

  await waitFor(() => expect(TrackPlayer.pause).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(audio.currentId).toBe('project-a:paper-a:2'));
  expect(audio.narrationById['project-a:paper-a:2']).toBe('Spoken answer.');
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});
