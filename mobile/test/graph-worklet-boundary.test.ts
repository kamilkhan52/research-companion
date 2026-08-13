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

test('the reaction result callback calls nothing but Math and runOnJS', () => {
  // Same UI-thread boundary as the prepare block, added when stepScale stepping moved in here:
  // the result callback runs as a worklet too, so an imported helper call is the same #295
  // crash. Comments are stripped first — prose like "every node (labelledIds …)" would
  // otherwise read as a call.
  const start = source.indexOf('(bucket, previous)');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('  );', start);
  expect(end).toBeGreaterThan(start);
  const body = source
    .slice(start, end)
    .replace(/\/\/[^\n]*/g, '');
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return']);
  const calls = [...body.matchAll(/([A-Za-z_$][\w$.]*)\s*\(/g)]
    .map((m) => m[1])
    .filter((name) => !KEYWORDS.has(name));
  // `setLabelBucket` is deliberately NOT allow-listed: it only appears wrapped as
  // `runOnJS(setLabelBucket)(…)`, where it precedes `)` rather than `(` and so never matches
  // — a DIRECT `setLabelBucket(…)` call from this worklet would be the crash, and should fail.
  const disallowed = calls.filter((name) => !name.startsWith('Math.') && name !== 'runOnJS');
  expect(disallowed).toEqual([]);
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
  // No CALL to anything but Math.*: an allow-list, because banning a list of known helper names
  // would let an arbitrary new import through while reproducing the same crash.
  const calls = [...block.matchAll(/([A-Za-z_$][\w$.]*)\s*\(/g)].map((m) => m[1]);
  const disallowed = calls.filter((name) => !name.startsWith('Math.') && name !== 'useAnimatedStyle');
  expect(disallowed).toEqual([]);
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


test('the label lift follows the circle rather than the uncapped radius', () => {
  // The circle contracts toward its centre once the cap engages; a label anchored at the old
  // `r * 2` is left stranded in empty space — ~80px on a large node at full zoom.
  expect(source).toContain('r + r * nodeShrink + 3');
  expect(source).not.toMatch(/top:\s*r \* 2 \+ 3/);
});
