import { readFileSync } from 'fs';
import { join } from 'path';

// A source-level guard, which is unusual and deliberate.
//
// #295 shipped the Map tab crashing: `useAnimatedReaction`'s prepare block runs on the UI thread
// and called `zoomBucket`, an imported non-worklet function — a hard crash under Reanimated 4.
// Jest cannot catch that class of bug at all: `jest.config.js` resolves react-native-worklets to
// its mockable build, so everything runs on one thread and the boundary does not exist.
//
// So the only thing that can guard the regression here is the source itself. Narrow on purpose:
// it asserts the one pattern that crashed, not the formatting around it.
const source = readFileSync(
  join(__dirname, '..', 'src', 'components', 'graph', 'GraphCanvas.tsx'),
  'utf8',
);

function animatedReactionPrepareBlock(): string {
  const start = source.indexOf('useAnimatedReaction(');
  expect(start).toBeGreaterThan(-1);
  // Up to the reaction's second argument — the prepare block is everything before it.
  const end = source.indexOf('(bucket, previous)', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test('the zoom quantizer does not call an imported function on the UI thread', () => {
  const prepare = animatedReactionPrepareBlock();
  expect(prepare).not.toMatch(/zoomBucket\s*\(/);
});

test('the quantizer is inlined against the shared constant, so it cannot drift', () => {
  const prepare = animatedReactionPrepareBlock();
  expect(prepare).toContain('BUCKETS_PER_DOUBLING');
  expect(prepare).toMatch(/Math\.log2/);
});
