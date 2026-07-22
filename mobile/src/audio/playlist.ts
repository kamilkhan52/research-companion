import type { TranscriptEntry } from '@/api/types';
import { parseMessageAudioId } from '@/audio/identity';

interface QueueTrackIdentity {
  [key: string]: unknown;
  id?: unknown;
  slotId?: unknown;
}

function trackMessageId(track: QueueTrackIdentity | undefined): string | null {
  if (!track) return null;
  const value = track.slotId ?? track.id;
  return value == null ? null : String(value);
}

/** Find the next distinct response from the active response's thread. Progressive narration
 *  can contribute several tracks with one slotId, so those segments are deliberately skipped. */
export function nextQueuedResponseIndex(
  queue: QueueTrackIdentity[],
  activeIndex: number | undefined,
): number | null {
  if (activeIndex == null || activeIndex < 0 || activeIndex >= queue.length) return null;
  const current = parseMessageAudioId(trackMessageId(queue[activeIndex]) ?? '');
  if (!current) return null;

  for (let index = activeIndex + 1; index < queue.length; index += 1) {
    const candidate = parseMessageAudioId(trackMessageId(queue[index]) ?? '');
    if (candidate
        && candidate.project === current.project
        && candidate.slug === current.slug
        && candidate.assistantIndex > current.assistantIndex) {
      return index;
    }
  }
  return null;
}

/** The next existing assistant response in transcript order (never generates a new turn). */
export function nextTranscriptResponse(
  transcript: TranscriptEntry[],
  currentAssistantIndex: number,
): Extract<TranscriptEntry, { role: 'assistant' }> | null {
  for (const entry of transcript) {
    if (entry.role === 'assistant' && entry.assistant_index > currentAssistantIndex) return entry;
  }
  return null;
}

/** Automatic advancement is the only path gated by the session toggle. Manual Play next is
 *  always allowed; the caller expresses that by not asking this helper. */
export function shouldAutoAdvance(enabled: boolean, nextExists: boolean): boolean {
  return enabled && nextExists;
}
