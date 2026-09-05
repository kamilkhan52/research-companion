import { useEffect, useMemo, useState } from 'react';
import TrackPlayer, { useActiveTrack } from 'react-native-track-player';

import { splitSentences, type SentenceBoundary } from '../../sentence-seek';
import { activeSentenceIndex, globalFraction } from '@/audio/transcriptSync';
import { useSmoothPosition } from '@/audio/useSmoothPosition';

export interface NarrationCursor {
  slotId: string | null;
  narration: string;
  sentences: SentenceBoundary[];
  activeIndex: number;
  duration: number;
  progressive: boolean;
  segmentLengths: number[];
}

/** One playback-to-spoken-sentence contract shared by the full player and Discussion. */
export function useNarrationCursor(narrationOverride?: string): NarrationCursor {
  const track = useActiveTrack();
  const narration = narrationOverride ?? (typeof track?.narration === 'string' ? track.narration : '');
  const sentences = useMemo(() => splitSentences(narration), [narration]);
  const { position, duration } = useSmoothPosition();
  const slotId = track?.slotId != null
    ? String(track.slotId)
    : track?.id != null ? String(track.id) : null;
  const activeSegment = typeof track?.segmentIndex === 'number' ? track.segmentIndex : -1;
  const [segmentLengths, setSegmentLengths] = useState<number[]>([]);

  useEffect(() => {
    if (slotId == null || activeSegment < 0) {
      setSegmentLengths((current) => (current.length ? [] : current));
      return;
    }
    let cancelled = false;
    void TrackPlayer.getQueue().then((queue) => {
      if (cancelled) return;
      const lengths: number[] = [];
      for (const queued of queue) {
        const queuedSlot = queued.slotId != null ? String(queued.slotId) : String(queued.id);
        if (queuedSlot !== slotId || typeof queued.segmentIndex !== 'number') continue;
        lengths[queued.segmentIndex] = String(queued.sentenceText ?? '').length || 1;
      }
      setSegmentLengths(lengths);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeSegment, slotId]);

  const progressive = activeSegment >= 0 && segmentLengths.length > 0;
  const fraction = duration <= 0
    ? -1
    : progressive
      ? globalFraction({
          segLens: segmentLengths,
          activeSeg: activeSegment,
          within: (position + 0.35) / duration,
          totalChars: narration.length,
        })
      : Math.min(1, (position + 0.35) / duration);

  return {
    slotId,
    narration,
    sentences,
    activeIndex: activeSentenceIndex(sentences, fraction),
    duration,
    progressive,
    segmentLengths,
  };
}
