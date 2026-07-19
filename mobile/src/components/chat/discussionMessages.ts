// Pure mapping from the session transcript (+ the in-flight turn) to the message shape the
// chat library renders. The library shows an inverted list (index 0 = newest, pinned to the
// bottom), so the transcript is reversed here. Transcript entries carry no timestamps, so
// `createdAt` is a synthetic ordinal and the screen suppresses day/time rendering.

import type { IMessage, User } from '@kesha-antonov/react-native-chat';

import type { StreamItem, TranscriptEntry } from '@/api/types';

export const DISCUSSION_USER: User = { _id: 'user' };
export const ANALYST_USER: User = { _id: 'analyst', name: 'Analyst' };

/** Synthetic row mirroring the live turn's interleaved text/tool items. */
export const STREAMING_MESSAGE_ID = 'live-turn';
/** Optimistic echo of the user text just sent, until the transcript refetch records it. */
export const PENDING_MESSAGE_ID = 'pending-user';

export interface DiscussionMessage extends IMessage {
  /** The recorded transcript entry behind this row (absent for the synthetic live rows). */
  entry?: TranscriptEntry;
  /** This row's position in the transcript (for the edit-discards-later-turns warning). */
  transcriptIndex?: number;
  /** For user rows: index among user turns — the backend's reply_index for edits. */
  replyIndex?: number;
  /** Set on the synthetic assistant row while a turn is generating. */
  streamItems?: StreamItem[];
}

export function toDiscussionMessages(
  transcript: TranscriptEntry[],
  pendingUser: string | null,
  streamItems: StreamItem[] | null,
  /** While a retry is generating, hide the transcript from this assistant turn onward — the
   *  server already forked the tail away, but the cached transcript still carries it until
   *  the post-generation refetch. The reader must see the conversation reset immediately
   *  (U.14), not the response being replaced. */
  hideFromAssistantIndex: number | null = null,
  /** While a user turn is being edited, mirror the backend rewind immediately: the draft
   *  lives in the composer, so hide that recorded user entry and the complete tail after it.
   *  The prefix remains available above the preceding assistant response, exactly as it was
   *  when the reader first authored this turn. */
  hideFromTranscriptIndex: number | null = null,
): DiscussionMessage[] {
  let visible = transcript;
  if (hideFromAssistantIndex != null) {
    const cut = transcript.findIndex(
      (e) => e.role === 'assistant' && e.assistant_index === hideFromAssistantIndex,
    );
    if (cut >= 0) visible = transcript.slice(0, cut);
  }
  if (
    hideFromTranscriptIndex != null &&
    hideFromTranscriptIndex >= 0 &&
    hideFromTranscriptIndex < visible.length
  ) {
    visible = visible.slice(0, hideFromTranscriptIndex);
  }
  const out: DiscussionMessage[] = [];
  let replyIndex = -1;
  visible.forEach((entry, i) => {
    if (entry.role === 'user') {
      replyIndex += 1;
      out.push({
        _id: `t${i}`,
        text: entry.text,
        createdAt: i,
        user: DISCUSSION_USER,
        entry,
        transcriptIndex: i,
        replyIndex,
      });
    } else {
      out.push({
        _id: `t${i}`,
        text: entry.canonical,
        createdAt: i,
        user: ANALYST_USER,
        entry,
        transcriptIndex: i,
      });
    }
  });
  if (pendingUser) {
    out.push({
      _id: PENDING_MESSAGE_ID,
      text: pendingUser,
      createdAt: visible.length,
      user: DISCUSSION_USER,
      pending: true,
    });
  }
  if (streamItems) {
    out.push({
      _id: STREAMING_MESSAGE_ID,
      // Non-empty on purpose: the library's Bubble only calls renderMessageText when
      // `currentMessage.text` is truthy, and this row renders entirely through it.
      text: ' ',
      createdAt: visible.length + 1,
      user: ANALYST_USER,
      streaming: true,
      streamItems,
    });
  }
  return out.reverse();
}
