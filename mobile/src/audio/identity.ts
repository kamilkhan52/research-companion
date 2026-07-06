import { useEffect } from 'react';

import type { TranscriptEntry } from '@/api/types';

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
  enqueueJob: (request: QueueRequest, audioJobId: string, project: string | null) => void;
}) {
  useEffect(() => {
    if (!enabled || !project || !slug) return;
    for (const entry of transcript) {
      if (entry.role !== 'assistant' || entry.delivery_mode !== 'listening'
          || !entry.audio_job_id || entry.audio_error) continue;
      enqueueJob(
        {
          id: messageAudioId(project, slug, entry.assistant_index),
          title,
          text: entry.canonical,
        },
        entry.audio_job_id,
        project,
      );
    }
  }, [enabled, enqueueJob, project, slug, title, transcript]);
}
