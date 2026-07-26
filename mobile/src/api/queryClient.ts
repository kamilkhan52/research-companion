import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './client';

/** Builds a client. One per SERVER, not one per app — see `useServerScopedQueryClient`. */
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

/** The client for the current server. Replaced wholesale when the base URL changes.
 *
 *  This is the structural answer to a problem that per-call-site guards kept losing to: any
 *  asynchronous continuation holding a `queryClient` reference — a poll, a mutation's onSuccess, a
 *  one-off fetch — can call `setQueryData` AFTER a server switch. Clearing the cache does not stop
 *  it, and "the updater no-ops on an empty cache" is false, because by then the new server has
 *  populated that cache and the stale write merges into it under the same project id.
 *
 *  Giving the new server a NEW client means every one of those late writes lands in an object
 *  nobody reads. No query keys change, so no call site can be missed. */
export const queryClient = createQueryClient();
