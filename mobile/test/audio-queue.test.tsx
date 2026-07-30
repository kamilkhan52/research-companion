import { act, fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Pressable } from 'react-native';
import TrackPlayer, { State } from 'react-native-track-player';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { AudioJob, TranscriptEntry } from '@/api/types';
import {
  AudioProvider,
  stopPlaybackForSessionEnd,
  useAudio,
} from '@/audio/AudioProvider';
import { isHandoffEligible, registerEligibleHandoff } from '@/audio/handoffState';
import { messageAudioId, useListeningHandoffRecovery } from '@/audio/identity';
import { ProjectProvider } from '@/store/project';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ListeningProvider } from '@/store/listening';

// Playback-mode opt-ins must not leak across tests in this file.
afterEach(() => AsyncStorage.removeItem('rc.audioPlayback'));

test('deleted-account teardown fails closed when the native player cannot reset', async () => {
  jest.mocked(TrackPlayer.reset).mockRejectedValueOnce(new Error('native player busy'));

  await expect(
    stopPlaybackForSessionEnd({ failClosed: true }),
  ).rejects.toThrow('Private playback could not be stopped.');
});

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
      <ListeningProvider>
        <AudioProvider><QueueProbe /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><QueueProbe /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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

test('full-track mode (the default) waits for the stitched file and carries the narration', async () => {
  // Segments land while the job runs, but nothing plays until the final url exists — the
  // whole point of the default mode (polish plan I.1): full duration, lock-proof, rewind
  // across the entire response. The added track carries narration for sentence-jumping.
  const running: AudioJob = {
    ...doneJob,
    status: 'running',
    segments_done: 1,
    segments_total: 2,
    url: null,
    segments: [{ index: 0, text: 'First sentence.', url: '/api/audio/seg1.mp3' }],
  };
  jest.mocked(api.getAudioJob)
    .mockResolvedValueOnce({ job: running })
    .mockResolvedValueOnce({ job: doneJob });
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-full', title: 'Paper', text: 'Canonical response.' },
    'audio-job',
    'project-a',
    'chat-job-full',
  );

  await waitFor(() => expect(TrackPlayer.play).toHaveBeenCalledTimes(1), { timeout: 4000 });
  // Exactly one add — the complete stitched track; the in-flight segment never played.
  expect(TrackPlayer.add).toHaveBeenCalledTimes(1);
  expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({
    id: 'turn-full',
    url: expect.stringContaining('/api/audio/abc.mp3'),
    narration: 'Spoken answer.',
  }));
  expect(TrackPlayer.add).not.toHaveBeenCalledWith(
    expect.objectContaining({ segmentIndex: 0 }),
  );
});

test('progressive narration starts segment one before the final segment is ready', async () => {
  // Progressive playback is opt-in now (Settings -> Audio); 'full' is the default.
  await AsyncStorage.setItem('rc.audioPlayback', 'progressive');
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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

test('progressive falls back to the stitched track when a cached job exposes no segments', async () => {
  // The likeliest way progressive "breaks" without any code being wrong: re-listening to
  // narration whose combined mp3 is cached but whose per-segment files are not (narration from
  // before segment caching, or segments evicted). `audio_jobs` keeps the zero-cost cache hit and
  // registers a DONE job straight from the cache rather than re-synthesizing to backfill —
  // `segments = _segment_metadata(parts, existing_only=True)` is empty and `segments_done =
  // len(segments)` is therefore 0 of N, not N of N. Progressive must play the finished track;
  // silence here would look exactly like a broken feature on device.
  await AsyncStorage.setItem('rc.audioPlayback', 'progressive');
  const cachedNoSegments: AudioJob = {
    ...doneJob,
    segments_done: 0,
    segments_total: 2,
    url: '/api/audio/abc.mp3',
    segments: [],
  };
  jest.mocked(api.getAudioJob).mockResolvedValueOnce({ job: cachedNoSegments });
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-cached', title: 'Paper', text: 'Canonical response.' },
    'audio-job',
    'project-a',
    'chat-job-cached',
  );

  await waitFor(() => expect(TrackPlayer.play).toHaveBeenCalledTimes(1));
  // The whole track, addressed by the slot id — not a segment.
  expect(TrackPlayer.add).toHaveBeenCalledWith(expect.objectContaining({
    id: 'turn-cached',
    url: expect.stringContaining('/api/audio/abc.mp3'),
  }));
  expect(TrackPlayer.add).not.toHaveBeenCalledWith(
    expect.objectContaining({ segmentIndex: expect.anything() }),
  );
});

test('progressive surfaces a synthesis failure that happens after segments already played', async () => {
  // Partial audio is the dangerous shape: the listener has heard something, so silence afterwards
  // reads as "it finished" rather than "it broke". The error must reach errorById even though
  // playback already started, which is why the job-status check precedes the segments-played
  // early return.
  await AsyncStorage.setItem('rc.audioPlayback', 'progressive');
  const firstSegment: AudioJob = {
    ...doneJob,
    status: 'running',
    finished_at: null,     // a running job has not finished; doneJob's timestamp would be a lie
    segments_done: 1,
    segments_total: 3,
    url: null,
    segments: [{ index: 0, text: 'First sentence.', url: '/api/audio/seg1.mp3' }],
  };
  // A later segment throwing keeps the earlier ones and leaves `url` null (audio_jobs only sets
  // it once every part is synthesized), so partial-then-error is a real server shape.
  const failed: AudioJob = {
    ...firstSegment,
    status: 'error',
    url: null,
    error: 'TTS provider refused the request.',
  };
  jest.mocked(api.getAudioJob)
    .mockResolvedValueOnce({ job: firstSegment })
    .mockResolvedValueOnce({ job: failed });
  await registerEligibleHandoff('chat-job-partial');
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-partial', title: 'Paper', text: 'Canonical response.' },
    'audio-job',
    'project-a',
    'chat-job-partial',
  );

  // The first segment really did play, so this is the partial case and not a plain failure.
  await waitFor(() => expect(TrackPlayer.play).toHaveBeenCalledTimes(1));
  await waitFor(
    () => expect(audio.errorById['turn-partial']).toContain('TTS provider refused'),
    { timeout: 3000 },
  );
  // A terminally failed narration must also stop being an eligible handoff, or a provider
  // remount would "recover" by replaying the partial audio that just failed.
  await waitFor(() => expect(isHandoffEligible('chat-job-partial')).resolves.toBe(false));
});

