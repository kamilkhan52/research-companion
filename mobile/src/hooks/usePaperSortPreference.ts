import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { SORTS, type SortDirection, type SortKey } from '@/lib/paperSort';

const PREFIX = 'rc.paperSort.v1';

// Last Interacted, most recent first: the list leads with what you were just working on.
export const DEFAULT_SORT: SortKey = 'interacted';
export const DEFAULT_SORT_DIRECTION: SortDirection = 'desc';

interface StoredSort {
  key: SortKey;
  direction: SortDirection;
}

function storageKey(pid: string): string {
  return `${PREFIX}:${encodeURIComponent(pid)}`;
}

function parseStored(raw: string | null): StoredSort | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredSort>;
    const option = SORTS.find((s) => s.key === stored.key);
    if (!option) return null;
    const direction = (option.directions ?? []).some((d) => d.key === stored.direction)
      ? (stored.direction as SortDirection)
      : option.defaultDirection ?? 'asc';
    return { key: option.key, direction };
  } catch {
    return null;
  }
}

/** Per-project paper sort that survives navigation and restarts (D10 follow-up). Each project
 *  remembers its own last selection; a project without one gets the app default. */
export function usePaperSortPreference(pid: string | null) {
  const [sort, setSortState] = useState<SortKey>(DEFAULT_SORT);
  const [sortDirection, setSortDirectionState] = useState<SortDirection>(DEFAULT_SORT_DIRECTION);
  const loadVersionRef = useRef(0);
  const pidRef = useRef(pid);
  pidRef.current = pid;

  useEffect(() => {
    const loadVersion = ++loadVersionRef.current;
    setSortState(DEFAULT_SORT);
    setSortDirectionState(DEFAULT_SORT_DIRECTION);
    if (!pid) return;
    AsyncStorage.getItem(storageKey(pid))
      .then((raw) => {
        if (loadVersionRef.current !== loadVersion) return;
        const stored = parseStored(raw);
        if (!stored) return;
        setSortState(stored.key);
        setSortDirectionState(stored.direction);
      })
      .catch(() => undefined);
  }, [pid]);

  const persist = useCallback((key: SortKey, direction: SortDirection) => {
    loadVersionRef.current += 1; // a write supersedes any in-flight load
    if (!pidRef.current) return;
    void AsyncStorage.setItem(
      storageKey(pidRef.current),
      JSON.stringify({ key, direction } satisfies StoredSort),
    );
  }, []);

  const setSort = useCallback(
    (key: SortKey, direction: SortDirection) => {
      setSortState(key);
      setSortDirectionState(direction);
      persist(key, direction);
    },
    [persist],
  );

  const setSortDirection = useCallback(
    (direction: SortDirection) => {
      setSortDirectionState(direction);
      persist(sort, direction);
    },
    [persist, sort],
  );

  return { sort, sortDirection, setSort, setSortDirection };
}
