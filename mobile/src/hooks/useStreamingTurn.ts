// Drives a streaming assistant turn as a server-side background job: the POST starts (or
// joins) a job that generates and RECORDS the turn no matter what this client does, and the
// hook polls the job's snapshot to render live progress (interleaved text + tool calls).
// Compared to the old single SSE connection, nothing is lost when the tunnel drops the
// request, the user navigates away, or the app is backgrounded — resume() reattaches to a
// turn still in flight, and a turn that finished while we were gone is already in the
// transcript when the session refetches.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiPost, ApiError } from '@/api/client';
import { notePlanAffectingJob } from '@/api/planInvalidation';
import { cancelChatJob, getActiveChatJob, getChatJob } from '@/api/endpoints';
import { keys } from '@/api/queries';
import type { ChatJob, StreamItem } from '@/api/types';
import { presentSpendJobRefusal, presentSpendRefusal } from '@/components/SpendRefusalSheet';
import {
  consumeEligibleHandoff,
  currentHandoffEligibilityEpoch,
  registerEligibleHandoff,
} from '@/audio/handoffState';

const POLL_MS = 900;
// Consecutive failed polls before we surface a connection warning (the job itself is safe
// server-side, so we keep polling behind the warning).
const OFFLINE_AFTER = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StreamingTurn {
  liveText: string;
  streaming: boolean;
  /** DR-056: the marker section currently being written on a proposal turn (server-derived);
   *  null on ordinary turns and before the first poll. */
  notesPhase: 'notes' | 'synthesis' | null;
  /** DR-056: the current turn drafts a proposal (finish/request-changes) — drives the staged
   *  Finish card. Derived from the run path; restored on resume from the job's notes_phase. */
  proposalTurn: boolean;
  error: string | null;
  /** Quiet, self-clearing poll status. Unlike `error`, this never asks the reader to dismiss it. */
  connectionNotice: string | null;
  /** Optional optimistic user text shown while the turn streams (cleared on settle). */
  pendingUser: string | null;
  /** The turn's text and tool invocations in arrival order, so the UI can interleave them. */
  items: StreamItem[];
  /** Reader-facing work description while no answer text is visible yet. */
  activity: string;
  /** Grounded cue jobs published while this turn is still generating. */
  previewJobIds: string[];
  /** Parent job whose finished snapshot may keep publishing cues during narration prep. */
  previewParentJobId: string | null;
  run: (
    path: string,
    body: unknown,
    optimisticUser?: string,
    onAccepted?: () => void | Promise<void>,
  ) => Promise<void>;
  /** Reattach to a turn already generating for this session (call on screen entry). */
  resume: () => Promise<void>;
  /** Stop watching. The job keeps running server-side and lands in the transcript. */
  cancel: () => void;
  /** Ask the server to STOP generating (the composer's Stop button). The partial response is
   * recorded marked as stopped; polling continues and settles through the normal done path. */
  stop: () => Promise<void>;
  clearError: () => void;
}

