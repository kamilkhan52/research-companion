export const NARRATION_SCROLL_RETRY_MS = 180;
export const NARRATION_SCROLL_MAX_ATTEMPTS = 3;

export interface NarrationBoundary {
  slotId: string | null;
  activeIndex: number;
}

/** Passive following belongs to playback, never merely to a mounted cursor. Finish Reading and
 * other transcript updates can rerender while TrackPlayer is paused; those renders must not pull
 * the reader back to the last spoken sentence. Explicit mini-player seeks use their own path. */
export function shouldLandNarrationPassively(
  playing: boolean,
  explicitNonce: number | null,
): boolean {
  return playing && explicitNonce == null;
}

/** The landmark rail owns transcript navigation when enabled, so the library's older floating
 * scroll-to-latest control must not sit underneath it. */
export function shouldShowLegacyScrollButton(chatNavRail: boolean): boolean {
  return !chatNavRail;
}

/** A passive boundary should not recenter the page sentence-by-sentence. Keep a broad reading
 * band, then make one animated correction only when the sentence reaches its edge. Explicit
 * jumps always land at the centre of the unobstructed viewport. Coordinates are window/list
 * coordinates in the same convention used by the existing inverted-list correction. */
export function narrationFollowOffset({
  currentOffset,
  screenY,
  sentenceHeight,
  viewportHeight,
  topClearance,
  bottomClearance,
  force = false,
}: {
  currentOffset: number;
  screenY: number;
  sentenceHeight: number;
  viewportHeight: number;
  topClearance: number;
  bottomClearance: number;
  force?: boolean;
}): number | null {
  const margin = 12;
  const usableTop = topClearance + margin;
  const usableBottom = Math.max(usableTop, viewportHeight - bottomClearance - margin);
  const usableHeight = usableBottom - usableTop;
  const sentenceCenter = screenY + sentenceHeight / 2;
  const bandTop = usableTop + usableHeight * 0.2;
  const bandBottom = usableTop + usableHeight * 0.8;
  if (!force && sentenceCenter >= bandTop && sentenceCenter <= bandBottom) return null;

  // Passive reading resumes slightly below centre, leaving more of the just-read context above.
  const desiredY = force
    ? usableTop + usableHeight * 0.5
    : usableTop + usableHeight * 0.6;
  return Math.max(0, currentOffset + desiredY - sentenceCenter);
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
