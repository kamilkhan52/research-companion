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

/** The client currently rendered by `QueryClientProvider`.
 *
 *  A holder rather than a plain singleton, because the client is replaced when the server changes
 *  (see `useServerScopedQueryClient`). Module-level code that cannot call `useQueryClient()` —
 *  `InitialAnalysisOffer` and `ExistingPaperOffer` run their chains outside React — must read it
 *  through `getActiveQueryClient()` at the moment of use.
 *
 *  Getting this wrong is not theoretical: exporting a second, unrendered client meant their
 *  invalidations landed on a cache nobody reads, so an open ComposeFirst screen kept its stale
 *  empty transcript and its Start button would clobber the analysis that had just finished. */
let active = createQueryClient();

export function getActiveQueryClient(): QueryClient {
  return active;
}

export function setActiveQueryClient(client: QueryClient): void {
  active = client;
}
