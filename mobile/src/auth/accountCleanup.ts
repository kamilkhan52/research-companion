import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';

/** Account/project-linked device state. Device preferences and the selected server survive. */
const ACCOUNT_KEYS = new Set([
  'rc.activeProject',
  'rc.eligibleListeningHandoffs',
  'rc.handledAudioHandoffs',
  // AudioProvider normally removes this first; keep it here too so a player reset/storage failure
  // cannot leave private narration text, URLs, and titles behind.
  'rc.playbackSnapshot.v1',
]);
const ACCOUNT_PREFIXES = [
  'rc.draft.v1:',
  'rc.lastThread.v1:',
  'rc.paperSort.v1:',
];

/** Purge local traces that could expose or revive the deleted account's research state. */
export async function clearDeletedAccountStorage(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const accountKeys = keys.filter(
    (key) => ACCOUNT_KEYS.has(key) || ACCOUNT_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  if (accountKeys.length) await AsyncStorage.multiRemove(accountKeys);
  // Covers and paper figures are protected research data cached by expo-image outside
  // AsyncStorage. Its cache API is global rather than key-selective, so deletion deliberately
  // clears all image entries instead of trying to infer which opaque files belonged to the user.
  const memoryCleared = await Image.clearMemoryCache();
  const diskCleared = await Image.clearDiskCache();
  // Expo resolves false (rather than rejecting) when Android has no active Activity. Treat that
  // as a cleanup failure so the completion path tells the user to clear app data manually.
  if (!memoryCleared || !diskCleared) throw new Error('Protected image caches were not cleared.');
}