export function useStreamingTurn(
  pid: string | null,
  slug: string | null,
  deliveryMode: 'reading' | 'listening' = 'reading',
  onDone?: (job: ChatJob) => void | Promise<void>,
  threadId = 'main',
): StreamingTurn {
  const qc = useQueryClient();
  const [items, setItems] = useState<StreamItem[]>([]);
  const [activity, setActivity] = useState('Reading the paper…');
  const [notesPhase, setNotesPhase] = useState<'notes' | 'synthesis' | null>(null);
  // DR-056: whether the CURRENT turn drafts a proposal (finish / request-changes), known here
  // because run() sees the path — a screen-local flag was stuck true when run() early-returned
  // busy, and an ordinary reply then rendered the Finish card.
  const [proposalTurn, setProposalTurn] = useState(false);
  const [previewJobIds, setPreviewJobIds] = useState<string[]>([]);
  const [previewParentJobId, setPreviewParentJobId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  // Job id currently being watched; also the loop-exit signal (cancel/unmount nulls it).
  const watchRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  // A ref guard (not the `streaming` state) so back-to-back calls in the same tick — e.g. a
  // fast double-tap before React re-renders with the disabled button — can't both slip past
  // the check; state only updates on the next render, a ref updates immediately.
  const busyRef = useRef(false);
  const runRef = useRef<StreamingTurn['run']>(async () => {});
  // Bumped whenever the conversation (pid/slug/thread) changes. An async resume()/run()
  // captures it on entry and re-checks before attaching a watcher, so a lookup started for
  // the previous conversation can never bind its job to the new one.
  const conversationEpochRef = useRef(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      watchRef.current = null;
    };
  }, []);

  const settle = useCallback(async () => {
    if (pid && slug) {
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug, threadId) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    }
    setPendingUser(null);
    setStreaming(false);
    setItems([]);
    setNotesPhase(null);
    setProposalTurn(false);
    setActivity('Reading the paper…');
    setPreviewJobIds([]);
    setConnectionNotice(null);
  }, [pid, slug, qc, threadId]);

  /** Poll one job until it settles (or we stop watching). */
  const watch = useCallback(
    async (job: ChatJob) => {
      watchRef.current = job.id;
      setPreviewParentJobId(job.id);
      setStreaming(true);
      setItems(job.items);
      setActivity(job.activity ?? 'Reading the paper…');
      // Resume (invariant 1's whole point) must restore the staged Finish card too: a job
      // that already has a notes_phase is a proposal turn by definition.
      setNotesPhase(job.notes_phase ?? null);
      if (job.notes_phase) setProposalTurn(true);
      setPreviewJobIds(job.preview_job_ids);
      setConnectionNotice(null);
      let misses = 0;
      while (aliveRef.current && watchRef.current === job.id) {
        await sleep(POLL_MS);
        if (!aliveRef.current || watchRef.current !== job.id) return;
        let snap: ChatJob;
        try {
          snap = (await getChatJob(pid!, job.id)).job;
          misses = 0;
          setConnectionNotice(null);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            // Server restarted and forgot the job; whatever completed is in the session.
            watchRef.current = null;
            setPreviewParentJobId(null);
            await settle();
            return;
          }
          // Transient network blip: the turn is safe server-side, so keep polling and only
          // warn (without giving up) if the connection stays down.
          if (++misses >= OFFLINE_AFTER) {
            setConnectionNotice('Reconnecting… Your response is safe.');
          }
          continue;
        }
        if (!aliveRef.current || watchRef.current !== job.id) return;
        setItems(snap.items);
        setActivity(snap.activity ?? 'Reading the paper…');
        setNotesPhase(snap.notes_phase ?? null);
        setPreviewJobIds(snap.preview_job_ids);
        if (snap.status === 'done') {
          watchRef.current = null;
          setPreviewParentJobId(snap.preview_complete ? null : snap.id);
          try {
            await onDoneRef.current?.(snap);
          } catch (e) {
            setError((e as Error).message ?? 'The response finished, but audio could not start.');
          }
          await settle();
          return;
        }
        if (snap.status === 'error') {
          watchRef.current = null;
          setPreviewParentJobId(null);
          if (snap.delivery_mode === 'listening') {
            await consumeEligibleHandoff(snap.id);
          }
          if (!presentSpendJobRefusal(snap.refusal, { operation: 'other' })) {
            setError(snap.error ?? 'The response failed.');
          }
          setStreaming(false);
          setPendingUser(null);
          setPreviewJobIds([]);
          setConnectionNotice(null);
          return;
        }
      }
    },
    [pid, settle],
  );

  const run = useCallback(
    async (
      path: string,
      body: unknown,
      optimisticUser?: string,
      onAccepted?: () => void | Promise<void>,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setConnectionNotice(null);
      setItems([]);
      setNotesPhase(null);
      setProposalTurn(path.endsWith('/finish_job') || path.endsWith('/request_changes_job'));
      setActivity('Reading the paper…');
      setPreviewJobIds([]);
      setPreviewParentJobId(null);
      setPendingUser(optimisticUser ?? null);
      setStreaming(true);
      const epoch = conversationEpochRef.current;
      const handoffEpoch = currentHandoffEligibilityEpoch();
      try {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? {
              ...(body as Record<string, unknown>),
              delivery_mode: deliveryMode,
              ...(threadId === 'main' ? {} : { thread_id: threadId }),
            }
          : body;
        const { job } = await apiPost<{ job: ChatJob }>(path, payload);
        // The one job start that bypasses endpoints.ts (paths come from turnJobPaths):
        // report it so the plan screen sees the new hold without waiting for a poll.
        notePlanAffectingJob(job);
        if (job.delivery_mode === 'listening') {
          await registerEligibleHandoff(job.id, handoffEpoch);
        }
        try {
          await onAccepted?.();
        } catch {
          // Acceptance is already authoritative server-side. A local storage cleanup failure
          // must not detach the client from the running job; reconciliation can retry later.
        }
        if (epoch !== conversationEpochRef.current) return;
        await watch(job);
      } catch (e) {
        setPreviewParentJobId(null);
        if (presentSpendRefusal(e, {
          operation: 'other',
          retry: () => runRef.current(path, body, optimisticUser, onAccepted),
        })) {
          setError(null);
          setPendingUser(null);
          setStreaming(false);
          return;
        }
        setError((e as Error).message ?? 'Could not start the response.');
        setPendingUser(null);
        let recoveredActiveJob = false;
        if (pid && slug) {
          try {
            // The request may have reached the server even if its response was lost. Refetching
            // lets persisted authored drafts reconcile against accepted transcript inputs.
            await qc.invalidateQueries({ queryKey: keys.session(pid, slug, threadId) });
            await qc.invalidateQueries({ queryKey: keys.opening(pid, slug, threadId) });
            const { job: active } = await getActiveChatJob(pid, slug, threadId);
            if (epoch !== conversationEpochRef.current) return;
            if (active) {
              recoveredActiveJob = true;
              setError(null);
              await watch(active);
            }
          } catch {
            // Offline: keep the persisted draft; the next mount/refetch will reconcile it.
          }
        }
        if (!recoveredActiveJob) setStreaming(false);
      } finally {
        busyRef.current = false;
      }
    },
    [deliveryMode, pid, qc, slug, threadId, watch],
  );
  runRef.current = run;

  const resume = useCallback(async () => {
    if (!pid || !slug || busyRef.current) return;
    busyRef.current = true;
    const epoch = conversationEpochRef.current;
    const handoffEpoch = currentHandoffEligibilityEpoch();
    try {
      const { job } = await getActiveChatJob(pid, slug, threadId);
      // The conversation may have switched while the lookup was in flight (e.g. the
      // last-opened-thread restore landing right after mount): this lookup belongs to the
      // OLD thread, and watch() would re-establish its job on the new one.
      if (epoch !== conversationEpochRef.current) return;
      if (!job || !aliveRef.current) {
        setPreviewParentJobId(null);
        return;
      }
      if (job.delivery_mode === 'listening' && deliveryMode === 'listening') {
        await registerEligibleHandoff(job.id, handoffEpoch);
      }
      // The message that started this turn is already recorded server-side; refresh the
      // transcript so it shows while we reattach to the live turn.
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug, threadId) });
      if (epoch !== conversationEpochRef.current) return;
      await watch(job);
    } catch {
      setPreviewParentJobId(null);
      // Can't reach the server right now; the session refetch will catch us up later.
    } finally {
      busyRef.current = false;
    }
  }, [deliveryMode, pid, slug, qc, threadId, watch]);

  // Switching conversations must never keep painting or polling the previous thread's job.
  // The epoch bump also invalidates any in-flight resume()/run() recovery lookup that was
  // started for the previous conversation (it re-checks before attaching a watcher).
  useEffect(() => {
    conversationEpochRef.current += 1;
    watchRef.current = null;
    busyRef.current = false;
    setStreaming(false);
    setPendingUser(null);
    setItems([]);
    setNotesPhase(null);
    setProposalTurn(false);
    setActivity('Reading the paper…');
    setPreviewJobIds([]);
    setPreviewParentJobId(null);
    setError(null);
    setConnectionNotice(null);
  }, [pid, slug, threadId]);

  const cancel = useCallback(() => {
    watchRef.current = null;
    setPreviewParentJobId(null);
    setStreaming(false);
    setPendingUser(null);
    setPreviewJobIds([]);
    setConnectionNotice(null);
  }, []);

  const stop = useCallback(async () => {
    const id = watchRef.current;
    if (!id || !pid) return;
    try {
      await cancelChatJob(pid, id);
      // Keep watching: the worker settles the job (with the stopped partial recorded) within
      // one event boundary, and the normal done path refetches the transcript.
    } catch (e) {
      setError((e as Error).message ?? 'Could not stop the response.');
    }
  }, [pid]);

  const clearError = useCallback(() => setError(null), []);

  const liveText = useMemo(
    () => items.filter((it): it is Extract<StreamItem, { kind: 'text' }> => it.kind === 'text')
      .map((it) => it.text).join(''),
    [items],
  );

  return {
    liveText,
    streaming,
    notesPhase,
    proposalTurn,
    error,
    connectionNotice,
    pendingUser,
    items,
    activity,
    previewJobIds,
    previewParentJobId,
    run,
    resume,
    cancel,
    stop,
    clearError,
  };
}
