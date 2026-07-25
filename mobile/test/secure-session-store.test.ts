// The Supabase session holds the REFRESH token — a long-lived credential — so it goes to
// expo-secure-store rather than AsyncStorage. SecureStore caps a value at 2048 bytes and a real
// session exceeds that, so the adapter chunks. These tests pin the chunking, because its failure
// mode is quiet: sign-in appears to work and simply does not survive a restart.

import * as SecureStore from 'expo-secure-store';

import { secureSessionStore } from '@/auth/secureSessionStore';

/** `mock` prefix required: jest.mock factories may not close over other out-of-scope names. */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => (mockStore.has(k) ? mockStore.get(k)! : null)),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

/** A realistic session: two JWTs plus a user object. Comfortably over the 2048-byte limit. */
const session = JSON.stringify({
  access_token: `header.${'a'.repeat(900)}.sig`,
  refresh_token: 'r'.repeat(64),
  user: { id: 'uuid', email: 'reader@example.com', user_metadata: { note: 'x'.repeat(1500) } },
});

test('a session larger than SecureStore\'s per-value limit round-trips intact', async () => {
  expect(session.length).toBeGreaterThan(2048);
  await secureSessionStore.setItem('sb-session', session);
  await expect(secureSessionStore.getItem('sb-session')).resolves.toBe(session);
});

test('no single stored value exceeds the 2048-byte limit', async () => {
  await secureSessionStore.setItem('sb-session', session);
  for (const [, value] of mockStore) expect(value.length).toBeLessThanOrEqual(2048);
});

test('a missing chunk reads as no session rather than as truncated JSON', async () => {
  await secureSessionStore.setItem('sb-session', session);
  const chunk = [...mockStore.keys()].find((k) => k.endsWith('.1'));
  mockStore.delete(chunk!);
  // Returning the surviving prefix would hand supabase-js malformed JSON; the user must instead
  // land on the sign-in screen.
  await expect(secureSessionStore.getItem('sb-session')).resolves.toBeNull();
});

test('a shorter session does not leave a readable tail of the longer one', async () => {
  await secureSessionStore.setItem('sb-session', session);
  await secureSessionStore.setItem('sb-session', '{"access_token":"short"}');
  await expect(secureSessionStore.getItem('sb-session')).resolves.toBe('{"access_token":"short"}');
  // The stale chunks must be gone, not merely unreferenced — they contain the previous refresh
  // token, and this is the storage we chose specifically to protect it.
  const leftovers = [...mockStore.values()].filter((v) => v.includes('r'.repeat(64)));
  expect(leftovers).toHaveLength(0);
});

test('removing clears every chunk, so sign-out leaves no refresh token behind', async () => {
  await secureSessionStore.setItem('sb-session', session);
  await secureSessionStore.removeItem('sb-session');
  await expect(secureSessionStore.getItem('sb-session')).resolves.toBeNull();
  expect(mockStore.size).toBe(0);
});

test('reading a key that was never written returns null without touching chunk keys', async () => {
  await expect(secureSessionStore.getItem('sb-session')).resolves.toBeNull();
  expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);  // the count key only
});

test('a session too large to store is refused rather than half-written', async () => {
  await expect(secureSessionStore.setItem('sb-session', 'x'.repeat(200_000))).rejects.toThrow(
    /too large/i,
  );
});
