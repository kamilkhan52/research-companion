// Remembers which discussion thread the user last had open on each paper, so resuming the
// paper (Continue Reading, Library tap, reference-link hop — any entry without an explicit
// thread) returns to that thread instead of always landing on main (2026-07-21 usage note).

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'rc.lastThread.v1';

function key(pid: string, slug: string): string {
  return `${PREFIX}:${encodeURIComponent(pid)}:${encodeURIComponent(slug)}`;
}

export async function loadLastThread(pid: string, slug: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key(pid, slug));
  } catch {
    return null;
  }
}

export function saveLastThread(pid: string, slug: string, threadId: string): void {
  void AsyncStorage.setItem(key(pid, slug), threadId).catch(() => undefined);
}

export function clearLastThread(pid: string, slug: string): void {
  void AsyncStorage.removeItem(key(pid, slug)).catch(() => undefined);
}
