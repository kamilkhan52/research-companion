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


test('the node growth cap is computed inline, not via an imported helper', () => {
  // Same boundary as the zoom quantizer: this runs in a `useAnimatedStyle` worklet on the UI
  // thread, so calling an imported function would crash the Map tab exactly as #295 did.
  const start = source.indexOf('const nodeCounterScale');
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('}));', start));

  expect(block).toContain('NODE_GROWTH_CAP');
  expect(block).toMatch(/Math\.min\(/);
  // Only the shared value and the constant may be read; no helper call.
  expect(block).not.toMatch(/\b(nodeRadius|zoomBucket|bucketScale|pickVisibleLabels)\s*\(/);
});

test('nodes grow with zoom up to the cap and hold above it', () => {
  // The property the constant encodes, stated so a change to the formula has to be deliberate:
  // below the cap the circle scales with the canvas (factor 1), above it the factor falls as
  // 1/scale so the on-screen size stops changing.
  const factor = (scale: number, cap: number) => Math.min(1, cap / scale);
  const cap = 0.7;
  expect(factor(0.25, cap)).toBe(1);                    // zoomed out: unchanged from today
  expect(factor(cap, cap)).toBe(1);                     // at the cap: still unchanged
  expect(factor(1.4, cap)).toBeCloseTo(0.5);            // 2x past it: half, so screen size holds
  expect(factor(2.8, cap) * 2.8).toBeCloseTo(cap);      // screen size is constant above the cap
});
