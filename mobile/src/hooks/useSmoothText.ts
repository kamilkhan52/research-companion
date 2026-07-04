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

export function useSmoothText(target: string): string {
  const [, bump] = useState(0);
  const shownRef = useRef(0);

  // Replaced/reset content (target shrank): show it as-is rather than "un-typing".
  if (target.length < shownRef.current) shownRef.current = target.length;

  useEffect(() => {
    if (shownRef.current >= target.length) return;
    const id = setInterval(() => {
      const backlog = target.length - shownRef.current;
      if (backlog <= 0) {
        clearInterval(id);
        return;
      }
      let next = shownRef.current + Math.max(MIN_CHARS, Math.ceil(backlog * CATCH_UP));
      if (target.length - next > MAX_LAG) next = target.length - MAX_LAG;
      shownRef.current = Math.min(target.length, next);
      bump((n) => n + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [target]);

  return target.slice(0, shownRef.current);
}
