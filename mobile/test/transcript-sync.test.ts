import { activeSentenceIndex, globalFraction, segmentForChar } from '@/audio/transcriptSync';

// Two segments of 100 chars each over a 200-char narration.
const segLens = [100, 100];

test('global fraction accounts for segments before the active one', () => {
  // Halfway through segment 0 -> 25% of the whole narration.
  expect(globalFraction({ segLens, activeSeg: 0, within: 0.5, totalChars: 200 })).toBeCloseTo(0.25);
  // Halfway through segment 1 -> 75%, NOT 50% (the single-track bug).
  expect(globalFraction({ segLens, activeSeg: 1, within: 0.5, totalChars: 200 })).toBeCloseTo(0.75);
});

test('global fraction stays exact when later segments are not loaded yet', () => {
  // Only segment 0 known so far, but totalChars is the full narration length.
  expect(globalFraction({ segLens: [100], activeSeg: 0, within: 1, totalChars: 200 })).toBeCloseTo(0.5);
});

test('global fraction is -1 before duration is known', () => {
  expect(globalFraction({ segLens, activeSeg: 0, within: 0.5, totalChars: 0 })).toBe(-1);
});

test('active sentence index uses the whole-narration fraction', () => {
  const sentences = [
    { startFrac: 0, endFrac: 0.5 },
    { startFrac: 0.5, endFrac: 1 },
  ];
  expect(activeSentenceIndex(sentences, 0.75)).toBe(1);
  expect(activeSentenceIndex(sentences, -1)).toBe(-1);
});

test('segmentForChar maps a target sentence back to its segment', () => {
  // char 150 of 200 -> segment 1, halfway in.
  expect(segmentForChar(segLens, 150)).toEqual({ index: 1, within: 0.5 });
  // char 0 -> start of segment 0.
  expect(segmentForChar(segLens, 0)).toEqual({ index: 0, within: 0 });
});
