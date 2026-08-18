import { useEffect, useState } from 'react';

export const INITIAL_SKELETON_DELAY_MS = 150;

/**
 * Delays skeletons for true empty-cache loads so fast cache hits never flash a placeholder.
 * Empty arrays/objects count as usable data: callers pass `data !== undefined`, preserving real
 * empty states and stale content during background refetches.
 */
export function useDelayedInitialSkeleton(
  isLoading: boolean,
  hasUsableData: boolean,
  delayMs = INITIAL_SKELETON_DELAY_MS,
): boolean {
  const initialLoad = isLoading && !hasUsableData;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!initialLoad) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, initialLoad]);

  return visible;
}
