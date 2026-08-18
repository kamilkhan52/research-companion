import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Tracks the OS preference, including changes made while the app is open.
 *
 * Pass `true` for decorative motion that should remain static until the asynchronous OS
 * preference resolves. Existing state animations can keep their painted initial value by using
 * the default `false`.
 */
export function useReduceMotion(initialValue = false): boolean {
  const [reduceMotion, setReduceMotion] = useState(initialValue);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
