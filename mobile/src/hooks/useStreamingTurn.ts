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
import { getActiveChatJob, getChatJob } from '@/api/endpoints';
import { keys } from '@/api/queries';
import type { ChatJob, StreamItem } from '@/api/types';
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
  error: string | null;
  /** Optional optimistic user text shown while the turn streams (cleared on settle). */
  pendingUser: string | null;
  /** The turn's text and tool invocations in arrival order, so the UI can interleave them. */
  items: StreamItem[];
  /** Grounded cue jobs published while this turn is still generating. */
  previewJobIds: string[];
  run: (path: string, body: unknown, optimisticUser?: string) => Promise<void>;
  /** Reattach to a turn already generating for this session (call on screen entry). */
  resume: () => Promise<void>;
  /** Stop watching. The job keeps running server-side and lands in the transcript. */
  cancel: () => void;
  clearError: () => void;
}

export function useStreamingTurn(
  pid: string | null,
  slug: string | null,
  deliveryMode: 'reading' | 'listening' = 'reading',
  onDone?: (job: ChatJob) => void | Promise<void>,
  onJobActiveChange?: (active: boolean) => void,
): StreamingTurn {
  const qc = useQueryClient();
  const [items, setItems] = useState<StreamItem[]>([]);
  const [previewJobIds, setPreviewJobIds] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  // Job id currently being watched; also the loop-exit signal (cancel/unmount nulls it).
  const watchRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  // A ref guard (not the `streaming` state) so back-to-back calls in the same tick — e.g. a
  // fast double-tap before React re-renders with the disabled button — can't both slip past
  // the check; state only updates on the next render, a ref updates immediately.
  const busyRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onJobActiveChangeRef = useRef(onJobActiveChange);
  onJobActiveChangeRef.current = onJobActiveChange;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      watchRef.current = null;
      onJobActiveChangeRef.current?.(false);
    };
  }, []);

  const settle = useCallback(async () => {
    if (pid && slug) {
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await qc.invalidateQueries({ queryKey: keys.projectState(pid) });
    }
    setPendingUser(null);
    setStreaming(false);
    setItems([]);
    setPreviewJobIds([]);
  }, [pid, slug, qc]);

  /** Poll one job until it settles (or we stop watching). */
  const watch = useCallback(
    async (job: ChatJob) => {
      watchRef.current = job.id;
      onJobActiveChangeRef.current?.(true);
      setStreaming(true);
      setItems(job.items);
      setPreviewJobIds(job.preview_job_ids);
      let misses = 0;
      while (aliveRef.current && watchRef.current === job.id) {
        await sleep(POLL_MS);
        if (!aliveRef.current || watchRef.current !== job.id) return;
        let snap: ChatJob;
        try {
          snap = (await getChatJob(pid!, job.id)).job;
          misses = 0;
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            // Server restarted and forgot the job; whatever completed is in the session.
            watchRef.current = null;
            onJobActiveChangeRef.current?.(false);
            await settle();
            return;
          }
          // Transient network blip: the turn is safe server-side, so keep polling and only
          // warn (without giving up) if the connection stays down.
          if (++misses >= OFFLINE_AFTER) {
            setError('Connection lost — the response is still being generated and will appear once you’re back online.');
          }
          continue;
        }
        if (!aliveRef.current || watchRef.current !== job.id) return;
        setItems(snap.items);
        setPreviewJobIds(snap.preview_job_ids);
        if (snap.status === 'done') {
          watchRef.current = null;
          onJobActiveChangeRef.current?.(false);
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
          onJobActiveChangeRef.current?.(false);
          if (snap.delivery_mode === 'listening') {
            await consumeEligibleHandoff(snap.id);
          }
          setError(snap.error ?? 'The response failed.');
          setStreaming(false);
          setPendingUser(null);
          setPreviewJobIds([]);
          return;
        }
      }
    },
    [pid, settle],
  );

  const run = useCallback(
    async (path: string, body: unknown, optimisticUser?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setItems([]);
      setPreviewJobIds([]);
      setPendingUser(optimisticUser ?? null);
      setStreaming(true);
      const handoffEpoch = currentHandoffEligibilityEpoch();
      try {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), delivery_mode: deliveryMode }
          : body;
        const { job } = await apiPost<{ job: ChatJob }>(path, payload);
        if (job.delivery_mode === 'listening') {
          await registerEligibleHandoff(job.id, handoffEpoch);
        }
        await watch(job);
      } catch (e) {
        onJobActiveChangeRef.current?.(false);
        setError((e as Error).message ?? 'Could not start the response.');
        setStreaming(false);
        setPendingUser(null);
      } finally {
        busyRef.current = false;
      }
    },
    [deliveryMode, watch],
  );

  const resume = useCallback(async () => {
    if (!pid || !slug || busyRef.current) return;
    busyRef.current = true;
    const handoffEpoch = currentHandoffEligibilityEpoch();
    try {
      const { job } = await getActiveChatJob(pid, slug);
      if (!job || !aliveRef.current) {
        onJobActiveChangeRef.current?.(false);
        return;
      }
      if (job.delivery_mode === 'listening' && deliveryMode === 'listening') {
        await registerEligibleHandoff(job.id, handoffEpoch);
      }
      // The message that started this turn is already recorded server-side; refresh the
      // transcript so it shows while we reattach to the live turn.
      await qc.invalidateQueries({ queryKey: keys.session(pid, slug) });
      await watch(job);
    } catch {
      onJobActiveChangeRef.current?.(false);
      // Can't reach the server right now; the session refetch will catch us up later.
    } finally {
      busyRef.current = false;
    }
  }, [deliveryMode, pid, slug, qc, watch]);

  const cancel = useCallback(() => {
    watchRef.current = null;
    onJobActiveChangeRef.current?.(false);
    setStreaming(false);
    setPendingUser(null);
    setPreviewJobIds([]);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const liveText = useMemo(
    () => items.filter((it): it is Extract<StreamItem, { kind: 'text' }> => it.kind === 'text')
      .map((it) => it.text).join(''),
    [items],
  );

  return {
    liveText,
    streaming,
    error,
    pendingUser,
    items,
    previewJobIds,
    run,
    resume,
    cancel,
    clearError,
  };
}
