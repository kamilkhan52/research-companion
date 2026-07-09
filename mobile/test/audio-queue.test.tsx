import { act, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Pressable } from 'react-native';
import TrackPlayer, { State } from 'react-native-track-player';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { AudioJob, TranscriptEntry } from '@/api/types';
import { AudioProvider, useAudio } from '@/audio/AudioProvider';
import { isHandoffEligible, registerEligibleHandoff } from '@/audio/handoffState';
import { useListeningHandoffRecovery } from '@/audio/identity';
import { ProjectProvider } from '@/store/project';

const doneJob: AudioJob = {
  id: 'audio-job',
  status: 'done',
  stage: 'synthesizing',
  segments_done: 1,
  segments_total: 1,
  narration: 'Spoken answer.',
  url: '/api/audio/abc.mp3',
  segments: [],
  timings: {},
  error: null,
  started_at: '2026-07-06T00:00:00Z',
  finished_at: '2026-07-06T00:00:01Z',
};

function QueueProbe() {
  const audio = useAudio();
  return (
    <>
      <Pressable
        accessibilityLabel="Queue response"
        onPress={() => audio.enqueueJob(
          { id: 'turn-1', title: 'Paper', text: 'Canonical answer.' },
          'audio-job',
          'project-a',
        )}
      />
      <Pressable accessibilityLabel="Cancel queue" onPress={audio.cancelPrep} />
    </>
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

test('a grounded preview plays when TrackPlayer is idle', async () => {
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.None });
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValueOnce(undefined);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([]);
  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );

  let played = false;
  await act(async () => {
    played = await audio.playPreview('preview:1', 'Preview · Paper', '/api/audio/cue.mp3');
  });
  expect(played).toBe(true);
  expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({ id: 'preview:1' }));
  expect(TrackPlayer.play).toHaveBeenCalledTimes(1);
});

test('a grounded preview is dropped while another track is active', async () => {
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.Playing });
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValueOnce(0);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([{ id: 'current' }] as never);
  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );

  let played = true;
  await act(async () => {
    played = await audio.playPreview('preview:1', 'Preview · Paper', '/api/audio/cue.mp3');
  });
  expect(played).toBe(false);
  expect(TrackPlayer.add).not.toHaveBeenCalled();
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('preview cues keep playing while automatic final narration is preparing', async () => {
  let resolveAudio!: (value: { job: AudioJob }) => void;
  jest.mocked(api.getAudioJob).mockImplementationOnce(() => new Promise((resolve) => {
    resolveAudio = resolve;
  }));
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.None });
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValueOnce(undefined);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([]);
  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-1', title: 'Paper', text: 'Canonical answer.' },
    'audio-job',
    'project-a',
  );
  await waitFor(() => expect(api.getAudioJob).toHaveBeenCalled());

  let played = false;
  await act(async () => {
    played = await audio.playPreview('preview:wait', 'Preview · Paper', '/api/audio/cue.mp3');
  });
  expect(played).toBe(true);
  expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({ id: 'preview:wait' }));

  await act(async () => {
    audio.cancelPrep();
    resolveAudio({ job: doneJob });
  });
});

