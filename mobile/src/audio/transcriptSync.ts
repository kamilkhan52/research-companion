// Map progressive-segment playback back onto whole-narration sentence positions.
//
// Phase 2.3 (#28) split narration into multiple TrackPlayer tracks (one per TTS segment — a
// chunk of several sentences under the API char limit). Each track reports its OWN
// position/duration, so treating that as a fraction of the whole narration (as the single-track
// transcript did) makes the highlight reset every segment and drift 5–10 sentences off. These
// helpers rebuild a whole-narration fraction from the active segment + the char lengths of the
// segments before it. Earlier segments are always already loaded (playback reached the active
// one), so `charsBefore` is exact even while later segments are still being appended.

/** Whole-narration fraction [0,1] for a position `within` the active segment, or -1 if unknown.
 *  `segLens` are per-segment character lengths (index = segmentIndex); `totalChars` is the full
 *  narration length. */
export function globalFraction(opts: {
  segLens: number[];
  activeSeg: number;
  within: number; // 0..1 within the active segment
  totalChars: number;
}): number {
  const { segLens, activeSeg, within, totalChars } = opts;
  if (!(totalChars > 0) || activeSeg < 0) return -1;
  let before = 0;
  for (let k = 0; k < activeSeg; k += 1) before += segLens[k] ?? 0;
  const segLen = segLens[activeSeg] ?? 0;
  const clamped = Math.min(1, Math.max(0, within));
  return Math.min(1, (before + clamped * segLen) / totalChars);
}

/** The active sentence for a whole-narration fraction, or -1 before playback/first boundary. */
export function activeSentenceIndex(
  sentences: { startFrac: number; endFrac: number }[],
  frac: number,
): number {
  if (frac < 0) return -1;
  return sentences.findIndex((s) => frac >= s.startFrac && frac < s.endFrac);
}

/** Which segment (and fraction within it) a target character position falls in — the inverse of
 *  globalFraction, used to seek from a tapped sentence to the right segment track. */
export function segmentForChar(
  segLens: number[],
  targetChar: number,
): { index: number; within: number } {
  if (!segLens.length) return { index: 0, within: 0 };
  let acc = 0;
  for (let k = 0; k < segLens.length; k += 1) {
    const len = segLens[k] ?? 0;
    if (acc + len > targetChar || k === segLens.length - 1) {
      return { index: k, within: len > 0 ? Math.min(1, Math.max(0, (targetChar - acc) / len)) : 0 };
    }
    acc += len;
  }
  return { index: segLens.length - 1, within: 0 };
}
