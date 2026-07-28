import AsyncStorage from '@react-native-async-storage/async-storage';

/** Account/project-linked device state. Device preferences and the selected server survive. */
const ACCOUNT_KEYS = new Set([
  'rc.activeProject',
  'rc.eligibleListeningHandoffs',
  'rc.handledAudioHandoffs',
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
}
