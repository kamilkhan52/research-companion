import { renderHookAsync, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import type { ChatJob, PreviewJob } from '@/api/types';
import { usePreviewCues } from '@/audio/usePreviewCues';

const doneCue: PreviewJob = {
  id: 'cue-job-1',
  chat_job_id: 'chat-job',
  ordinal: 1,
  status: 'done',
  stage: 'synthesizing',
  sentence_ids: ['s0001'],
  source_sentence_ids: ['s0001'],
  cue: 'The early finding is ready.',
  url: '/api/audio/cue.mp3',
  model: 'preview/model',
  suppressed: false,
  error: null,
  started_at: '2026-07-07T00:00:00Z',
  finished_at: '2026-07-07T00:00:01Z',
};

const parentJob: ChatJob = {
  id: 'chat-job',
  slug: 'paper',
  status: 'done',
  items: [],
  turn: null,
  state: 'in_discussion',
  error: null,
  started_at: '2026-07-07T00:00:00Z',
  finished_at: '2026-07-07T00:00:01Z',
  delivery_mode: 'listening',
  audio_job_id: 'audio-job',
  audio_error: null,
  assistant_index: 0,
  preview_job_ids: ['cue-job-1'],
  preview_coordinator_id: 'coordinator-job',
  preview_complete: true,
  preview_phase: 'audio_synthesis',
  preview_progress: { segments_done: 1, segments_total: 1 },
};

function props(overrides: Partial<Parameters<typeof usePreviewCues>[0]> = {}) {
  return {
    enabled: true,
    project: 'project-a',
    title: 'Paper A',
    jobIds: ['cue-job-1'],
    playPreview: jest.fn(async () => true),
    parentJobId: 'chat-job',
    ...overrides,
  };
}

test('a completed grounded cue is polled and offered to idle playback once', async () => {
  jest.mocked(api.getChatJob).mockResolvedValue({ job: parentJob });
  jest.mocked(api.getPreviewJob).mockResolvedValue({ job: doneCue });
  const input = props();
  const rendered = await renderHookAsync(() => usePreviewCues(input));

  await waitFor(() => expect(input.playPreview).toHaveBeenCalledWith(
    'preview:cue-job-1',
    'Preview · Paper A',
    '/api/audio/cue.mp3',
  ));
  expect(api.getPreviewJob).toHaveBeenCalledTimes(1);
  await rendered.unmountAsync();
});

test('a server-suppressed late cue is never offered to playback', async () => {
  const suppressed = { ...doneCue, id: 'cue-job-2', suppressed: true, url: null };
  jest.mocked(api.getChatJob).mockResolvedValue({
    job: { ...parentJob, preview_job_ids: ['cue-job-2'] },
  });
  jest.mocked(api.getPreviewJob).mockResolvedValue({ job: suppressed });
  const input = props({ jobIds: ['cue-job-2'] });
  const rendered = await renderHookAsync(() => usePreviewCues(input));

  await waitFor(() => expect(api.getPreviewJob).toHaveBeenCalledWith('project-a', 'cue-job-2'));
  expect(input.playPreview).not.toHaveBeenCalled();
  await rendered.unmountAsync();
});

test('parent invalidation cancels a cue already being polled', async () => {
  let resolvePoll!: (value: { job: PreviewJob }) => void;
  jest.mocked(api.getChatJob).mockResolvedValue({ job: parentJob });
  jest.mocked(api.getPreviewJob).mockImplementationOnce(() => new Promise((resolve) => {
    resolvePoll = resolve;
  }));
  const playPreview = jest.fn(async () => true);
  let parentJobId: string | null = 'chat-job';
  const rendered = await renderHookAsync(() => usePreviewCues(props({
    playPreview,
    parentJobId,
    jobIds: ['cue-job-cancelled'],
  })));
  await waitFor(() => expect(api.getPreviewJob).toHaveBeenCalled());

  parentJobId = null;
  await rendered.rerenderAsync({});
  resolvePoll({ job: { ...doneCue, id: 'cue-job-cancelled' } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(playPreview).not.toHaveBeenCalled();
  await rendered.unmountAsync();
});

test('a finished response keeps discovering cues until final narration is ready', async () => {
  const continuedCue = { ...doneCue, id: 'cue-job-continued' };
  jest.mocked(api.getChatJob)
    .mockResolvedValueOnce({
      job: {
        ...parentJob,
        preview_job_ids: ['cue-job-continued'],
        preview_complete: false,
        preview_phase: 'narration_adaptation',
      },
    })
    .mockResolvedValue({
      job: {
        ...parentJob,
        preview_job_ids: ['cue-job-continued'],
        preview_complete: true,
      },
    });
  jest.mocked(api.getPreviewJob).mockResolvedValue({ job: continuedCue });
  const input = props({ jobIds: [] });
  const rendered = await renderHookAsync(() => usePreviewCues(input));

  await waitFor(() => expect(input.playPreview).toHaveBeenCalledWith(
    'preview:cue-job-continued',
    'Preview · Paper A',
    '/api/audio/cue.mp3',
  ));
  await waitFor(() => expect(api.getChatJob).toHaveBeenCalledTimes(2), { timeout: 2500 });
  await rendered.unmountAsync();
});
