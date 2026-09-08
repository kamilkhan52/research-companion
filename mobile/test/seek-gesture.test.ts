// DR-151 — "only activate it on significant human scroll".

import {
  createSeekDetector,
  DRAG_IDLE_MS,
  FLING_GRACE_MS,
  GESTURE_IDLE_MS,
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

test('a fling cancelled by a tap does not leave the window open for the app to use', () => {
  // Android cancels a fling on touch-down without emitting a momentum end, and a tap that
  // never becomes a drag emits no begin-drag either. Nothing would close the window, so the
  // next scroll the APP made would wake the rail — the exact thing this module prevents
  // (Opus review of #508).
  let clock = 1000;
  const seek = createSeekDetector(() => clock);
  seek.beginDrag(0);
  seek.endDrag();
  clock += 16;
  seek.momentumBegin();
  clock += 16;
  expect(seek.scroll(100, VIEWPORT)).toBe(false); // still under the threshold when tapped
  // …the reader taps to stop it. No further frames; no momentumEnd ever arrives.
  clock += GESTURE_IDLE_MS + 1;
  expect(seek.scroll(SEEK * 4, VIEWPORT)).toBe(false);
  // And it stays shut however long the app goes on scrolling itself.
  clock += 10_000;
  expect(seek.scroll(SEEK * 8, VIEWPORT)).toBe(false);
});

test('a finger held still mid-drag has not ended its gesture', () => {
  // The idle expiry must not apply while a finger is down: a pause is a pause, and a reader
  // who stops, thinks, then keeps dragging is still on one journey.
  let clock = 1000;
  const seek = createSeekDetector(() => clock);
  seek.beginDrag(0);
  expect(seek.scroll(100, VIEWPORT)).toBe(false);
  clock += GESTURE_IDLE_MS * 5;
  expect(seek.scroll(SEEK, VIEWPORT)).toBe(true);
});

test('momentum that keeps arriving is one continuous gesture', () => {
  // The expiry closes a gesture that STOPPED, never one that is still travelling: frames
  // arrive about every 16 ms while anything really moves.
  let clock = 1000;
  const seek = createSeekDetector(() => clock);
  seek.beginDrag(0);
  seek.endDrag();
  clock += 16;
  seek.momentumBegin();
  let woke = false;
  // Deliberately longer than GESTURE_IDLE_MS of clock: a real Android fling coasts well past
  // it, so the expiry must be refreshed by the frames rather than killing the fling mid-flight.
  // Without the refresh this loop stops counting after 400 ms and never reaches the threshold.
  const frames = Math.ceil((GESTURE_IDLE_MS / 16) * 3);
  for (let i = 1; i <= frames; i += 1) {
    clock += 16;
    woke = seek.scroll((SEEK / frames) * i, VIEWPORT) || woke;
  }
  expect(clock - 1000).toBeGreaterThan(GESTURE_IDLE_MS);
  expect(woke).toBe(true);
});

test('a drag whose end event is lost still ends', () => {
  // `onScrollEndDrag` can go missing if the list is re-keyed under a held finger. Without a
  // ceiling of its own that latches `dragging` and disarms the expiry for good (Opus review).
  let clock = 1000;
  const seek = createSeekDetector(() => clock);
  seek.beginDrag(0);
  expect(seek.scroll(100, VIEWPORT)).toBe(false);
  clock += DRAG_IDLE_MS + 1;
  expect(seek.scroll(SEEK * 4, VIEWPORT)).toBe(false);
  // …and it is properly shut, not merely skipped once.
  clock += 16;
  expect(seek.scroll(SEEK * 8, VIEWPORT)).toBe(false);
});
