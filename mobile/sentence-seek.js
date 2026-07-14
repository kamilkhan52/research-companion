// Shared sentence parsing + seeking for the React UI and the headless TrackPlayer service.
// Plain CommonJS keeps it loadable from service.js while sentence-seek.d.ts gives TS callers types.

// Sentence boundaries are estimated from text proportions, and Android MP3 seeks may resolve a
// little after their requested timestamp. Land slightly before semantic boundaries so the first
// words are audible. This applies only to sentence jumps; scrubber and ±15s seeks remain exact.
const SENTENCE_SEEK_PREROLL_SECONDS = 0.75;
const SENTENCE_BOUNDARY_LOOKAHEAD_SECONDS = 0.5 + SENTENCE_SEEK_PREROLL_SECONDS;

function sentenceSeekPosition(estimatedStart, prerollSeconds = SENTENCE_SEEK_PREROLL_SECONDS) {
  if (!Number.isFinite(estimatedStart)) return 0;
  return Math.max(0, estimatedStart - Math.max(0, prerollSeconds));
}

function splitSentences(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const parts = [];
  let start = 0;
  const boundary = /([.!?]+)["')\]]*(?:\s+|$)/g;
  let match;
  while ((match = boundary.exec(trimmed))) {
    const end = match.index + match[0].length;
    if (match[1] === '.' && /(?:^|[\s."'(\[])[A-Za-z]$/.test(trimmed.slice(start, match.index))) {
      const next = trimmed[end];
      if (next !== undefined && !/[A-Z0-9"'(\[]/.test(next)) continue;
    }
    parts.push(trimmed.slice(start, end));
    start = end;
  }
  if (start < trimmed.length) parts.push(trimmed.slice(start));
  const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;
  let consumed = 0;
  return parts.flatMap((part) => {
    const begin = consumed;
    consumed += part.length;
    const sentence = part.trim();
    return sentence
      ? [{ text: sentence, startFrac: begin / total, endFrac: consumed / total }]
      : [];
  });
}

async function seekSentence(player, direction, fallbackSeconds = 15) {
  const [track, progress] = await Promise.all([player.getActiveTrack(), player.getProgress()]);
  const text = track && (track.sentenceText || track.narration);
  const sentences = splitSentences(text);
  if (!sentences.length || !progress.duration) {
    await player.seekBy(direction * fallbackSeconds);
    return 'fallback';
  }
  const starts = sentences.map((sentence) => sentence.startFrac * progress.duration);
  let target;
  if (direction > 0) {
    // Include the pre-roll in the semantic playhead. Otherwise a second press immediately after
    // a sentence jump can rediscover the same boundary because the physical playhead is early.
    target = starts.find((value) => value > progress.position + SENTENCE_BOUNDARY_LOOKAHEAD_SECONDS);
  } else {
    // Step to the sentence before the one currently playing — never just restart the
    // current sentence. "Currently playing" is the last sentence whose start is at or
    // before the playhead. If there's no earlier sentence in this segment (already in
    // the first one), leave target unset so the skipToPrevious/segment-crossing fallback
    // below still runs, same as before.
    const currentIndex = starts.reduce(
      (idx, value, i) => (
        value <= progress.position + SENTENCE_BOUNDARY_LOOKAHEAD_SECONDS ? i : idx
      ),
      0,
    );
    target = currentIndex > 0 ? starts[currentIndex - 1] : undefined;
  }
  if (target != null) {
    await player.seekTo(sentenceSeekPosition(target));
    return 'sentence';
  }
  const skip = direction > 0 ? player.skipToNext : player.skipToPrevious;
  if (typeof skip === 'function') {
    try {
      await skip.call(player);
      return 'track';
    } catch {
      // No adjacent segment: retain the explicit ±15-second fallback.
    }
  }
  await player.seekBy(direction * fallbackSeconds);
  return 'fallback';
}

module.exports = {
  SENTENCE_SEEK_PREROLL_SECONDS,
  sentenceSeekPosition,
  splitSentences,
  seekSentence,
};
