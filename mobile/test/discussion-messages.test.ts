import {
  ANALYST_USER,
  DISCUSSION_USER,
  PENDING_MESSAGE_ID,
  STREAMING_MESSAGE_ID,
  toDiscussionMessages,
} from '@/components/chat/discussionMessages';
import type { StreamItem, TranscriptEntry } from '@/api/types';

const user = (text: string): TranscriptEntry => ({ role: 'user', text });
const assistant = (canonical: string, assistantIndex: number): TranscriptEntry => ({
  role: 'assistant',
  canonical,
  narration: canonical,
  state_signal: 'CONTINUE',
  proposed_commit: null,
  assistant_index: assistantIndex,
  delivery_mode: 'reading',
  chat_job_id: null,
  audio_job_id: null,
  audio_error: null,
});

describe('toDiscussionMessages', () => {
  it('maps transcript entries newest-first with stable ids and roles', () => {
    const transcript = [user('opening'), assistant('first answer', 0), user('follow-up')];
    const out = toDiscussionMessages(transcript, null, null);

    expect(out.map((m) => m._id)).toEqual(['t2', 't1', 't0']);
    expect(out[0].user).toBe(DISCUSSION_USER);
    expect(out[1].user).toBe(ANALYST_USER);
    expect(out[1].text).toBe('first answer');
    expect(out[2].text).toBe('opening');
  });

  it('assigns reply_index counting only user turns (matching the backend)', () => {
    const transcript = [
      user('opening'),
      assistant('a0', 0),
      user('second'),
      assistant('a1', 1),
      user('third'),
    ];
    const out = toDiscussionMessages(transcript, null, null);
    const users = out.filter((m) => m.user === DISCUSSION_USER);
    // Inverted order: newest first.
    expect(users.map((m) => m.replyIndex)).toEqual([2, 1, 0]);
    expect(users.map((m) => m.transcriptIndex)).toEqual([4, 2, 0]);
    const analysts = out.filter((m) => m.user === ANALYST_USER);
    expect(analysts.every((m) => m.replyIndex === undefined)).toBe(true);
  });

  it('appends the optimistic pending user message at the head', () => {
    const out = toDiscussionMessages([user('opening'), assistant('a0', 0)], 'just sent', null);
    expect(out[0]._id).toBe(PENDING_MESSAGE_ID);
    expect(out[0].text).toBe('just sent');
    expect(out[0].pending).toBe(true);
    expect(out[0].user).toBe(DISCUSSION_USER);
    expect(out[0].entry).toBeUndefined();
  });

  it('appends the synthetic streaming row above the pending user message', () => {
    const items: StreamItem[] = [
      { kind: 'tool', name: 'web_search', detail: 'related work' },
      { kind: 'text', text: 'partial answer' },
    ];
    const out = toDiscussionMessages([user('opening')], 'just sent', items);
    expect(out[0]._id).toBe(STREAMING_MESSAGE_ID);
    // The bubble only dispatches to the custom renderer when text is truthy.
    expect(out[0].text).toBeTruthy();
    expect(out[0].streaming).toBe(true);
    expect(out[0].streamItems).toBe(items);
    expect(out[0].user).toBe(ANALYST_USER);
    expect(out[1]._id).toBe(PENDING_MESSAGE_ID);
  });

  it('omits synthetic rows when idle', () => {
    const out = toDiscussionMessages([user('opening'), assistant('a0', 0)], null, null);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.entry !== undefined)).toBe(true);
  });
});

// ---- U.14: while a retry is generating, the forked-away tail is hidden ----

const assistantEntry = (assistant_index: number, canonical: string) => ({
  role: 'assistant' as const,
  canonical,
  narration: '',
  state_signal: '',
  proposed_commit: null,
  assistant_index,
  delivery_mode: 'reading' as const,
  chat_job_id: null,
  audio_job_id: null,
  audio_error: null,
});

test('hideFromAssistantIndex cuts the transcript at the forked turn', () => {
  const transcript = [
    { role: 'user' as const, text: 'q1' },
    assistantEntry(0, 'a1'),
    { role: 'user' as const, text: 'q2' },
    assistantEntry(1, 'a2'),
  ];
  const msgs = toDiscussionMessages(transcript, null, [{ kind: 'text', text: '…' }] as never, 1);
  const texts = msgs.map((m) => m.text);
  // Newest-first (inverted list): streaming row, then q2's answer gone — a2 and beyond hidden.
  expect(texts).toContain('q1');
  expect(texts).toContain('a1');
  expect(texts).toContain('q2');
  expect(texts).not.toContain('a2');
});

test('hiding stops when the hidden turn is absent (default null passes through)', () => {
  const transcript = [
    { role: 'user' as const, text: 'q1' },
    assistantEntry(0, 'a1'),
  ];
  expect(toDiscussionMessages(transcript, null, null).map((m) => m.text)).toContain('a1');
  expect(toDiscussionMessages(transcript, null, null, 5).map((m) => m.text)).toContain('a1');
});
