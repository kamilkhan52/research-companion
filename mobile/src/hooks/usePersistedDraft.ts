import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

const PREFIX = 'rc.draft.v1';
const WRITE_DEBOUNCE_MS = 300;

interface StoredDraft<T> {
  version: 1;
  value: T;
  submitted: boolean;
  acceptedBaseline: number | null;
}

export function draftKey(...parts: (string | number)[]): string {
  return `${PREFIX}:${parts.map((part) => encodeURIComponent(String(part))).join(':')}`;
}

export interface PersistedDraft<T> {
  value: T;
  setValue: Dispatch<SetStateAction<T>>;
  ready: boolean;
  hasDraft: boolean;
  submitted: boolean;
  acceptedBaseline: number | null;
  /** Flush the pending value before a request so a process death cannot lose it. */
  markSubmitted: (acceptedBaseline?: number) => Promise<void>;
  /** Clear persisted state after acceptance or an explicit discard, optionally retaining UI text. */
  clear: (nextValue?: T) => Promise<void>;
}

export function usePersistedDraft<T>(key: string | null, fallback: T): PersistedDraft<T> {
  const [value, setValueState] = useState<T>(fallback);
  const [ready, setReady] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [acceptedBaseline, setAcceptedBaseline] = useState<number | null>(null);
  const valueRef = useRef(value);
  const fallbackRef = useRef(fallback);
  const appliedFallbackRef = useRef(fallback);
  const editVersionRef = useRef(0);
  const loadVersionRef = useRef(0);
  const writeVersionRef = useRef(0);
  valueRef.current = value;
  fallbackRef.current = fallback;

  useEffect(() => {
    const loadVersion = ++loadVersionRef.current;
    const editVersion = editVersionRef.current;
    setReady(false);
    setHasDraft(false);
    setSubmitted(false);
    setAcceptedBaseline(null);
    valueRef.current = fallbackRef.current;
    appliedFallbackRef.current = fallbackRef.current;
    setValueState(fallbackRef.current);
    if (!key) {
      setReady(true);
      return;
    }
    let active = true;
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (!active || loadVersionRef.current !== loadVersion || editVersionRef.current !== editVersion) return;
        if (!raw) return;
        const stored = JSON.parse(raw) as StoredDraft<T>;
        if (stored.version !== 1 || !Object.prototype.hasOwnProperty.call(stored, 'value')) return;
        valueRef.current = stored.value;
        setValueState(stored.value);
        setHasDraft(true);
        setSubmitted(!!stored.submitted);
        setAcceptedBaseline(stored.acceptedBaseline ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active && loadVersionRef.current === loadVersion) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [key]);

  useEffect(() => {
    if (ready && !hasDraft && !Object.is(appliedFallbackRef.current, fallback)) {
      appliedFallbackRef.current = fallback;
      valueRef.current = fallback;
      setValueState(fallback);
    }
  }, [fallback, hasDraft, ready]);

  useEffect(() => {
    if (!key || !ready || !hasDraft) return;
    const writeVersion = ++writeVersionRef.current;
    const timer = setTimeout(() => {
      if (writeVersionRef.current !== writeVersion) return;
      const stored: StoredDraft<T> = { version: 1, value, submitted, acceptedBaseline };
      void AsyncStorage.setItem(key, JSON.stringify(stored));
    }, WRITE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [acceptedBaseline, hasDraft, key, ready, submitted, value]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    editVersionRef.current += 1;
    const next = typeof update === 'function'
      ? (update as (current: T) => T)(valueRef.current)
      : update;
    valueRef.current = next;
    setValueState(next);
    setHasDraft(true);
    setSubmitted(false);
    setAcceptedBaseline(null);
  }, []);

  const markSubmitted = useCallback(async (baseline?: number) => {
    if (!key) return;
    writeVersionRef.current += 1;
    const nextBaseline = baseline ?? null;
    setHasDraft(true);
    setSubmitted(true);
    setAcceptedBaseline(nextBaseline);
    const stored: StoredDraft<T> = {
      version: 1,
      value: valueRef.current,
      submitted: true,
      acceptedBaseline: nextBaseline,
    };
    await AsyncStorage.setItem(key, JSON.stringify(stored));
  }, [key]);

  const clear = useCallback(async (nextValue?: T) => {
    editVersionRef.current += 1;
    writeVersionRef.current += 1;
    const next = nextValue === undefined ? fallbackRef.current : nextValue;
    valueRef.current = next;
    setValueState(next);
    setHasDraft(false);
    setSubmitted(false);
    setAcceptedBaseline(null);
    if (key) await AsyncStorage.removeItem(key);
  }, [key]);

  return {
    value,
    setValue,
    ready,
    hasDraft,
    submitted,
    acceptedBaseline,
    markSubmitted,
    clear,
  };
}
