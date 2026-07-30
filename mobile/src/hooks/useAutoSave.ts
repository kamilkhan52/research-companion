import { useEffect, useRef, useState } from 'react';

export type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Save `value` shortly after it stops changing.
 *
 * Debounced rather than immediate because a preference can change several times in a second — a
 * segmented control being dragged through its options — and each change is a network write. The
 * delay coalesces those into one.
 *
 * Deliberately compares against the last value actually SAVED, not the previous render's value:
 * a failed save must be retried by the next change rather than silently skipped because the value
 * "hasn't changed since last time". The first render never saves, or opening the screen would
 * write settings nobody touched.
 *
 * `serialize` decides what counts as a change. It defaults to JSON, which is right for the plain
 * objects this is used with and wrong for anything holding a function or a cycle.
 */
export function useAutoSave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  { delayMs = 600, enabled = true, serialize = JSON.stringify }: {
    delayMs?: number;
    enabled?: boolean;
    serialize?: (value: T) => string;
  } = {},
): AutoSaveState {
  const [state, setState] = useState<AutoSaveState>('idle');
  const lastSaved = useRef<string | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const serialized = serialize(value);

  useEffect(() => {
    if (!enabled) return undefined;
    // Establish the baseline on the first enabled render without writing it back.
    if (lastSaved.current === null) {
      lastSaved.current = serialized;
      return undefined;
    }
    if (lastSaved.current === serialized) return undefined;

    let cancelled = false;
    const timer = setTimeout(() => {
      setState('saving');
      saveRef.current(value)
        .then(() => {
          if (cancelled) return;
          // Recorded only on success, so a failed write is retried by the next change.
          lastSaved.current = serialized;
          setState('saved');
        })
        .catch(() => {
          if (!cancelled) setState('error');
        });
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serialized, delayMs, enabled, value]);

  return state;
}
