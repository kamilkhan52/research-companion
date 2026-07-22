import {
  messageAudioId,
  parseMessageAudioId,
  sessionAddressFromAudioSlug,
} from '@/audio/identity';
import {
  nextQueuedResponseIndex,
  nextTranscriptResponse,
  shouldAutoAdvance,
} from '@/audio/playlist';
import type { TranscriptEntry } from '@/api/types';

test('message audio identity parses main and independent-thread response ids', () => {
  const id = messageAudioId('project:one', 'paper--abc123def456', 7, 'Canonical answer.');
  expect(parseMessageAudioId(id)).toEqual({
    project: 'project:one',
    slug: 'paper--abc123def456',
    assistantIndex: 7,
    contentTag: expect.any(String),
  });
  expect(sessionAddressFromAudioSlug('paper--abc123def456')).toEqual({
    slug: 'paper',
    threadId: 'abc123def456',
  });
  expect(sessionAddressFromAudioSlug('ordinary-paper')).toEqual({
    slug: 'ordinary-paper',
    threadId: 'main',
  });
  expect(parseMessageAudioId('preview:grounding')).toBeNull();
});

test('next queued response skips previews, progressive segments, and other threads', () => {
  const current = messageAudioId('p', 'paper', 2, 'Current');
  const next = messageAudioId('p', 'paper', 4, 'Next');
  const queue = [
    { id: `${current}|job|segment:0`, slotId: current },
    { id: `${current}|job|segment:1`, slotId: current },
    { id: 'preview:late' },
    { id: messageAudioId('p', 'other-paper', 3, 'Other') },
    { id: next, slotId: next },
  ];
  expect(nextQueuedResponseIndex(queue, 0)).toBe(4);
  expect(nextQueuedResponseIndex(queue, undefined)).toBeNull();
});

test('next transcript response follows existing assistant order', () => {
  const transcript: TranscriptEntry[] = [
    { role: 'user', text: 'Question one' },
    {
      role: 'assistant', canonical: 'First', narration: '', state_signal: '',
      proposed_commit: null, assistant_index: 0, delivery_mode: 'reading',
      chat_job_id: null, audio_job_id: null, audio_error: null,
    },
    { role: 'user', text: 'Question two' },
    {
      role: 'assistant', canonical: 'Second', narration: '', state_signal: '',
      proposed_commit: null, assistant_index: 1, delivery_mode: 'listening',
      chat_job_id: 'chat-2', audio_job_id: 'audio-2', audio_error: null,
    },
  ];
  expect(nextTranscriptResponse(transcript, 0)?.canonical).toBe('Second');
  expect(nextTranscriptResponse(transcript, 1)).toBeNull();
});

test('autoplay off never authorizes automatic advancement', () => {
  expect(shouldAutoAdvance(false, true)).toBe(false);
  expect(shouldAutoAdvance(true, true)).toBe(true);
  expect(shouldAutoAdvance(true, false)).toBe(false);
});
