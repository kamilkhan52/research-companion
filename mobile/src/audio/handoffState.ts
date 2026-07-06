import AsyncStorage from '@react-native-async-storage/async-storage';

const ELIGIBLE_KEY = 'rc.eligibleListeningHandoffs';
const MAX_ELIGIBLE = 100;
let mutationTail: Promise<void> = Promise.resolve();
let eligibilityEpoch = 0;

async function read(): Promise<string[]> {
  try {
    const value = JSON.parse(await AsyncStorage.getItem(ELIGIBLE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mutate(update: (ids: string[]) => string[]): Promise<void> {
  mutationTail = mutationTail
    .catch(() => {})
    .then(async () => {
      const ids = update(await read()).slice(-MAX_ELIGIBLE);
      await AsyncStorage.setItem(ELIGIBLE_KEY, JSON.stringify(ids));
    });
  return mutationTail;
}

/** Capture before starting an async request; dismissal invalidates the returned epoch. */
export function currentHandoffEligibilityEpoch(): number {
  return eligibilityEpoch;
}

export function registerEligibleHandoff(chatJobId: string, expectedEpoch?: number): Promise<void> {
  if (expectedEpoch != null && expectedEpoch !== eligibilityEpoch) return Promise.resolve();
  return mutate((ids) => [...ids.filter((id) => id !== chatJobId), chatJobId]);
}

export function consumeEligibleHandoff(chatJobId: string): Promise<void> {
  return mutate((ids) => ids.filter((id) => id !== chatJobId));
}

export function dismissEligibleHandoffs(): Promise<void> {
  eligibilityEpoch += 1;
  return mutate(() => []);
}

export async function isHandoffEligible(chatJobId: string): Promise<boolean> {
  await mutationTail.catch(() => {});
  return (await read()).includes(chatJobId);
}
