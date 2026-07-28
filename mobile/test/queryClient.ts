import { QueryClient } from '@tanstack/react-query';

/**
 * Query clients used by tests must not leave TanStack Query's default five-minute
 * garbage-collection timers behind after Jest finishes the suite.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
}
