// Drives a discovery run (goals -> suggested readings). The run executes server-side as a
// background job (app/discovery_jobs.py) that is NOT tied to this connection — this hook just
// (a) kicks it off and (b) polls its status for live phase progress, exactly like
// useGraphBuild. resume() re-attaches a freshly-opened screen to a run already in flight.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getDiscovery, startDiscovery } from '@/api/endpoints';
import { keys } from '@/api/queries';
import type { DiscoveryJob, DiscoveryResponse } from '@/api/types';

const POLL_INTERVAL_MS = 1500;

export interface DiscoveryRunState {
  running: boolean;
  job: DiscoveryJob | null;
  error: string | null;
  run: (goals: string) => Promise<boolean>;
  /** Re-attach to an already-running job (e.g. the screen just loaded a DiscoveryResponse
   *  whose `job` is still running). No-op if it isn't running. */
  resume: (job: DiscoveryJob | null | undefined) => void;
  clearError: () => void;
}

export function useDiscoveryRun(pid: string | null): DiscoveryRunState {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState<DiscoveryJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards a start against a fast double-tap in the same tick (before `running` re-renders).
  const startingRef = useRef(false);
  // This hook stays mounted across project switches (tab screens persist). A pending start
  // from project A must never block the first tap in project B or apply A's late response
  // to B's UI — same protection as useGraphBuild.
  const startGenerationRef = useRef(0);

  useEffect(() => {
    startGenerationRef.current += 1;
    startingRef.current = false;
    setRunning(false);
    setJob(null);
    setError(null);
  }, [pid]);

  const applyJob = useCallback(
    (next: DiscoveryJob | null | undefined) => {
      if (!next) {
        setRunning(false);
        return;
      }
      setJob(next);
      if (next.status === 'running') {
        setRunning(true);
        return;
      }
      setRunning(false);
      if (next.status === 'error') setError(next.error ?? 'Discovery failed.');
      // done: the result is already persisted server-side; refresh the query so the screen
      // (and any future visit) renders the new suggestions.
      if (pid) qc.invalidateQueries({ queryKey: keys.discovery(pid) });
    },
    [pid, qc],
  );

  // Poll while running; each poll is an independent short request, so backgrounding the app
  // or a network blip can't kill the run — the next successful poll just catches up.
  useEffect(() => {
    if (!running || !pid) return;
    let cancelled = false;
    const tick = async () => {
      // Captured BEFORE the request — a poll can READ the server pre-registration and
      // resolve only after the start POST settles (see useGraphBuild).
      const beganWhileStarting = startingRef.current;
      try {
        const { job: snap } = await getDiscovery(pid);
        if (cancelled) return;
        // Same first-tap guard as useGraphBuild (D17/D18): while the start POST is in
        // flight, the server may not know the new job yet (or still report the previous
        // settled run) — applying that snapshot flipped `running` off and flashed the
        // search view back to idle. A RUNNING snapshot is always safe (runs are deduped
        // per project); null/settled snapshots wait until the start settles.
        if ((beganWhileStarting || startingRef.current) && snap?.status !== 'running') return;
        applyJob(snap);
      } catch {
        // transient network error — keep polling; the next tick may succeed
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, pid, applyJob]);

  const run = useCallback(
    async (goals: string) => {
      if (!pid || startingRef.current || running || !goals.trim()) return false;
      const requestPid = pid;
      const generation = ++startGenerationRef.current;
      startingRef.current = true;
      setError(null);
      setJob(null);
      setRunning(true); // optimistic: disables the button immediately; applyJob corrects it
      try {
        const { job: started } = await startDiscovery(requestPid, goals.trim());
        if (generation !== startGenerationRef.current) return false;
        applyJob(started);
        // Persist the goals into the cached response so a remount prefills the new text.
        qc.setQueryData<DiscoveryResponse>(keys.discovery(requestPid), (old) =>
          old ? { ...old, goals: goals.trim() } : old,
        );
        return true;
      } catch (e) {
        if (generation !== startGenerationRef.current) return false;
        // The POST response can be lost while the run started fine server-side —
        // reconcile with the registry before declaring failure (see useGraphBuild).
        try {
          const { job: snap } = await getDiscovery(requestPid);
          if (generation !== startGenerationRef.current) return false;
          if (snap?.status === 'running') {
            applyJob(snap);
            return true;
          }
        } catch {
          // status unreachable too — fall through to the error
        }
        setError((e as Error).message ?? 'Discovery failed.');
        setRunning(false);
        await qc.invalidateQueries({ queryKey: keys.discovery(requestPid) });
        return false;
      } finally {
        if (generation === startGenerationRef.current) startingRef.current = false;
      }
    },
    [pid, running, applyJob, qc],
  );

  const resume = useCallback(
    (next: DiscoveryJob | null | undefined) => {
      if (next?.status === 'running') applyJob(next);
    },
    [applyJob],
  );

  const clearError = useCallback(() => setError(null), []);

  return { running, job, error, run, resume, clearError };
}
