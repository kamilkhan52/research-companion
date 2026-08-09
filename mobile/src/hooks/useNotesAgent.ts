// Drives an agent-assisted notes edit. The revision runs server-side as a background job
// (app/notes_jobs.py) not tied to this connection — this hook kicks it off, polls its live
// progress (tool calls + streamed text), and surfaces the finished proposal. Applying the
// proposal is the caller's explicit action (saveNotes); this hook never writes anything.
// resume() re-attaches a freshly-opened screen to an edit already in flight.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  discardNotesJob,
  getActiveNotesJob,
  getLatestNotesJob,
  getNotesJob,
  startNotesAgent,
} from '@/api/endpoints';
import type { NotesJob } from '@/api/types';
import { presentSpendJobRefusal, presentSpendRefusal } from '@/components/SpendRefusalSheet';

const POLL_INTERVAL_MS = 1200;

export interface NotesAgentState {
  running: boolean;
  job: NotesJob | null;
  /** The finished proposal's markdown (job done), until dismissed. */
  proposal: string | null;
  error: string | null;
  run: (instruction: string) => Promise<boolean>;
  /** Re-attach to the latest retained job/proposal (e.g. an R8.3 pass started by a move). */
  resume: () => Promise<void>;
  /** Forget local proposal state after saveNotes atomically applied and discarded it. */
  proposalApplied: () => void;
  dismissProposal: () => void;
  clearError: () => void;
}

export function useNotesAgent(pid: string | null, target: string | null): NotesAgentState {
  const scope = pid && target ? `${pid}\0${target}` : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState<NotesJob | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stateScope, setStateScope] = useState(scope);
  const startingRef = useRef<string | null>(null);
  const runRef = useRef<NotesAgentState['run']>(async () => false);

  const applyJob = useCallback((next: NotesJob | null | undefined) => {
    if (scopeRef.current !== scope) return;
    setStateScope(scope);
    if (!next) {
      setRunning(false);
      setJob(null);
      setProposal(null);
      setError(null);
      return;
    }
    setJob(next);
    // A queued relocation adopts a brand-new job immediately after resolving the previous
    // proposal. Clear that previous terminal state before rendering the next running snapshot.
    setProposal(null);
    setError(null);
    if (next.status === 'running') {
      setRunning(true);
      return;
    }
    setRunning(false);
    if (next.status === 'error' && !presentSpendJobRefusal(next.error, { operation: 'other' })) {
      setError(next.error ?? 'The notes edit failed.');
    }
    if (next.status === 'done' && next.result) setProposal(next.result);
  }, [scope]);

  // Tab screens stay mounted while their active project changes. Mask the previous scope
  // synchronously during render, then clear it so no proposal can appear or be applied under a
  // different project/target while the new latest-job lookup is in flight.
  useEffect(() => {
    setStateScope(scope);
    setRunning(false);
    setJob(null);
    setProposal(null);
    setError(null);
  }, [scope]);

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
      if (!pid || !target || !scope || startingRef.current === scope
          || (stateScope === scope && running) || !instruction.trim()) return false;
      startingRef.current = scope;
      setError(null);
      setProposal(null);
      setJob(null);
      setRunning(true); // optimistic; applyJob corrects it
      try {
        const { job: started } = await startNotesAgent(pid, target, instruction.trim());
        if (scopeRef.current !== scope) return false;
        applyJob(started);
        return true;
      } catch (e) {
        if (scopeRef.current !== scope) return false;
        if (presentSpendRefusal(e, {
          operation: 'other',
          retry: () => runRef.current(instruction),
        })) {
          setError(null);
          setRunning(false);
          return false;
        }
        setError((e as Error).message ?? 'The notes edit failed.');
        setRunning(false);
        return false;
      } finally {
        if (startingRef.current === scope) startingRef.current = null;
      }
    },
    [pid, target, scope, stateScope, running, applyJob],
  );
  runRef.current = run;

  const resume = useCallback(async () => {
    if (!pid || !target) return;
    try {
      const { job: latest } = await getLatestNotesJob(pid, target);
      applyJob(latest);
    } catch {
      // A pre-R8.3 backend has only the active-job endpoint. Preserve reattachment during the
      // short bundle/backend rollout window; it cannot recover a completed proposal, but it can
      // still recover the running jobs that older clients supported.
      try {
        const { job: active } = await getActiveNotesJob(pid, target);
        applyJob(active);
      } catch {
        // screen still works without reattaching
      }
    }
  }, [pid, target, applyJob]);

  const clearLocalJob = useCallback(() => {
    setProposal(null);
    setJob(null);
    setError(null);
  }, []);
  const proposalApplied = useCallback(() => clearLocalJob(), [clearLocalJob]);
  const dismissProposal = useCallback(() => {
    const id = job?.id;
    if (!pid || !id) {
      clearLocalJob();
      return;
    }
    const requestScope = scope;
    void discardNotesJob(pid, id)
      .then(({ ok, next_job: nextJob, next_error: nextError }) => {
        if (!ok) throw new Error('The proposal is still retained on the server.');
        if (scopeRef.current !== requestScope) return;
        if (nextJob) applyJob(nextJob);
        else clearLocalJob();
        if (nextError) setError(`This proposal was resolved, but the next paper could not start: ${nextError}`);
      })
      .catch((e) => {
        if (scopeRef.current === requestScope) {
          setError((e as Error).message ?? 'Could not discard the proposal. Try again.');
        }
      });
  }, [applyJob, clearLocalJob, job?.id, pid, scope]);
  // Error jobs are retained by the same latest-job endpoint, so clearing them uses the same
  // acknowledged discard path. A failed retry leaves both the job id and error recoverable.
  const clearError = useCallback(() => dismissProposal(), [dismissProposal]);

  const visible = stateScope === scope;
  return {
    running: visible ? running : false,
    job: visible ? job : null,
    proposal: visible ? proposal : null,
    error: visible ? error : null,
    run,
    resume,
    proposalApplied,
    dismissProposal,
    clearError,
  };
}
