import { useEffect, useMemo, useState } from 'react';
import TrackPlayer, { useActiveTrack } from 'react-native-track-player';

import { splitSentences, type SentenceBoundary } from '../../sentence-seek';
import { activeSentenceIndex, globalFraction } from '@/audio/transcriptSync';
import { useSmoothPosition } from '@/audio/useSmoothPosition';

interface NarrationTrackLike {
  id?: unknown;
  slotId?: unknown;
  narration?: unknown;
  segmentIndex?: unknown;
  sentenceText?: unknown;
}

interface NarrationProgressLike {
  position: number;
  duration: number;
}

/** The passive highlight leads the physical playhead slightly so it reads in sync. Explicit
 * sentence jumps use a larger lead below: the player intentionally seeks 0.75 s before the
 * boundary, but the requested sentence must highlight immediately. */
export const PASSIVE_NARRATION_LEAD_SECONDS = 0.35;

export interface NarrationCursor {
  slotId: string | null;
  narration: string;
  sentences: SentenceBoundary[];
  activeIndex: number;
  duration: number;
  progressive: boolean;
  segmentLengths: number[];
}

/** Build the same playback-to-sentence snapshot outside React. The mini-player uses this after
 * an awaited seek so its one-shot landing names the POST-seek sentence instead of racing the
 * Discussion hook's next 500 ms progress poll. */
export function narrationCursorSnapshot(
  trackValue: unknown,
  queueValues: unknown[],
  progress: NarrationProgressLike,
  leadSeconds = PASSIVE_NARRATION_LEAD_SECONDS,
  preparedSentences?: SentenceBoundary[],
): NarrationCursor {
  const track = trackValue as NarrationTrackLike | undefined;
  const queue = queueValues as NarrationTrackLike[];
  const narration = typeof track?.narration === 'string' ? track.narration : '';
  const sentences = preparedSentences ?? splitSentences(narration);
  const slotId = track?.slotId != null
    ? String(track.slotId)
    : track?.id != null ? String(track.id) : null;
  const activeSegment = typeof track?.segmentIndex === 'number' ? track.segmentIndex : -1;
  const segmentLengths: number[] = [];
  if (slotId != null && activeSegment >= 0) {
    for (const queued of queue) {
      const queuedSlot = queued.slotId != null ? String(queued.slotId) : String(queued.id);
      if (queuedSlot !== slotId || typeof queued.segmentIndex !== 'number') continue;
      segmentLengths[queued.segmentIndex] = String(queued.sentenceText ?? '').length || 1;
    }
  }
  const progressive = activeSegment >= 0 && segmentLengths.length > 0;
  // A progressive track's duration belongs to one segment, not the whole narration. Until its
  // queue metadata is available, showing no highlight is safer than confidently jumping to a
  // sentence computed from incompatible scales.
  const fraction = progress.duration <= 0 || (activeSegment >= 0 && !progressive)
    ? -1
    : progressive
      ? globalFraction({
          segLens: segmentLengths,
          activeSeg: activeSegment,
          within: (progress.position + leadSeconds) / progress.duration,
          totalChars: narration.length,
        })
      : Math.min(1, (progress.position + leadSeconds) / progress.duration);

  return {
    slotId,
    narration,
    sentences,
    activeIndex: activeSentenceIndex(sentences, fraction),
    duration: progress.duration,
    progressive,
    segmentLengths,
  };
}

/** One playback-to-spoken-sentence contract shared by the full player and Discussion. */
export function useNarrationCursor(narrationOverride?: string): NarrationCursor {
  const track = useActiveTrack();
  const { position, duration } = useSmoothPosition();
  const slotId = track?.slotId != null
    ? String(track.slotId)
    : track?.id != null ? String(track.id) : null;
  const activeSegment = typeof track?.segmentIndex === 'number' ? track.segmentIndex : -1;
  const narration = narrationOverride
    ?? (typeof track?.narration === 'string' ? track.narration : '');
  const sentences = useMemo(() => splitSentences(narration), [narration]);
  const [queue, setQueue] = useState<unknown[]>([]);

  useEffect(() => {
    if (slotId == null || activeSegment < 0) {
      setQueue((current) => (current.length ? [] : current));
      return;
    }
    let cancelled = false;
    void TrackPlayer.getQueue().then((queue) => {
      if (cancelled) return;
      setQueue(queue);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeSegment, slotId]);

  return useMemo(() => {
    const sourceTrack = narrationOverride == null
      ? track
      : { ...(track as object | undefined), narration: narrationOverride };
    return narrationCursorSnapshot(sourceTrack, queue, { position, duration }, undefined, sentences);
  }, [duration, narrationOverride, position, queue, sentences, track]);
}
