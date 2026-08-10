import { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { ApiError } from './client';

/** Builds a client. One per server/account identity, not one per app. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Don't retry auth/not-found/bad-request; do retry transient network/5xx a couple times.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
  });
}

/** The client currently rendered by `QueryClientProvider`.
 *
 *  A tiny external store rather than a plain singleton, because the rendered client is replaced
 *  whenever the server OR signed-in account changes. A late continuation may still write into
 *  the client it captured, but that object is no longer rendered and cannot contaminate the next
 *  scope. Module-level code that cannot call `useQueryClient()` must read the current object at
 *  the moment of use.
 *
 *  Getting this wrong is not theoretical: exporting a second, unrendered client meant their
 *  invalidations landed on a cache nobody reads, so an open ComposeFirst screen kept its stale
 *  empty transcript and its Start button would clobber the analysis that had just finished. */
let active = createQueryClient();
const listeners = new Set<() => void>();

export function getActiveQueryClient(): QueryClient {
  return active;
}

export function setActiveQueryClient(client: QueryClient): void {
  if (client === active) return;
  active = client;
  listeners.forEach((listener) => listener());
}

/** Replace the rendered cache synchronously. Clearing is insufficient: an uncancellable promise
 *  holding the old object can call `setQueryData` after the next scope has already loaded. */
export function rotateActiveQueryClient(): QueryClient {
  const previous = active;
  const replacement = createQueryClient();
  active = replacement;
  listeners.forEach((listener) => listener());
  // QueryClientProvider will also release its mount when React commits the new snapshot. This
  // immediate release retires focus/online subscriptions and GC timers during that short gap.
  previous.clear();
  previous.unmount();
  return replacement;
}

export function subscribeActiveQueryClient(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding for the active client. `useSyncExternalStore` closes the mount/effect race: if
 *  auth rotates the cache before subscription commits, React re-reads the snapshot. */
export function useActiveQueryClient(): QueryClient {
  return useSyncExternalStore(
    subscribeActiveQueryClient,
    getActiveQueryClient,
    getActiveQueryClient,
  );
}
