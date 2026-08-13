// The texToSvg cache's eviction policy. It used to CLEAR wholesale at capacity — and streaming
// mints a fresh cache key for every partial TeX span, so one math-heavy turn could wipe the
// cache and force every equation on screen to re-convert in the same frame. LRU instead:
// a hit refreshes recency; insertion at capacity drops only the least-recently-used entry.
// Real MathJax — it is pure JS and runs under jest; cache behavior is observed through object
// identity (a hit returns the same object, a re-conversion a fresh one). Each test re-requires
// the module so the cache starts empty and the fill arithmetic is exact.

type MathLib = typeof import('@/lib/math');

let math: MathLib;

beforeEach(() => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  math = require('@/lib/math');
});

test('a repeated formula is served from cache (same object)', () => {
  const first = math.texToSvg('a + b', false);
  expect(first).not.toBeNull();
  expect(math.texToSvg('a + b', false)).toBe(first);
});

test('eviction drops the least-recently-used formula, not everything', () => {
  const kept = math.texToSvg('a_{1} + b_{1}', false);
  const dropped = math.texToSvg('c_{1} + d_{1}', false);
  expect(kept).not.toBeNull();
  expect(dropped).not.toBeNull();

  // Touch `kept` so `dropped` becomes the least-recently-used entry, then insert enough fresh
  // formulas to overflow capacity by exactly one: 2 entries + (MAX-1) inserts = MAX+1 demands,
  // so precisely one eviction happens.
  expect(math.texToSvg('a_{1} + b_{1}', false)).toBe(kept);
  for (let i = 0; i < math.SVG_CACHE_MAX - 1; i++) {
    math.texToSvg(`x_{${i}}`, false);
  }

  // `dropped` is gone (fresh conversion → new object); `kept` is still the cached object —
  // under the old clear-all both would have been wiped.
  expect(math.texToSvg('a_{1} + b_{1}', false)).toBe(kept);
  expect(math.texToSvg('c_{1} + d_{1}', false)).not.toBe(dropped);
});
