import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Pressable } from 'react-native';
import TrackPlayer, { State } from 'react-native-track-player';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { AudioJob } from '@/api/types';
import { AudioProvider, useAudio } from '@/audio/AudioProvider';
import { ProjectProvider } from '@/store/project';

const doneJob: AudioJob = {
  id: 'audio-job',
  status: 'done',
  stage: 'synthesizing',
  segments_done: 1,
  segments_total: 1,
  narration: 'Spoken answer.',
  url: '/api/audio/abc.mp3',
  error: null,
  started_at: '2026-07-06T00:00:00Z',
  finished_at: '2026-07-06T00:00:01Z',
};

function QueueProbe() {
  const audio = useAudio();
  return (
    <Pressable
      accessibilityLabel="Queue response"
      onPress={() => audio.enqueueJob(
        { id: 'turn-1', title: 'Paper', text: 'Canonical answer.' },
        'audio-job',
        'project-a',
      )}
    />
  );
}

test('queued listening audio is appended without interrupting current playback', async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: doneJob });
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.Playing });
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce({ id: 'current-track' } as never);

  await renderAsync(
    <ProjectProvider>
      <AudioProvider><QueueProbe /></AudioProvider>
    </ProjectProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('Queue response'));

  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({
    id: 'turn-1',
    title: 'Paper',
  })));
  expect(TrackPlayer.reset).not.toHaveBeenCalled();
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('the first queued listening track starts automatically', async () => {
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: doneJob });
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce(undefined);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.Ready });

  await renderAsync(
    <ProjectProvider>
      <AudioProvider><QueueProbe /></AudioProvider>
    </ProjectProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('Queue response'));

  await waitFor(() => expect(TrackPlayer.play).toHaveBeenCalledTimes(1));
  expect(TrackPlayer.reset).not.toHaveBeenCalled();
});
