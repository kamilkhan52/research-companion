import { useEffect } from 'react';

import type { TranscriptEntry } from '@/api/types';
import { isHandoffEligible } from '@/audio/handoffState';

/** Stable across transcript refetches, navigation, and app relaunches. When the turn's
 *  canonical text is provided, the id is CONTENT-QUALIFIED: retry branches (U.14) can hold
 *  different text at the same assistant index, and audio identity (current track, prep,
 *  narration/error caches, handoff recovery) must never treat one branch's narration as its
 *  sibling's. Identical text hashes identically — which is correct: same words, same audio. */
export function messageAudioId(
  project: string,
  slug: string,
  assistantIndex: number,
  canonical?: string,
): string {
  const base = `${project}:${slug}:${assistantIndex}`;
  return canonical ? `${base}#c${contentTag(canonical)}` : base;
}

/** Tiny stable digest (djb2, base36) — an identity discriminator, not cryptography. */
function contentTag(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

interface QueueRequest {
  id: string;
  title: string;
  text: string;
}

/** Reattach persisted listening handoffs after navigation, suspension, or a chat-poll 404. */
export function useListeningHandoffRecovery({
  enabled,
  project,
  slug,
  title,
  transcript,
  enqueueJob,
}: {
  enabled: boolean;
  project: string | null;
  slug: string | null;
  title: string;
  transcript: TranscriptEntry[];
  enqueueJob: (
    request: QueueRequest,
    audioJobId: string,
    project: string | null,
    chatJobId?: string | null,
  ) => void;
}) {
  useEffect(() => {
    if (!enabled || !project || !slug) return;
    let active = true;
    void (async () => {
      for (const entry of transcript) {
        if (!active) return;
        if (entry.role !== 'assistant' || entry.delivery_mode !== 'listening'
            || !entry.chat_job_id || !entry.audio_job_id || entry.audio_error
            || !(await isHandoffEligible(entry.chat_job_id))) continue;
        enqueueJob(
          {
            id: messageAudioId(project, slug, entry.assistant_index, entry.canonical),
            title,
            text: entry.canonical,
          },
          entry.audio_job_id,
          project,
          entry.chat_job_id,
        );
      }
    })();
    return () => { active = false; };
  }, [enabled, enqueueJob, project, slug, title, transcript]);
}
