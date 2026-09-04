// DR-115 — where a landmark step lands in the discussion transcript.
//
// Kamil: "jump around the chat thread instead of scrolling… get to the top of the last agent
// response or their own last response or keep jumping to their own or last ai response or to
// the bottom of a response." Every one of those is the SAME landmark — the top edge of a
// message — so the rail steps between message tops rather than by pixels or by screens. A
// thread of unequal, often screen-tall responses has no other stable boundary to aim at.
//
// The list is INVERTED (index 0 is the newest message; larger indices are older), so "up",
// toward the start of the conversation, means a LARGER index. That inversion is the part that
// is easy to get backwards, which is why the geometry lives here as pure functions and is
// tested without a list, a viewport or a native scroll.
//
// Two asymmetries are deliberate:
//  • Stepping UP with no remembered landmark aims at the message the reader is currently
//    INSIDE (`topIndex`, the row at the visual top of the viewport), not the one above it.
//    That is the common case — deep in one long response, wanting its head. Only the next
//    press continues past it.
//  • Stepping DOWN has no such intermediate landmark below the reader, so it goes straight to
//    the next newer message's top — which is also, within a message gap, the foot of the
//    response they were reading.

/** Landmark value meaning "below the newest message", i.e. parked at the live edge. Stepping
 *  up from here lands on the newest message's own top rather than skipping it. */
export const LIVE_EDGE = -1;

export type NavTarget =
  | { kind: 'live' }
  | { kind: 'oldest' }
  | { kind: 'index'; index: number };

export interface StepInput {
  /** The landmark the previous step landed on, or null once the reader has scrolled by hand
   *  (a manual scroll makes the remembered position meaningless). */
  landmark: number | null;
  /** Largest currently-viewable index = the message at the VISUAL TOP of the viewport. Null
   *  before the list has reported any viewable rows. */
  topIndex: number | null;
  /** Number of rows in the message list. */
  count: number;
}

/** Toward the start of the conversation. Null when there is nothing to move to. */
export function stepUp({ landmark, topIndex, count }: StepInput): NavTarget | null {
  if (count <= 0) return null;
  const target = landmark !== null ? landmark + 1 : topIndex ?? 0;
  // The oldest message's top IS the top of the thread. It stays its own kind rather than
  // `{ index: count - 1 }` so the rail's "start of thread" control can name it without knowing
  // the count — but it is that row, and the navigator lands it exactly like any other. (It used
  // to get its own `scrollToEnd`, which cannot clear the floating header: DR-127.)
  if (target >= count - 1) return { kind: 'oldest' };
  return { kind: 'index', index: target };
}

/** Toward the newest message. Null when there is nothing to move to. */
export function stepDown({ landmark, topIndex, count }: StepInput): NavTarget | null {
  if (count <= 0) return null;
  const target = (landmark !== null ? landmark : topIndex ?? 0) - 1;
  if (target < 0) return { kind: 'live' };
  return { kind: 'index', index: target };
}

/** The landmark to remember once `target` has been applied, so the next press continues from
 *  here instead of re-aiming at whatever happens to be under the viewport top. */
export function landmarkAfter(target: NavTarget, count: number): number {
  switch (target.kind) {
    case 'live':
      return LIVE_EDGE;
    case 'oldest':
      return Math.max(0, count - 1);
    case 'index':
      return target.index;
  }
}
