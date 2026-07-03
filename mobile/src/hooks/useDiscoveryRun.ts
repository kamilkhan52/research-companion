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
  run: (goals: string) => Promise<void>;
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
      try {
        const { job: snap } = await getDiscovery(pid);
        if (!cancelled) applyJob(snap);
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
      if (!pid || startingRef.current || running || !goals.trim()) return;
      startingRef.current = true;
      setError(null);
      setJob(null);
      setRunning(true); // optimistic: disables the button immediately; applyJob corrects it
      try {
        const { job: started } = await startDiscovery(pid, goals.trim());
        applyJob(started);
        // Persist the goals into the cached response so a remount prefills the new text.
        qc.setQueryData<DiscoveryResponse>(keys.discovery(pid), (old) =>
          old ? { ...old, goals: goals.trim() } : old,
        );
      } catch (e) {
        setError((e as Error).message ?? 'Discovery failed.');
        setRunning(false);
      } finally {
        startingRef.current = false;
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
