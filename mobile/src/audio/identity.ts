import { useEffect } from 'react';

import type { TranscriptEntry } from '@/api/types';
import { isHandoffEligible } from '@/audio/handoffState';

/** Stable across transcript refetches, navigation, and app relaunches. */
export function messageAudioId(project: string, slug: string, assistantIndex: number): string {
  return `${project}:${slug}:${assistantIndex}`;
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
            id: messageAudioId(project, slug, entry.assistant_index),
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
