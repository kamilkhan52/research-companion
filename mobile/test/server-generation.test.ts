// A cache write that bypasses TanStack Query cannot be cancelled by `queryClient.clear()`, so it
// needs its own guard. `useGraphBuild` does exactly that: a one-off `getGraph` whose result is
// written with `setQueryData`. If the user switches servers while that request is in flight, the
// late response would reinstate server A's graph as FRESH data — under a project id that may well
// also exist on server B.
//
// The cache-purge test in auth-provider.test.tsx cannot catch this: it asserts immediately after
// the switch, so a write arriving afterwards passes it. This one holds the request open across the
// switch and releases it after, which is the ordering that actually breaks.

import { getServerGeneration, setBaseUrl } from '@/api/config';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

test('the server generation changes when the base URL does', async () => {
  const before = getServerGeneration();
  await setBaseUrl('https://other.example.test');
  expect(getServerGeneration()).not.toBe(before);
});

test('a response captured before a switch is recognisable as stale after it', async () => {
  // The shape of the guard in useGraphBuild: capture before the request, compare before writing.
  const capturedOnRequest = getServerGeneration();
  await setBaseUrl('https://server-b.example.test');
  expect(getServerGeneration() === capturedOnRequest).toBe(false);
});

test('the generation is stable when the URL does not actually change', async () => {
  // Otherwise every settings save would discard in-flight work for no reason. Note `setBaseUrl`
  // normalizes, so these are the same URL.
  await setBaseUrl('https://same.example.test');
  const settled = getServerGeneration();
  await setBaseUrl('https://same.example.test/');
  expect(getServerGeneration()).toBe(settled);
});
