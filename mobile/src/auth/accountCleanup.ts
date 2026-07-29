import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';

const DELETION_INTENT_KEY = 'rc.accountDeletionIntent.v1';

/** Persisted before POST so local privacy cleanup survives identity/token loss or process death. */
export async function markAccountDeletionIntent(): Promise<void> {
  await AsyncStorage.setItem(DELETION_INTENT_KEY, '1');
}

export async function hasAccountDeletionIntent(): Promise<boolean> {
  return (await AsyncStorage.getItem(DELETION_INTENT_KEY)) === '1';
}

export async function clearAccountDeletionIntent(): Promise<void> {
  await AsyncStorage.removeItem(DELETION_INTENT_KEY);
}

const DELETED_NOTICE_KEY = 'rc.accountDeletedNotice.v1';

/** Set once deletion completes, cleared only when the user acknowledges it.
 *
 * Persisted rather than held in component state because the completion path ends in a sign-out,
 * which unmounts the tree that would have held it — and because someone who just deleted their
 * account may well close the app immediately. Deliberately NOT in `ACCOUNT_KEYS` below: this is a
 * one-word flag about a device, not the deleted user's research state, and the purge must not eat
 * the acknowledgement it exists to deliver. */
export async function markAccountDeleted(): Promise<void> {
  await AsyncStorage.setItem(DELETED_NOTICE_KEY, '1');
}

export async function hasAccountDeleted(): Promise<boolean> {
  return (await AsyncStorage.getItem(DELETED_NOTICE_KEY)) === '1';
}

export async function clearAccountDeleted(): Promise<void> {
  await AsyncStorage.removeItem(DELETED_NOTICE_KEY);
}

/** Account/project-linked device state. Device preferences and the selected server survive. */
const ACCOUNT_KEYS = new Set([
  'rc.activeProject',
  'rc.eligibleListeningHandoffs',
  'rc.handledAudioHandoffs',
  // AudioProvider normally removes this first; keep it here too so a player reset/storage failure
  // cannot leave private narration text, URLs, and titles behind.
  'rc.playbackSnapshot.v1',
  // Which paper's resume card the reader dismissed — a project id and a paper slug, i.e. the
  // deleted account's research state, which is exactly what this purge is for.
  'rc.continueCard.dismissed.v1',
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
