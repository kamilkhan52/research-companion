// Drives an agent-assisted notes edit. The revision runs server-side as a background job
// (app/notes_jobs.py) not tied to this connection — this hook kicks it off, polls its live
// progress (tool calls + streamed text), and surfaces the finished proposal. Applying the
// proposal is the caller's explicit action (saveNotes); this hook never writes anything.
// resume() re-attaches a freshly-opened screen to an edit already in flight.

import { useCallback, useEffect, useRef, useState } from 'react';

import { getActiveNotesJob, getNotesJob, startNotesAgent } from '@/api/endpoints';
import type { NotesJob } from '@/api/types';

const POLL_INTERVAL_MS = 1200;

export interface NotesAgentState {
  running: boolean;
  job: NotesJob | null;
  /** The finished proposal's markdown (job done), until dismissed. */
  proposal: string | null;
  error: string | null;
  run: (instruction: string) => Promise<boolean>;
  /** Re-attach to a job already running for this target (e.g. after navigating back). */
  resume: () => Promise<void>;
  dismissProposal: () => void;
  clearError: () => void;
}

export function useNotesAgent(pid: string | null, target: string | null): NotesAgentState {
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState<NotesJob | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);

  const applyJob = useCallback((next: NotesJob | null | undefined) => {
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
    if (next.status === 'error') setError(next.error ?? 'The notes edit failed.');
    if (next.status === 'done' && next.result) setProposal(next.result);
  }, []);

  // Poll while running; each poll is an independent short request, robust to blips.
  useEffect(() => {
    if (!running || !pid || !job?.id) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { job: snap } = await getNotesJob(pid, job.id);
        if (!cancelled) applyJob(snap);
      } catch {
        // transient network error — keep polling
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, pid, job?.id, applyJob]);

  const run = useCallback(
    async (instruction: string) => {
      if (!pid || !target || startingRef.current || running || !instruction.trim()) return false;
      startingRef.current = true;
      setError(null);
      setProposal(null);
      setJob(null);
      setRunning(true); // optimistic; applyJob corrects it
      try {
        const { job: started } = await startNotesAgent(pid, target, instruction.trim());
        applyJob(started);
        return true;
      } catch (e) {
        setError((e as Error).message ?? 'The notes edit failed.');
        setRunning(false);
        return false;
      } finally {
        startingRef.current = false;
      }
    },
    [pid, target, running, applyJob],
  );

  const resume = useCallback(async () => {
    if (!pid || !target) return;
    try {
      const { job: active } = await getActiveNotesJob(pid, target);
      if (active) applyJob(active);
    } catch {
      // screen still works without reattaching
    }
  }, [pid, target, applyJob]);

  const dismissProposal = useCallback(() => setProposal(null), []);
  const clearError = useCallback(() => setError(null), []);

  return { running, job, proposal, error, run, resume, dismissProposal, clearError };
}
