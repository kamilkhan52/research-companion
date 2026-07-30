import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Save `value` shortly after it stops changing.
 *
 * Debounced because one preference can change several times a second — a segmented control being
 * dragged through its options — and each change is a network write.
 *
 * Three things here are not incidental:
 *
 * **Saves are serialized.** Only one request is in flight at a time. Debouncing alone does not give
 * you that: a slow save B and a fast save C can overlap, C lands first, B lands second, and the
 * server keeps the OLDER value while the screen says "Saved". So a save that starts while another
 * is running is deferred, and the newest value is re-checked when the running one settles.
 *
 * **"Last saved" is recorded only on success**, so a value that failed to write is not mistaken for
 * one that is already stored. A failure also schedules one retry: without it, a preference that
 * failed to save is stuck until some OTHER preference changes, because re-picking the same option
 * is not a state change and nothing re-triggers the effect.
 *
 * **`enabled` gates the baseline, not just the writing.** The first enabled render defines "what
 * the server already has"; enabling it before the screen has applied the server's values would
 * make that application look like an edit, and opening the screen would write settings back.
 */
export function useAutoSave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  { delayMs = 600, enabled = true, retryDelayMs = 4000, serialize = JSON.stringify }: {
    delayMs?: number;
    enabled?: boolean;
    retryDelayMs?: number;
    serialize?: (value: T) => string;
  } = {},
): { state: AutoSaveState; retry: () => void } {
  const [state, setState] = useState<AutoSaveState>('idle');
  const lastSaved = useRef<string | null>(null);
  const inFlight = useRef(false);
  const latest = useRef<{ serialized: string; value: T } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the save that just settled FAILED. A ref, not the `state` value: reading state
  // inside `flush` closes over a stale copy, which re-fired immediately instead of taking
  // the delayed retry path — turning a bounded retry into an instant one.
  const justFailed = useRef(false);
  // Retries already spent on the CURRENT value. Reset whenever the value changes, so a
  // permanently failing save stops after one attempt instead of becoming a request every
  // `retryDelayMs` forever — which is what scheduling a fresh timer from the catch did.
  const retriesUsed = useRef(0);
  const mounted = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => () => {
    mounted.current = false;
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  const flush = useCallback(() => {
    if (inFlight.current) return;                    // the settle handler re-checks
    const target = latest.current;
    if (!target || target.serialized === lastSaved.current) return;

    inFlight.current = true;
    setState('saving');
    saveRef.current(target.value)
      .then(() => {
        justFailed.current = false;
        lastSaved.current = target.serialized;
        if (mounted.current) setState('saved');
      })
      .catch(() => {
        justFailed.current = true;
        if (mounted.current) setState('error');
        // Exactly one automatic retry per value. Anything further waits for the value to change
        // or for the reader to tap retry; otherwise a save that always fails is a request loop.
        if (retriesUsed.current < 1) {
          retriesUsed.current += 1;
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            justFailed.current = false;
            flush();
          }, retryDelayMs);
        }
      })
      .finally(() => {
        inFlight.current = false;
        // Changes that arrived mid-flight are saved now, so the server ends on the newest value.
        // NOT gated on `mounted`: the screen closing does not un-choose the setting, and a queued
        // value dropped here leaves the server on the older one. Only setState is mount-gated.
        if (!justFailed.current && latest.current
            && latest.current.serialized !== lastSaved.current) {
          flush();
        }
      });
  }, [retryDelayMs]);

  const serialized = serialize(value);

  useEffect(() => {
    if (!enabled) return undefined;
    if (lastSaved.current === null) {
      lastSaved.current = serialized;               // baseline; never written back
      return undefined;
    }
    if (!latest.current || latest.current.serialized !== serialized) {
      retriesUsed.current = 0;          // a new value earns a fresh attempt
    }
    latest.current = { serialized, value };
    if (serialized === lastSaved.current) return undefined;

    const timer = setTimeout(flush, delayMs);
    return () => clearTimeout(timer);
  }, [serialized, delayMs, enabled, value, flush]);

  /** Retry the last failed save — the screen offers this when `state` is 'error'. */
  const retry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    justFailed.current = false;
    retriesUsed.current = 0;            // an explicit tap is not an automatic retry
    flush();
  }, [flush]);

  return { state, retry };
}
