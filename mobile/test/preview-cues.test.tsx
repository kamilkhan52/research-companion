import { renderHookAsync, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import type { PreviewJob } from '@/api/types';
import { usePreviewCues } from '@/audio/usePreviewCues';

const doneJob: PreviewJob = {
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

test('a completed grounded cue is polled and offered to idle playback once', async () => {
  jest.mocked(api.getPreviewJob).mockResolvedValue({ job: doneJob });
  const playPreview = jest.fn(async () => true);
  const rendered = await renderHookAsync(() => usePreviewCues({
    enabled: true,
    project: 'project-a',
    title: 'Paper A',
    jobIds: ['cue-job-1'],
    playPreview,
    parentJobRef: { current: 'chat-job' },
  }));

  await waitFor(() => expect(playPreview).toHaveBeenCalledWith(
    'preview:cue-job-1',
    'Preview · Paper A',
    '/api/audio/cue.mp3',
  ));
  expect(api.getPreviewJob).toHaveBeenCalledTimes(1);
  await rendered.unmountAsync();
});

test('a server-suppressed late cue is never offered to playback', async () => {
  jest.mocked(api.getPreviewJob).mockResolvedValue({
    job: { ...doneJob, id: 'cue-job-2', suppressed: true, url: null },
  });
  const playPreview = jest.fn(async () => true);
  const rendered = await renderHookAsync(() => usePreviewCues({
    enabled: true,
    project: 'project-a',
    title: 'Paper A',
    jobIds: ['cue-job-2'],
    playPreview,
    parentJobRef: { current: 'chat-job' },
  }));

  await waitFor(() => expect(api.getPreviewJob).toHaveBeenCalledWith('project-a', 'cue-job-2'));
  expect(playPreview).not.toHaveBeenCalled();
  await rendered.unmountAsync();
});

test('terminal parent invalidation cancels a cue already being polled', async () => {
  let resolvePoll!: (value: { job: PreviewJob }) => void;
  jest.mocked(api.getPreviewJob).mockImplementationOnce(() => new Promise((resolve) => {
    resolvePoll = resolve;
  }));
  const playPreview = jest.fn(async () => true);
  const parentJobRef: { current: string | null } = { current: 'chat-job' };
  const rendered = await renderHookAsync(() => usePreviewCues({
    enabled: true,
    project: 'project-a',
    title: 'Paper A',
    jobIds: ['cue-job-terminal-parent'],
    playPreview,
    parentJobRef,
  }));
  await waitFor(() => expect(api.getPreviewJob).toHaveBeenCalled());

  parentJobRef.current = null;
  resolvePoll({ job: { ...doneJob, id: 'cue-job-terminal-parent' } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(playPreview).not.toHaveBeenCalled();
  await rendered.unmountAsync();
});

test('a second parent cannot reactivate the first parent’s deferred cue', async () => {
  let resolvePoll!: (value: { job: PreviewJob }) => void;
  jest.mocked(api.getPreviewJob).mockImplementationOnce(() => new Promise((resolve) => {
    resolvePoll = resolve;
  }));
  const playPreview = jest.fn(async () => true);
  const parentJobRef: { current: string | null } = { current: 'chat-job-1' };
  const rendered = await renderHookAsync(() => usePreviewCues({
    enabled: true,
    project: 'project-a',
    title: 'Paper A',
    jobIds: ['cue-job-old-parent'],
    playPreview,
    parentJobRef,
  }));
  await waitFor(() => expect(api.getPreviewJob).toHaveBeenCalled());

  parentJobRef.current = null;
  parentJobRef.current = 'chat-job-2';
  resolvePoll({ job: { ...doneJob, id: 'cue-job-old-parent' } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(playPreview).not.toHaveBeenCalled();
  await rendered.unmountAsync();
});