test('a new preview queues behind a preview already speaking', async () => {
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.Playing });
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValueOnce(0);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([{ id: 'preview:first' }] as never);
  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );

  let played = false;
  await act(async () => {
    played = await audio.playPreview('preview:second', 'Preview · Paper', '/api/audio/two.mp3');
  });
  expect(played).toBe(true);
  expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({ id: 'preview:second' }));
  expect(TrackPlayer.reset).not.toHaveBeenCalled();
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('final narration removes queued cues but lets the active cue finish', async () => {
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: doneJob });
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValueOnce(0);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([
    { id: 'preview:active' },
    { id: 'preview:queued' },
  ] as never);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce({ id: 'preview:active' } as never);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.Playing });
  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );

  audio.enqueueJob(
    { id: 'turn-1', title: 'Paper', text: 'Canonical answer.' },
    'audio-job',
    'project-a',
  );

  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'turn-1' }),
  ));
  expect(TrackPlayer.remove).toHaveBeenCalledWith([1]);
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('progressive narration starts segment one before the final segment is ready', async () => {
  const firstSegment: AudioJob = {
    ...doneJob,
    status: 'running',
    segments_done: 1,
    segments_total: 2,
    url: null,
    segments: [{ index: 0, text: 'First sentence.', url: '/api/audio/seg1.mp3' }],
  };
  const completed: AudioJob = {
    ...doneJob,
    segments_done: 2,
    segments_total: 2,
    segments: [
      ...firstSegment.segments,
      { index: 1, text: 'Second sentence.', url: '/api/audio/seg2.mp3' },
    ],
  };
  let resolveFinal!: (value: { job: AudioJob }) => void;
  jest.mocked(api.getAudioJob)
    .mockResolvedValueOnce({ job: firstSegment })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFinal = resolve; }));
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(undefined);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValue([]);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue(undefined);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Ready });

  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-progressive', title: 'Paper', text: 'Canonical response.' },
    'audio-job',
    'project-a',
    'chat-job-progressive',
  );

  await waitFor(() => expect(TrackPlayer.play).toHaveBeenCalledTimes(1));
  expect(audio.playbackStartedAtById['turn-progressive']).toBeTruthy();
  expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({
    slotId: 'turn-progressive',
    segmentIndex: 0,
  }));
  expect(TrackPlayer.add).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.getAudioJob).toHaveBeenCalledTimes(2), { timeout: 2500 });
  resolveFinal({ job: completed });
  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledTimes(2));
});

test('manual Listen also begins from the first progressive segment', async () => {
  const partial: AudioJob = {
    ...doneJob,
    status: 'running',
    segments_done: 1,
    segments_total: 2,
    url: null,
    segments: [{ index: 0, text: 'First sentence.', url: '/api/audio/seg1.mp3' }],
  };
  const completed: AudioJob = {
    ...doneJob,
    segments_done: 2,
    segments_total: 2,
    segments: [
      ...partial.segments,
      { index: 1, text: 'Second sentence.', url: '/api/audio/seg2.mp3' },
    ],
  };
  let resolveFinal!: (value: { job: AudioJob }) => void;
  jest.mocked(api.startAudioJob).mockResolvedValueOnce({ job: partial });
  jest.mocked(api.getAudioJob).mockImplementationOnce(() => new Promise((resolve) => {
    resolveFinal = resolve;
  }));

  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );
  let playing!: Promise<void>;
  await act(async () => {
    playing = audio.playText({ id: 'manual-progressive', title: 'Paper', text: 'Answer.' });
    await Promise.resolve();
  });

  await waitFor(() => expect(TrackPlayer.play).toHaveBeenCalledTimes(1));
  expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({
    slotId: 'manual-progressive',
    segmentIndex: 0,
  }));
  await waitFor(() => expect(api.getAudioJob).toHaveBeenCalled(), { timeout: 2500 });
  resolveFinal({ job: completed });
  await act(async () => { await playing; });
  expect(TrackPlayer.add).toHaveBeenCalledTimes(2);
});

