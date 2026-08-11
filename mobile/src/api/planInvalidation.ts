// DR-036 — the ONE place a job snapshot refreshes the account's standing.
//
// The Plan & usage screen refetches on focus and on pull-to-refresh, but a job finishing behind
// it left the figure stale. #336 tried to fix that per call site — chat here, audio there — and
// two review rounds found paths it missed; the third path was always going to be the next
// feature. So the invalidation now lives at the API layer instead: every typed endpoint that
// returns a job snapshot reports it here, and any OBSERVED STATUS CHANGE invalidates the plan
// query. A new job appearing means a hold was just taken; a running job turning terminal means
// spend landed and the hold released (DR-035 ordered settlement before publication, so by the
// time a client can see `done`, `/api/plan` reflects it). First sight of an already-terminal
// snapshot (a cache hit, a reattach after backgrounding) also invalidates — at most one cheap
// GET, and only refetched while the plan screen is actually mounted.
//
// Deliberately fire-and-forget and DUMB: no knowledge of which job kinds are metered (a free
// cache hit costs one invalidation, not a wrong number), no timers, no subscription — react-query
// only refetches invalidated queries that are actively rendered.

import { getActiveQueryClient } from './queryClient';

/** Matches `keys.plan` in queries.ts. Defined here rather than imported because queries.ts
 *  imports endpoints.ts, which imports this module — a test pins the two stay equal. */
export const PLAN_QUERY_KEY = ['plan'] as const;

export interface JobLike {
  id?: string | null;
  status?: string | null;
}

const lastSeen = new Map<string, string>();
/** Bounds session memory. Eviction is least-recently-OBSERVED (the Map is re-inserted on every
 *  status change), so a long-running job cannot be evicted by a burst of short ones and then
 *  re-trigger as "new" on its next poll. */
const MAX_TRACKED = 300;

/** Report a job snapshot observed anywhere in the client. Invalidates the plan query on any
 *  status change for that job id; repeated polls of an unchanged status are free. */
export function notePlanAffectingJob(job: JobLike | null | undefined): void {
  const id = job?.id;
  const status = job?.status;
  if (!id || !status) return;
  const previous = lastSeen.get(id);
  // Re-insert on EVERY observation, changed or not: recency must track observation, or an
  // actively polled long job gets evicted by a burst of short ones and its next unchanged poll
  // re-triggers as "new".
  lastSeen.delete(id);
  lastSeen.set(id, status);
  while (lastSeen.size > MAX_TRACKED) {
    const oldest = lastSeen.keys().next().value;
    if (oldest === undefined) break;
    lastSeen.delete(oldest);
  }
  if (previous === status) return;
  getActiveQueryClient().invalidateQueries({ queryKey: PLAN_QUERY_KEY });
}

/** A `.then` adapter for endpoints.ts: report the job picked out of the response, pass the
 *  response through untouched. Never throws — a malformed snapshot must not fail the request
 *  that carried it. */
export function noting<T>(pick: (response: T) => JobLike | null | undefined): (response: T) => T {
  return (response: T): T => {
    try {
      notePlanAffectingJob(pick(response));
    } catch {
      // The response is the caller's; standing refresh is best-effort by design.
    }
    return response;
  };
}

/** Test hook: forget every observed job. */
export function resetPlanInvalidationForTests(): void {
  lastSeen.clear();
}
