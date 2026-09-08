// DR-151 — "only activate it on significant human scroll".

import {
  createSeekDetector,
  FLING_GRACE_MS,
  SEEK_FALLBACK_PX,
  SEEK_VIEWPORT_FRACTION,
} from '@/lib/seekGesture';

const VIEWPORT = 800;
const SEEK = VIEWPORT * SEEK_VIEWPORT_FRACTION + 1;

test('a scroll no finger started never counts, however far it travels', () => {
  // The whole of the complaint: narration follow, the streaming pin and every navigator
  // landing arrive here as ordinary scroll frames, and they used to wake the rail.
  const seek = createSeekDetector();
  expect(seek.scroll(0, VIEWPORT)).toBe(false);
  expect(seek.scroll(10_000, VIEWPORT)).toBe(false);
  seek.momentumBegin(); // a programmatic animated scroll also emits these on Android
  expect(seek.scroll(20_000, VIEWPORT)).toBe(false);
});

test('a small drag is reading, not seeking', () => {
  const seek = createSeekDetector();
  seek.beginDrag(1000);
  expect(seek.scroll(1000 + VIEWPORT * SEEK_VIEWPORT_FRACTION - 1, VIEWPORT)).toBe(false);
  expect(seek.scroll(1000 - VIEWPORT * SEEK_VIEWPORT_FRACTION + 1, VIEWPORT)).toBe(false);
});

test('half a screen of drag is a seek, in either direction, and is announced once', () => {
  const down = createSeekDetector();
  down.beginDrag(1000);
  expect(down.scroll(1000 + SEEK, VIEWPORT)).toBe(true);
  // Once per gesture: the rail's own idle countdown decides when it settles back.
  expect(down.scroll(1000 + SEEK * 2, VIEWPORT)).toBe(false);

  const up = createSeekDetector();
  up.beginDrag(5000);
  expect(up.scroll(5000 - SEEK, VIEWPORT)).toBe(true);
});

test('distance is measured from where the drag began, not frame to frame', () => {
  // A slow deliberate journey is still a journey; a hundred one-pixel frames are not a
  // hundred separate nudges.
  const seek = createSeekDetector();
  seek.beginDrag(0);
  let woke = false;
  for (let y = 0; y <= SEEK; y += 4) woke = seek.scroll(y, VIEWPORT) || woke;
  expect(woke).toBe(true);
});

test('a flick counts, because most of its travel happens after the finger has gone', () => {
  let clock = 1000;
  const seek = createSeekDetector(() => clock);
  seek.beginDrag(0);
  expect(seek.scroll(120, VIEWPORT)).toBe(false); // the flick itself moved barely anything
  seek.endDrag();
  clock += 16;
  seek.momentumBegin();
  expect(seek.scroll(SEEK, VIEWPORT)).toBe(true);
  seek.momentumEnd();
  // And the window is shut again: the next programmatic scroll must not wake it.
  expect(seek.scroll(SEEK * 4, VIEWPORT)).toBe(false);
});

test('momentum that no finger threw is refused, even mid-session', () => {
  let clock = 1000;
  const seek = createSeekDetector(() => clock);
  seek.beginDrag(0);
  seek.endDrag();
  clock += FLING_GRACE_MS + 1; // the reader stopped; some time later the app scrolls itself
  seek.momentumBegin();
  expect(seek.scroll(SEEK * 3, VIEWPORT)).toBe(false);
});

test('a drag that ends without a flick closes the window', () => {
  const seek = createSeekDetector();
  seek.beginDrag(0);
  seek.endDrag();
  expect(seek.scroll(SEEK * 3, VIEWPORT)).toBe(false);
});

test('with no viewport height in the event it falls back to a fixed distance', () => {
  const seek = createSeekDetector();
  seek.beginDrag(0);
  expect(seek.scroll(SEEK_FALLBACK_PX - 1)).toBe(false);
  expect(seek.scroll(SEEK_FALLBACK_PX)).toBe(true);

  const zero = createSeekDetector();
  zero.beginDrag(0);
  expect(zero.scroll(SEEK_FALLBACK_PX - 1, 0)).toBe(false);
});