test('manual Listen also begins from the first progressive segment', async () => {
  // Progressive playback is opt-in now (Settings -> Audio); 'full' is the default.
  await AsyncStorage.setItem('rc.audioPlayback', 'progressive');
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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
  // Progressive playback is opt-in now (Settings -> Audio); 'full' is the default.
  await AsyncStorage.setItem('rc.audioPlayback', 'progressive');
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><QueueProbe /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  audio.enqueueJob(
    { id: 'turn-1', title: 'Paper', text: 'Paper summary.' },
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
      <ListeningProvider>
        <AudioProvider><Capture /></AudioProvider>
      </ListeningProvider>
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
      <ListeningProvider>
        <AudioProvider><RecoveryProbe /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  await waitFor(
    () => expect(audio.errorById[messageAudioId('project-a', 'paper-a', 0, 'Canonical response.')]).toBe('Temporarily offline'),
    { timeout: 2500 },
  );
  expect(await isHandoffEligible('chat-job-1')).toBe(true);
  await first.unmountAsync();

  await renderAsync(
    <ProjectProvider>
      <ListeningProvider>
        <AudioProvider><RecoveryProbe /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );

  await waitFor(() => expect(TrackPlayer.add).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(isHandoffEligible('chat-job-1')).resolves.toBe(false));
});

// ---- U.4: cancelling a preparation also cancels the SERVER job ----

test('cancelPrep POSTs the server cancel for the known job id', async () => {
  await setBaseUrl('https://api.test');
  const runningJob: AudioJob = {
    ...doneJob,
    id: 'audio-job',
    status: 'running',
    stage: 'synthesizing',
    segments_done: 0,
    segments_total: 3,
    url: null,
  };
  jest.mocked(api.getAudioJob).mockResolvedValue({ job: runningJob });
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.None } as never);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue(undefined as never);

  await renderAsync(
    <ProjectProvider>
      <ListeningProvider>
        <AudioProvider><QueueProbe /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('Queue response'));
  // The provider learned the server job id from its first poll (applyJob).
  await waitFor(() => expect(api.getAudioJob).toHaveBeenCalled());

  await fireEventAsync.press(screen.getByLabelText('Cancel queue'));
  await waitFor(() => expect(api.cancelAudioJob).toHaveBeenCalledWith('audio-job'));
});

test('cancelPrep without a known server job is purely local', async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.cancelAudioJob).mockClear();

  await renderAsync(
    <ProjectProvider>
      <ListeningProvider>
        <AudioProvider><QueueProbe /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('Cancel queue'));
  expect(api.cancelAudioJob).not.toHaveBeenCalled();
});

test('cancel racing ahead of the start request still cancels the created job', async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.cancelAudioJob).mockClear();
  let releaseStart: (value: { job: AudioJob }) => void = () => {};
  const gate = new Promise<{ job: AudioJob }>((resolve) => { releaseStart = resolve; });
  jest.mocked(api.startAudioJob).mockReturnValueOnce(gate as never);

  function PlayProbe() {
    const audio = useAudio();
    return (
      <>
        <Pressable
          accessibilityLabel="Play message"
          onPress={() => void audio.playText({ id: 'm1', title: 'Paper', text: 'Long answer.' })}
        />
        <Pressable accessibilityLabel="Cancel prep" onPress={audio.cancelPrep} />
      </>
    );
  }

  await renderAsync(
    <ProjectProvider>
      <ListeningProvider>
        <AudioProvider><PlayProbe /></AudioProvider>
      </ListeningProvider>
    </ProjectProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('Play message'));
  // Cancel while startAudioJob is still in flight — no server job id is known yet.
  await fireEventAsync.press(screen.getByLabelText('Cancel prep'));
  expect(api.cancelAudioJob).not.toHaveBeenCalled();

  // The POST finally returns a running job; the stale run must cancel it, not leak it.
  await act(async () => {
    releaseStart({
      job: { ...doneJob, id: 'raced-job', status: 'running', segments_done: 0, url: null },
    });
  });
  await waitFor(() => expect(api.cancelAudioJob).toHaveBeenCalledWith('raced-job'));
});
