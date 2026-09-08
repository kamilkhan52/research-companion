// DR-151 — telling a seek from reading.
//
// Kamil: "don't activate it on auto scroll. Only activate it on significant human scroll (not
// even small ones that might be just the user reading slowly; only when we know the user is
// actually seeking a different part, so it has to be a significant swipe)".
//
// The navigation rail used to wake on the transcript's `onScroll`, which fires for the app's
// own scrolls too — narration follow, the streaming pin, every navigator landing — so while
// audio played it sat at full strength over the prose permanently. Two things follow, and this
// module is only the second:
//
//  1. a scroll nobody's finger started can never wake it. That is why the window opens at
//     `beginDrag` and nowhere else.
//  2. a finger that moved a little has not sought anything. Distance is measured from where the
//     drag STARTED, and it keeps accruing through the momentum that drag threw — a flick moves
//     most of its distance after the finger has gone, so a detector that stopped at
//     `endDrag` would miss exactly the gesture Kamil means by "a significant swipe".
//
// Momentum may only reopen the window immediately after a drag: a programmatic animated scroll
// also emits momentum events on Android, and that is the thing being kept out.

/** A seek moves at least this much of the viewport. Half a screen is far more than the nudges
 *  of reading and far less than a deliberate journey. */
export const SEEK_VIEWPORT_FRACTION = 0.5;
/** Used when the scroll event carried no viewport height. Roughly half a compact phone. */
export const SEEK_FALLBACK_PX = 320;
/** How soon after a finger lifts its momentum must begin to count as thrown by it. */
export const FLING_GRACE_MS = 250;
/** A gesture no finger is holding is over once its frames stop arriving. Android cancels a
 *  fling on touch-down WITHOUT emitting a momentum end (`ReactScrollView.cancelPostTouchScrolling`),
 *  and a tap that never becomes a drag emits no begin-drag either — so without this the window
 *  would stay open with a stale origin, and the next scroll the APP made would wake the rail:
 *  the one thing this module exists to prevent (Opus review of #508). Frames arrive every ~16 ms
 *  while anything is really moving, so this only ever closes a gesture that has stopped. It is
 *  not applied while a finger is down, where a pause is just a pause. */
export const GESTURE_IDLE_MS = 400;
/** The same ceiling for a gesture whose finger never lifted. `onScrollEndDrag` can be lost —
 *  the list re-keyed or unmounted under a held finger — and without a bound of its own that
 *  would latch `dragging` and disarm the expiry above for good, which is the same hole by
 *  another road. Long enough that a reader who stops to think mid-drag keeps their gesture. */
export const DRAG_IDLE_MS = 4000;

export interface SeekDetector {
  /** A finger touched the transcript at this offset. */
  beginDrag(offset: number): void;
  /** One scroll frame. True exactly once per gesture: the moment it became a seek. */
  scroll(offset: number, viewportHeight?: number): boolean;
  /** The finger lifted. Any momentum it threw is still to come. */
  endDrag(): void;
  /** Momentum started. Counts only if a finger just let go of it. */
  momentumBegin(): void;
  momentumEnd(): void;
}

export function createSeekDetector(now: () => number = Date.now): SeekDetector {
  //: Is a gesture the reader started still travelling?
  let open = false;
  //: Is a finger down? While it is, a pause is just a pause and the window never expires.
  let dragging = false;
  //: Where that gesture began. Distance is measured from here, not frame to frame.
  let origin = 0;
  //: One wake per gesture — the rail's own idle countdown decides when it settles again.
  let signalled = false;
  let liftedAt = 0;
  //: When this gesture was last seen moving. See `GESTURE_IDLE_MS`.
  let movedAt = 0;

  return {
    beginDrag(offset: number) {
      open = true;
      dragging = true;
      origin = offset;
      signalled = false;
      liftedAt = 0;
      movedAt = now();
    },
    scroll(offset: number, viewportHeight?: number): boolean {
      // Frames arrive every ~16 ms while anything really moves, so this refresh is what keeps a
      // long fling alive; the ceiling is what shuts a gesture that stopped without saying so.
      // It cannot tell the fling's frames from the app's, so the window really closes on a lull
      // in ALL scrolling — narrow, because a drag also suppresses narration follow for 4 s.
      if (open && now() - movedAt > (dragging ? DRAG_IDLE_MS : GESTURE_IDLE_MS)) {
        open = false;
        dragging = false;
      }
      if (!open) return false;
      movedAt = now();
      if (signalled) return false;
      const threshold = viewportHeight && viewportHeight > 0
        ? viewportHeight * SEEK_VIEWPORT_FRACTION
        : SEEK_FALLBACK_PX;
      if (Math.abs(offset - origin) < threshold) return false;
      signalled = true;
      return true;
    },
    endDrag() {
      open = false;
      dragging = false;
      liftedAt = now();
    },
    momentumBegin() {
      // `liftedAt` is zero unless a finger has lifted since the last gesture began, so
      // programmatic momentum finds the window shut.
      if (liftedAt && now() - liftedAt <= FLING_GRACE_MS) {
        open = true;
        movedAt = now();
      }
    },
    momentumEnd() {
      open = false;
      dragging = false;
      liftedAt = 0;
    },
  };
}