test('first progressive segment drops queued cues without interrupting the active cue', async () => {
  const readySegment: AudioJob = {
    ...doneJob,
    segments: [{ index: 0, text: 'First sentence.', url: '/api/audio/seg1.mp3' }],
  };
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: readySegment });
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValueOnce(0);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([
    { id: 'preview:active' },
    { id: 'preview:queued' },
  ] as never);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce({ id: 'preview:active' } as never);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.Playing });
  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );

  audio.enqueueJob(
    { id: 'turn-progressive', title: 'Paper', text: 'Canonical response.' },
    'audio-job',
    'project-a',
  );

  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({
    slotId: 'turn-progressive',
    segmentIndex: 0,
  })));
  expect(TrackPlayer.remove).toHaveBeenCalledWith([1]);
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('cancellation removes a track whose add finishes after the queue was cleared', async () => {
  let finishAdd!: () => void;
  const deferredAdd = new Promise<void>((resolve) => { finishAdd = resolve; });
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: doneJob });
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce({ id: 'current-track' } as never);
  jest.mocked(TrackPlayer.add).mockImplementationOnce(async () => deferredAdd);

  await renderAsync(
    <ProjectProvider>
      <AudioProvider><QueueProbe /></AudioProvider>
    </ProjectProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('Queue response'));
  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledTimes(1));
  await fireEventAsync.press(screen.getByLabelText('Cancel queue'));
  finishAdd();

  await waitFor(() => expect(TrackPlayer.removeUpcomingTracks).toHaveBeenCalledTimes(1));
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('regeneration replaces stale slot audio and queues the new handoff version', async () => {
  const replacement = { ...doneJob, id: 'audio-job-2', url: '/api/audio/def.mp3' };
  jest.mocked(api.getAudioJob)
    .mockResolvedValueOnce({ job: doneJob })
    .mockResolvedValueOnce({ job: replacement });
  jest.mocked(TrackPlayer.getQueue)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 'turn-1' }] as never);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue(undefined);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Ready });

  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-1', title: 'Paper', text: 'First response.' },
    'audio-job',
    'project-a',
    'chat-job-1',
  );
  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledTimes(1));

  audio.enqueueJob(
    { id: 'turn-1', title: 'Paper', text: 'Replacement response.' },
    'audio-job-2',
    'project-a',
    'chat-job-2',
  );
  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledTimes(2));

  expect(api.getAudioJob).toHaveBeenNthCalledWith(2, 'audio-job-2');
  expect(TrackPlayer.remove).toHaveBeenCalledWith([0]);
});

test('regeneration keeps the active slot playing and appends its replacement', async () => {
  const replacement = { ...doneJob, id: 'audio-job-2', url: '/api/audio/def.mp3' };
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: replacement });
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValueOnce(0);
  jest.mocked(TrackPlayer.getQueue).mockResolvedValueOnce([{ id: 'turn-1' }] as never);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValueOnce({ id: 'turn-1' } as never);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValueOnce({ state: State.Playing });

  let audio!: ReturnType<typeof useAudio>;
  function Capture() {
    audio = useAudio();
    return null;
  }
  await renderAsync(
    <ProjectProvider>
      <AudioProvider><Capture /></AudioProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-1', title: 'Paper', text: 'Replacement response.' },
    'audio-job-2',
    'project-a',
    'chat-job-2',
  );

  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledTimes(1));
  expect(TrackPlayer.remove).not.toHaveBeenCalled();
  expect(TrackPlayer.play).not.toHaveBeenCalled();
});

test('polling failure retains eligibility and recovers automatically after provider remount', async () => {
  const runningJob: AudioJob = {
    ...doneJob,
    status: 'running',
    url: null,
    finished_at: null,
  };
  const pollError = Object.assign(new Error('Temporarily offline'), { status: 503 });
  jest.mocked(api.getAudioJob)
    .mockResolvedValueOnce({ job: runningJob })
    .mockRejectedValueOnce(pollError)
    .mockResolvedValueOnce({ job: doneJob });
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue(undefined);
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Ready });
  await registerEligibleHandoff('chat-job-1');
  const transcript: TranscriptEntry[] = [{
    role: 'assistant',
    canonical: 'Canonical response.',
    narration: '',
    state_signal: '',
    proposed_commit: null,
    assistant_index: 0,
    delivery_mode: 'listening',
    chat_job_id: 'chat-job-1',
    audio_job_id: 'audio-job',
    audio_error: null,
  }];

  let audio!: ReturnType<typeof useAudio>;
  function RecoveryProbe() {
    audio = useAudio();
    useListeningHandoffRecovery({
      enabled: true,
      project: 'project-a',
      slug: 'paper-a',
      title: 'Paper',
      transcript,
      enqueueJob: audio.enqueueJob,
    });
    return null;
  }
  const first = await renderAsync(
    <ProjectProvider>
      <AudioProvider><RecoveryProbe /></AudioProvider>
    </ProjectProvider>,
  );
  await waitFor(
    () => expect(audio.errorById['project-a:paper-a:0']).toBe('Temporarily offline'),
    { timeout: 2500 },
  );
  expect(await isHandoffEligible('chat-job-1')).toBe(true);
  await first.unmountAsync();

  await renderAsync(
    <ProjectProvider>
      <AudioProvider><RecoveryProbe /></AudioProvider>
    </ProjectProvider>,
  );

  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(isHandoffEligible('chat-job-1')).resolves.toBe(false));
});
