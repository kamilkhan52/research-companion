export const NARRATION_SCROLL_RETRY_MS = 180;
export const NARRATION_SCROLL_MAX_ATTEMPTS = 3;

export interface NarrationBoundary {
  slotId: string | null;
  activeIndex: number;
}

/** Keep the 10Hz playback clock inside its bridge; Discussion only updates on a sentence/track
 * boundary. */
export function narrationBoundaryKey(boundary: NarrationBoundary): string | null {
  if (!boundary.slotId || boundary.activeIndex < 0) return null;
  return `${boundary.slotId}:${boundary.activeIndex}`;
}

/** Two-stage landing: approach the virtualized message row once, then correct to the measured
 * sentence. Re-aiming is deliberately bounded so a cell that never mounts cannot fight a reader. */
export function startNarrationLanding({
  approach,
  measure,
  correct,
  schedule = (callback, delay) => setTimeout(callback, delay),
}: {
  approach: () => void;
  measure: (done: (screenY: number, height: number) => void) => boolean;
  correct: (screenY: number, height: number) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
}): () => void {
  let cancelled = false;
  let attempts = 0;
  const run = () => {
    if (cancelled || attempts >= NARRATION_SCROLL_MAX_ATTEMPTS) return;
    attempts += 1;
    let callbackRan = false;
    const retry = () => {
      if (cancelled) return;
      if (attempts === 1) approach();
      if (attempts < NARRATION_SCROLL_MAX_ATTEMPTS) {
        schedule(run, NARRATION_SCROLL_RETRY_MS);
      }
    };
    const found = measure((screenY, height) => {
      callbackRan = true;
      if (cancelled) return;
      if (Number.isFinite(screenY) && Number.isFinite(height) && height > 0) {
        correct(screenY, height);
      } else {
        retry();
      }
    });
    if (!found && !callbackRan) retry();
  };
  run();
  return () => { cancelled = true; };
}
