// Smoothing layer between "text we've received" and "text on screen". Chat turns arrive in
// irregular lumps (the job poller delivers ~900ms snapshots; even true token streams come in
// network bursts), which reads as stutter. This decouples arrival from rendering the way
// ChatGPT/Gemini-style UIs do: buffer what arrived, reveal it on a fixed ~30fps timer at a
// rate proportional to the backlog — a control loop that settles a fraction of a second
// behind the stream, catches up smoothly after a burst or a dropped poll, and never sits
// still while text is pending.

import { useEffect, useRef, useState } from 'react';

const TICK_MS = 33; // ~30fps reveal cadence
// Fraction of the backlog revealed per tick. Equilibrium lag ≈ arrival_rate·TICK/CATCH_UP —
// for typical turn streaming this settles around half a second behind what has arrived.
const CATCH_UP = 0.055;
const MIN_CHARS = 2; // floor so the tail never crawls (~60 chars/s minimum)
// Never trail further than this many chars — reattaching to a long-running turn jump-cuts
// close to live instead of replaying thousands of characters.
const MAX_LAG = 1000;
// Past this size, halve the tick rate. Every reveal re-renders the whole message — Markdown
// re-parses the accumulated text (its memo is keyed on the text, which changes each tick) and
// the block tree rebuilds — so on a long analysis the 30 Hz cadence is quadratic-ish JS work
// exactly while the poller and composer are also busy. Per-tick amounts scale by the same
// factor below, so chars-per-SECOND (and the equilibrium lag) are unchanged; only the paint
// granularity coarsens, from ~1 to ~2 words per frame, which reading speed cannot distinguish.
// One step, not the whole answer: per-tick cost is still O(length), so total work over a turn
// stays quadratic — halving the cadence halves the constant. If very long analyses still
// bottleneck here, the next rungs are a further threshold (or a length-derived tick) and a
// prefix-stable Markdown parse that only re-parses the growing tail block.
const SLOW_TICK_ABOVE_CHARS = 4000;
const SLOW_TICK_MS = 66;

export function useSmoothText(target: string): string {
  const [, bump] = useState(0);
  const shownRef = useRef(0);

  // Replaced/reset content (target shrank): show it as-is rather than "un-typing".
  if (target.length < shownRef.current) shownRef.current = target.length;

  useEffect(() => {
    if (shownRef.current >= target.length) return;
    const tickMs = target.length > SLOW_TICK_ABOVE_CHARS ? SLOW_TICK_MS : TICK_MS;
    const pace = tickMs / TICK_MS; // keeps reveal rate per second constant across tick sizes
    const id = setInterval(() => {
      const backlog = target.length - shownRef.current;
      if (backlog <= 0) {
        clearInterval(id);
        return;
      }
      let next = shownRef.current
        + Math.max(Math.ceil(MIN_CHARS * pace), Math.ceil(backlog * CATCH_UP * pace));
      if (target.length - next > MAX_LAG) next = target.length - MAX_LAG;
      shownRef.current = Math.min(target.length, next);
      bump((n) => n + 1);
    }, tickMs);
    return () => clearInterval(id);
  }, [target]);

  return target.slice(0, shownRef.current);
}
