// DR-036 — the ONE place a job snapshot refreshes the account's standing.
//
// The Plan & usage screen refetches on focus and on pull-to-refresh, but a job finishing behind
// it left the figure stale. #336 tried to fix that per call site — chat here, audio there — and
// two review rounds found paths it missed; the third path was always going to be the next
// feature. So the invalidation now lives at the API layer instead: every typed endpoint that
// returns a job snapshot reports it here, and any observed change invalidates the plan query.
//
// What counts as a change is the pair (status, settled). Status alone is not enough:
// cooperative Stop publishes `cancelled` IMMEDIATELY while the worker unwinds and the
// reservation is still held (see app/jobs.py — "`finished_at` deliberately remains null until
// that worker exits and its spend reservation settles"), and the status never changes again.
// Keying on status alone invalidated once at Stop — showing the un-released hold — and then
// never re-invalidated when the money moved. `finished_at` flipping non-null IS the settlement
// signal, so it is part of the fingerprint. For `done`/`error`, DR-035 orders settlement before
// publication, so both fields change together and cost one invalidation.
//
// Deliberately fire-and-forget and DUMB: no knowledge of which job kinds are metered (a free
// cache hit costs one invalidation, not a wrong number), no timers — react-query only refetches
// invalidated queries that are actively rendered.

import { getActiveQueryClient, subscribeActiveQueryClient } from './queryClient';

/** Matches `keys.plan` in queries.ts. Defined here rather than imported because queries.ts
 *  imports endpoints.ts, which imports this module — a test pins the two stay equal. */
export const PLAN_QUERY_KEY = ['plan'] as const;

export interface JobLike {
  id?: string | null;
  status?: string | null;
  finished_at?: string | null;
}

/** Identity for a pid-keyed job whose server snapshot deliberately carries NO `id` (graph
 *  builds and discovery pop it — polling is scope-keyed there). Without this the tracker's
 *  `id` guard made those five endpoints silent no-ops while the wiring table certified them
 *  green off a fabricated payload. The scope id is stable per (kind, project), which matches
 *  how the server dedups those jobs; a new run re-transitions through `running` and is seen. */
export function scopedJob(
  scopeId: string,
  job: { status?: string | null; finished_at?: string | null } | null | undefined,
): JobLike | null {
  if (!job) return null;
  return { id: scopeId, status: job.status, finished_at: job.finished_at };
}

const lastSeen = new Map<string, string>();
/** Bounds session memory. Eviction is least-recently-OBSERVED (the Map is re-inserted on every
 *  observation, changed or not), so an actively polled long job cannot be evicted by a burst of
 *  short ones and then re-trigger as "new" on its next poll. */
const MAX_TRACKED = 300;

// The active query client is replaced on sign-out/sign-in and server change. Observations made
// under the previous identity are meaningless for the next one — and 300 of the old account's
// ids should not stay resident — so the tracker forgets everything when the client rotates.
// Subscribing (rather than queryClient calling in) keeps the import graph one-directional.
subscribeActiveQueryClient(() => {
  lastSeen.clear();
});

function fingerprint(status: string, finishedAt: string | null | undefined): string {
  return `${status}|${finishedAt ? 'settled' : 'unsettled'}`;
}

/** Report a job snapshot observed anywhere in the client. Invalidates the plan query when the
 *  job's (status, settled) pair changes; repeated polls of an unchanged job are free. */
export function notePlanAffectingJob(job: JobLike | null | undefined): void {
  const id = job?.id;
  const status = job?.status;
  if (!id || !status) return;
  const next = fingerprint(status, job?.finished_at);
  const previous = lastSeen.get(id);
  // Re-insert on EVERY observation: recency must track observation, not change.
  lastSeen.delete(id);
  lastSeen.set(id, next);
  while (lastSeen.size > MAX_TRACKED) {
    const oldest = lastSeen.keys().next().value;
    if (oldest === undefined) break;
    lastSeen.delete(oldest);
  }
  if (previous === next) return;
  getActiveQueryClient().invalidateQueries({ queryKey: PLAN_QUERY_KEY });
}

/** A `.then` adapter for endpoints.ts: report the job (or jobs) picked out of the response,
 *  pass the response through untouched. Never throws — a malformed snapshot must not fail the
 *  request that carried it. */
export function noting<T>(
  pick: (response: T) => JobLike | null | undefined | Array<JobLike | null | undefined>,
): (response: T) => T {
  return (response: T): T => {
    try {
      const picked = pick(response);
      for (const job of Array.isArray(picked) ? picked : [picked]) {
        notePlanAffectingJob(job);
      }
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
