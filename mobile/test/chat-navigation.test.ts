// DR-115 — the landmark geometry, tested away from any list. The transcript is INVERTED, so
// "up" is a larger index; every assertion below would flip sign if that were ever forgotten.

import {
  landmarkAfter,
  LIVE_EDGE,
  stepDown,
  stepUp,
  type NavTarget,
} from '@/lib/chatNavigation';

const COUNT = 6; // indices 0 (newest) … 5 (oldest)

test('the first step up aims at the message the reader is inside, not the one above it', () => {
  // Deep inside one long response: it occupies the top of the viewport AND continues below.
  expect(stepUp({ landmark: null, topIndex: 2, count: COUNT })).toEqual<NavTarget>({
    kind: 'index',
    index: 2,
  });
});

test('a second step up continues past that message to the one above', () => {
  expect(stepUp({ landmark: 2, topIndex: 2, count: COUNT })).toEqual<NavTarget>({
    kind: 'index',
    index: 3,
  });
});

test('stepping down goes straight to the next newer message — there is no landmark between', () => {
  expect(stepDown({ landmark: null, topIndex: 2, count: COUNT })).toEqual<NavTarget>({
    kind: 'index',
    index: 1,
  });
  expect(stepDown({ landmark: 3, topIndex: 3, count: COUNT })).toEqual<NavTarget>({
    kind: 'index',
    index: 2,
  });
});

test('stepping up past the oldest message resolves to the top of the thread', () => {
  // The oldest message's top IS the top of the thread, so index count-1 is never a target:
  // scrollToEnd reaches it exactly, past the list's header padding.
  expect(stepUp({ landmark: COUNT - 2, topIndex: null, count: COUNT })).toEqual<NavTarget>({
    kind: 'oldest',
  });
  expect(stepUp({ landmark: COUNT - 1, topIndex: null, count: COUNT })).toEqual<NavTarget>({
    kind: 'oldest',
  });
});

test('stepping down past the newest message resolves to the live edge', () => {
  expect(stepDown({ landmark: 0, topIndex: 0, count: COUNT })).toEqual<NavTarget>({ kind: 'live' });
});

test('the live edge is remembered as BELOW the newest message, so stepping back up shows it', () => {
  const landmark = landmarkAfter({ kind: 'live' }, COUNT);
  expect(landmark).toBe(LIVE_EDGE);
  // Without the -1 sentinel this would skip message 0 entirely.
  expect(stepUp({ landmark, topIndex: 0, count: COUNT })).toEqual<NavTarget>({
    kind: 'index',
    index: 0,
  });
});

test('the top of the thread is remembered as the oldest message, so stepping down works from it', () => {
  const landmark = landmarkAfter({ kind: 'oldest' }, COUNT);
  expect(landmark).toBe(COUNT - 1);
  expect(stepDown({ landmark, topIndex: null, count: COUNT })).toEqual<NavTarget>({
    kind: 'index',
    index: COUNT - 2,
  });
});

test('with nothing viewable yet, stepping still resolves rather than doing nothing', () => {
  expect(stepUp({ landmark: null, topIndex: null, count: COUNT })).toEqual<NavTarget>({
    kind: 'index',
    index: 0,
  });
  expect(stepDown({ landmark: null, topIndex: null, count: COUNT })).toEqual<NavTarget>({
    kind: 'live',
  });
});

test('an empty transcript has no landmarks in either direction', () => {
  expect(stepUp({ landmark: null, topIndex: null, count: 0 })).toBeNull();
  expect(stepDown({ landmark: null, topIndex: null, count: 0 })).toBeNull();
});

test('a one-message thread only ever resolves to its two extremes', () => {
  expect(stepUp({ landmark: null, topIndex: 0, count: 1 })).toEqual<NavTarget>({ kind: 'oldest' });
  expect(stepDown({ landmark: null, topIndex: 0, count: 1 })).toEqual<NavTarget>({ kind: 'live' });
  expect(landmarkAfter({ kind: 'oldest' }, 1)).toBe(0);
});

test('landmarkAfter never returns a negative index for the top of an empty thread', () => {
  expect(landmarkAfter({ kind: 'oldest' }, 0)).toBe(0);
});

test('a full round trip up and back down returns to where it started', () => {
  let landmark: number | null = null;
  const visited: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const target = stepUp({ landmark, topIndex: 1, count: COUNT })!;
    landmark = landmarkAfter(target, COUNT);
    visited.push(landmark);
  }
  expect(visited).toEqual([1, 2, 3]);
  for (let i = 0; i < 2; i += 1) {
    const target = stepDown({ landmark, topIndex: 1, count: COUNT })!;
    landmark = landmarkAfter(target, COUNT);
  }
  expect(landmark).toBe(1);
});
