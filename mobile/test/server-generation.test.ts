// A cache write that bypasses TanStack Query cannot be cancelled by `queryClient.clear()`, and
// "the updater no-ops on an empty cache" is NOT a defence: by the time a stale continuation
// resolves, the new server has populated that cache, so the write merges into it under the same
// project id. The structural answer is a NEW QueryClient per server — a late write then lands in
// an object nobody reads.
//
// An earlier version of this file only asserted that a counter changed, which passed even with
// every guard deleted. It was the seventh test in this PR to pass against a broken implementation.

import { QueryClient } from '@tanstack/react-query';

import { getServerGeneration, setBaseUrl } from '@/api/config';
import { createQueryClient, getActiveQueryClient, setActiveQueryClient } from '@/api/queryClient';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

/** Every client made here gets unmounted afterwards. A live QueryClient keeps timers running, and
 *  a leaked one holds the Jest worker open — which looks like a hung CI job, not a test bug. */
const clients: QueryClient[] = [];
function track(client: QueryClient): QueryClient {
  clients.push(client);
  return client;
}
afterEach(() => {
  clients.splice(0).forEach((client) => { client.unmount(); client.clear(); });
});

test('a late write from the old server cannot reach the new server\'s cache', async () => {
  // The ordering that actually breaks, which asserting immediately after the switch cannot see.
  const serverA = track(createQueryClient());
  let release: (value: { graph: string }) => void;
  const inFlight = new Promise<{ graph: string }>((resolve) => { release = resolve; });

  // A continuation started against server A, holding A's client — a poll, a mutation callback, a
  // one-off fetch. It resolves AFTER the switch and writes unconditionally.
  const continuation = inFlight.then((response) => {
    serverA.setQueryData(['project', 'default', 'graph'], response);
  });

  await setBaseUrl('https://server-b.example.test');
  const serverB = track(createQueryClient());
  // Server B has since loaded its own data under the very same key.
  serverB.setQueryData(['project', 'default', 'graph'], { graph: 'B' });

  release!({ graph: 'A' });
  await continuation;

  expect(serverB.getQueryData(['project', 'default', 'graph'])).toEqual({ graph: 'B' });
});

test('the rendered client is the one module-level code invalidates', () => {
  // The eighth false-positive test in this PR built two clients by hand and never touched the
  // wiring, so it passed with `useServerScopedQueryClient` deleted — and passed while a SECOND,
  // unrendered client was live. That bug was real: the analysis and paper-offer chains run outside
  // React, so their invalidations went to a cache nobody reads, leaving an open ComposeFirst on a
  // stale empty transcript whose Start button would clobber the finished analysis.
  const rendered = track(createQueryClient());
  setActiveQueryClient(rendered);
  expect(getActiveQueryClient()).toBe(rendered);

  const replacement = track(createQueryClient());
  setActiveQueryClient(replacement);
  expect(getActiveQueryClient()).toBe(replacement);
  expect(getActiveQueryClient()).not.toBe(rendered);
});

test('the server generation still changes when the base URL does', async () => {
  // `useGraphBuild` guards its manual write with this, belt-and-braces alongside the new client.
  const before = getServerGeneration();
  await setBaseUrl('https://other.example.test');
  expect(getServerGeneration()).not.toBe(before);
});

test('but not when the URL is unchanged', async () => {
  // Otherwise pressing "Save & connect" without editing the address would discard the whole cache
  // and re-bootstrap auth for nothing.
  await setBaseUrl('https://same.example.test');
  const settled = getServerGeneration();
  await setBaseUrl('https://same.example.test/');
  expect(getServerGeneration()).toBe(settled);
});

test('the shared default client is a QueryClient', () => {
  expect(track(createQueryClient())).toBeInstanceOf(QueryClient);
});
