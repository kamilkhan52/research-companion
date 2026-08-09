import { act, renderAsync, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer, { Event, useTrackPlayerEvents } from 'react-native-track-player';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { AudioJob } from '@/api/types';
import { AudioProvider, useAudio } from '@/audio/AudioProvider';
import { messageAudioId } from '@/audio/identity';
import { ListeningProvider } from '@/store/listening';
import { ProjectProvider } from '@/store/project';

test('manual Play next is always allowed while automatic queue-end advance is toggle-gated', async () => {
  await AsyncStorage.setItem('rc.listeningMode', 'true');
  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );

  const current = messageAudioId('project-a', 'paper-a', 1, 'Current response.');
  const next = messageAudioId('project-a', 'paper-a', 2, 'Next response.');
  jest.mocked(TrackPlayer.getQueue).mockResolvedValue([
    { id: current, slotId: current, url: 'current.mp3' },
    { id: next, slotId: next, url: 'next.mp3' },
  ] as never);
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({ id: current, slotId: current } as never);

  await act(async () => {
    expect(await audio.playNextResponse()).toBe(true);
  });
  expect(TrackPlayer.skip).toHaveBeenCalledWith(1);

  jest.mocked(TrackPlayer.skip).mockClear();
  const endedHandler = jest.mocked(useTrackPlayerEvents).mock.calls
    .find(([events]) => events.includes(Event.PlaybackQueueEnded))?.[1] as
      ((event: { track: number; position: number }) => void) | undefined;
  expect(endedHandler).toBeDefined();

  await act(async () => {
    endedHandler?.({ track: 0, position: 120 });
    await Promise.resolve();
  });
  expect(audio.playlistAutoplay).toBe(false);
  expect(TrackPlayer.skip).not.toHaveBeenCalled();

  act(() => audio.setPlaylistAutoplay(true));
  expect(audio.playlistAutoplay).toBe(true);
  act(() => endedHandler?.({ track: 0, position: 120 }));
  await waitFor(() => expect(TrackPlayer.skip).toHaveBeenCalledWith(1));
});

test('queue exhaustion prepares the next existing response through the billed job queue', async () => {
  await AsyncStorage.setItem('rc.listeningMode', 'true');
  await setBaseUrl('https://api.test');
  const current = messageAudioId('project-a', 'paper-a', 0, 'Current response.');
  const nextEntry = {
    role: 'assistant' as const,
    canonical: 'Next existing response.',
    narration: '',
    state_signal: '',
    proposed_commit: null,
    assistant_index: 1,
    delivery_mode: 'reading' as const,
    chat_job_id: null,
    audio_job_id: null,
    audio_error: null,
  };
  const doneJob: AudioJob = {
    id: 'playlist-audio-job',
    status: 'done',
    stage: 'synthesizing',
    segments_done: 1,
    segments_total: 1,
    narration: 'Spoken next response.',
    url: '/api/audio/next.mp3',
    segments: [],
    timings: {},
    error: null,
    started_at: '2026-07-22T00:00:00Z',
    finished_at: '2026-07-22T00:00:01Z',
  };
  jest.mocked(api.getSession).mockResolvedValueOnce({
    paper: { title: 'Paper A' },
    transcript: [nextEntry],
  } as never);
  jest.mocked(api.startAudioJob).mockResolvedValueOnce({ job: doneJob });
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: doneJob });

  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  jest.mocked(TrackPlayer.getQueue).mockResolvedValue([
    { id: current, slotId: current, url: 'current.mp3' },
  ] as never);
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({ id: current, slotId: current } as never);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: 'ended' } as never);

  await act(async () => {
    expect(await audio.playNextResponse()).toBe(true);
  });
  expect(api.getSession).toHaveBeenCalledWith('project-a', 'paper-a', 'main');
  expect(api.startAudioJob).toHaveBeenCalledWith('Next existing response.', 'project-a');
  await waitFor(() => expect(api.getAudioJob).toHaveBeenCalledWith('playlist-audio-job'));
  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({
    id: messageAudioId('project-a', 'paper-a', 1, 'Next existing response.'),
    title: 'Paper A',
  })));
  expect(TrackPlayer.skip).toHaveBeenCalledWith(1);
});
