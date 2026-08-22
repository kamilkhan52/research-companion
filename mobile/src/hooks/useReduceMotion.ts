import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// DR-101 — the OS answer, cached at module level once any mount has resolved it. The pulse
// on a loading skeleton must start in the very commit that mounts it: the skeleton exists to
// cover a JS-thread-blocking mount, so a "resolve the OS setting first" round-trip queues
// behind the exact work being covered and the reader sees a frozen skeleton (measured on the
// HBF cold open — the resolve landed seconds late, after the overlay was already torn down).
// With the cache, every mount after the first knows the setting synchronously and decorative
// motion starts immediately; the per-mount query below still runs and keeps the cache honest.
let cachedReduceMotion: boolean | null = null;

/** Tracks the OS preference, including changes made while the app is open.
 *
 * Pass `true` for decorative motion that should remain static until the OS preference is
 * KNOWN — the cached answer counts as known, so this only stays static on the app's very
 * first skeleton, not on every mount. Existing state animations can keep their painted
 * initial value by using the default `false`.
 */
export function useReduceMotion(initialValue = false): boolean {
  const [reduceMotion, setReduceMotion] = useState(cachedReduceMotion ?? initialValue);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      cachedReduceMotion = enabled;
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => {
        cachedReduceMotion = enabled;
        setReduceMotion(enabled);
      },
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
