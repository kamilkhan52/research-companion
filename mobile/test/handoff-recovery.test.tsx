import { act, renderHookAsync, waitFor } from '@testing-library/react-native';

import type { TranscriptEntry } from '@/api/types';
import {
  currentHandoffEligibilityEpoch,
  dismissEligibleHandoffs,
  isHandoffEligible,
  registerEligibleHandoff,
} from '@/audio/handoffState';
import { messageAudioId, useListeningHandoffRecovery } from '@/audio/identity';

const completed: TranscriptEntry = {
  role: 'assistant',
  canonical: 'Recovered answer.',
  narration: '',
  state_signal: 'in_discussion',
  proposed_commit: null,
  assistant_index: 2,
  delivery_mode: 'listening',
  chat_job_id: 'chat-job',
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
  await registerEligibleHandoff('chat-job');

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
      id: messageAudioId('project-a', 'paper-a', 2, 'Recovered answer.'),
      title: 'Paper A',
      text: 'Recovered answer.',
    },
    'audio-job',
    'project-a',
    'chat-job',
  ));
  await second.unmountAsync();
});

test('a new device does not treat historical listening responses as pending', async () => {
  const enqueueJob = jest.fn();
  const rendered = await renderHookAsync(() => useListeningHandoffRecovery({
    enabled: true,
    project: 'project-a',
    slug: 'paper-a',
    title: 'Paper A',
    transcript: [completed],
    enqueueJob,
  }));

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(enqueueJob).not.toHaveBeenCalled();
  await rendered.unmountAsync();
});

test('turning listening off dismisses pending handoffs so they do not resurrect', async () => {
  const staleEpoch = currentHandoffEligibilityEpoch();
  await registerEligibleHandoff('chat-job');
  await dismissEligibleHandoffs();
  await registerEligibleHandoff('late-chat-job', staleEpoch);
  expect(await isHandoffEligible('late-chat-job')).toBe(false);
  const enqueueJob = jest.fn();
  const rendered = await renderHookAsync(() => useListeningHandoffRecovery({
    enabled: true,
    project: 'project-a',
    slug: 'paper-a',
    title: 'Paper A',
    transcript: [completed],
    enqueueJob,
  }));

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(enqueueJob).not.toHaveBeenCalled();
  await rendered.unmountAsync();
});
