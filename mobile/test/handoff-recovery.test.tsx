import { renderHookAsync, waitFor } from '@testing-library/react-native';

import type { TranscriptEntry } from '@/api/types';
import { useListeningHandoffRecovery } from '@/audio/identity';

const completed: TranscriptEntry = {
  role: 'assistant',
  canonical: 'Recovered answer.',
  narration: '',
  state_signal: 'in_discussion',
  proposed_commit: null,
  assistant_index: 2,
  delivery_mode: 'listening',
  audio_job_id: 'audio-job',
  audio_error: null,
};

test('re-entry recovers a handoff that completed after the original watcher unmounted', async () => {
  const enqueueJob = jest.fn();
  const first = await renderHookAsync(() => useListeningHandoffRecovery({
    enabled: true,
    project: 'project-a',
    slug: 'paper-a',
    title: 'Paper A',
    transcript: [],
    enqueueJob,
  }));
  await first.unmountAsync();
  expect(enqueueJob).not.toHaveBeenCalled();

  const second = await renderHookAsync(() => useListeningHandoffRecovery({
    enabled: true,
    project: 'project-a',
    slug: 'paper-a',
    title: 'Paper A',
    transcript: [completed],
    enqueueJob,
  }));

  await waitFor(() => expect(enqueueJob).toHaveBeenCalledWith(
    {
      id: 'project-a:paper-a:2',
      title: 'Paper A',
      text: 'Recovered answer.',
    },
    'audio-job',
    'project-a',
  ));
  await second.unmountAsync();
});
