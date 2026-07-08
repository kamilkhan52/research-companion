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
): DiscussionMessage[] {
  const out: DiscussionMessage[] = [];
  let replyIndex = -1;
  transcript.forEach((entry, i) => {
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
      createdAt: transcript.length,
      user: DISCUSSION_USER,
      pending: true,
    });
  }
  if (streamItems) {
    out.push({
      _id: STREAMING_MESSAGE_ID,
      text: '',
      createdAt: transcript.length + 1,
      user: ANALYST_USER,
      streaming: true,
      streamItems,
    });
  }
  return out.reverse();
}
