// DR-140 — drives the reading-assistant flow for one conversation: offer → pass → hand-off.
//
// The offer is earned by the LATEST response (its own `rc-paper:` links to unread project
// papers, decided server-side) and answered once per response: "Not now" is remembered per
// assistant index, so re-entering the paper does not nag, while a later response that cites
// other unread papers asks afresh. The pass is a server-side job (invariant 1): this hook only
// polls it and, when the job chains the agent's follow-up turn, hands the screen's ordinary
// turn watcher the job through `resumeTurn` — the follow-up then streams like any other turn.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '@/api/client';
import {
  cancelReaderJob,
  getActiveReaderJob,
  getReaderJob,
  startReaderJob,
} from '@/api/endpoints';
import { keys, useReaderCandidates } from '@/api/queries';
import type { ReaderCandidate, ReaderJob, TranscriptEntry } from '@/api/types';
import { presentSpendJobRefusal, presentSpendRefusal } from '@/components/SpendRefusalSheet';
import { dismissReaderOffer, isReaderOfferDismissed } from '@/lib/readerOffer';

const POLL_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ReaderBriefing {
  /** The offer to render, or null (no candidates, dismissed, a pass in flight, streaming…). */
  offer: { assistantIndex: number; candidates: ReaderCandidate[] } | null;
  /** The pass to render (running, or terminal and not yet dismissed), or null. */
  job: ReaderJob | null;
  selected: ReadonlySet<string>;
  toggle: (slug: string) => void;
  start: () => Promise<void>;
  dismissOffer: () => void;
  dismissJob: () => void;
  cancel: () => Promise<void>;
  starting: boolean;
  error: string | null;
}

export function useReaderBriefing({
  pid,
  slug,
  threadId,
  transcript,
  streaming,
  deliveryMode,
  resumeTurn,
}: {
  pid: string;
  slug: string;
  threadId: string;
  transcript: TranscriptEntry[];
  /** A turn is generating — no offer while the response it would be about is still forming. */
  streaming: boolean;
  deliveryMode: 'reading' | 'listening';
  /** The screen's turn watcher's reattach (useStreamingTurn.resume). */
  resumeTurn: () => Promise<void>;
}): ReaderBriefing {
  const qc = useQueryClient();
  const last = transcript.length ? transcript[transcript.length - 1] : undefined;
  const latestIndex = last?.role === 'assistant' ? last.assistant_index : null;

  const [job, setJob] = useState<ReaderJob | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = not yet checked for this response; the offer stays hidden until it is, so a
  // declined offer never flashes before AsyncStorage answers.
  const [dismissedFor, setDismissedFor] = useState<{ index: number; dismissed: boolean } | null>(null);
  const watchRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  // Bumped when the conversation changes, so an in-flight lookup for the previous one can never
  // bind its job here (the same guard useStreamingTurn keeps).
  const epochRef = useRef(0);
  const resumeRef = useRef(resumeTurn);
  resumeRef.current = resumeTurn;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      watchRef.current = null;
    };
  }, []);

  const candidatesEnabled = latestIndex != null && !streaming && job == null;
  const candidatesQuery = useReaderCandidates(pid, slug, threadId, candidatesEnabled);
  const candidates = candidatesQuery.data?.candidates ?? [];
  const candidatesIndex = candidatesQuery.data?.assistant_index ?? null;

  const watch = useCallback(async (start: ReaderJob) => {
    const epoch = epochRef.current;
    watchRef.current = start.id;
    setJob(start);
    let snap = start;
    while (aliveRef.current && watchRef.current === start.id && snap.status === 'running') {
      await sleep(POLL_MS);
      if (!aliveRef.current || watchRef.current !== start.id) return;
      try {
        snap = (await getReaderJob(pid, start.id)).job;
        if (epochRef.current !== epoch) return;
        setJob(snap);
      } catch {
        // The job keeps running server-side; a dead poll just delays the next snapshot.
      }
    }
    if (!aliveRef.current || watchRef.current !== start.id || epochRef.current !== epoch) return;
    watchRef.current = null;
    if (snap.analysis_job_id) {
      // The pass chained the agent's follow-up; let the screen's own watcher stream it, then
      // the session refetch (its settle) replaces this card with the revised response.
      await resumeRef.current();
    } else if (snap.status === 'error') {
      presentSpendJobRefusal(snap.refusal, { operation: 'other' });
    } else if (snap.analysis_refusal) {
      presentSpendJobRefusal(snap.analysis_refusal, { operation: 'other' });
    }
    // Either way the server-side record may have moved (a briefing turn recorded, or a
    // pending_turn marker for a follow-up that did not start).
    void qc.invalidateQueries({ queryKey: keys.session(pid, slug, threadId) });
  }, [pid, slug, threadId, qc]);

  // Conversation change: reset everything, then reattach to a pass still running here.
  useEffect(() => {
    epochRef.current += 1;
    const epoch = epochRef.current;
    watchRef.current = null;
    setJob(null);
    setSelected(new Set());
    setStarting(false);
    setError(null);
    setDismissedFor(null);
    void (async () => {
      try {
        const active = (await getActiveReaderJob(pid, slug, threadId)).job;
        if (epochRef.current !== epoch || !aliveRef.current) return;
        if (active && active.status === 'running') await watch(active);
      } catch {
        // No reattach; the offer flow below still works.
      }
    })();
  }, [pid, slug, threadId, watch]);

  // A new response arrived (the follow-up landed, or the reader just replied): a terminal pass
  // card from the previous response is stale, and the "Not now" memory is per response.
  useEffect(() => {
    if (job && job.status !== 'running' && job.assistant_index !== latestIndex) setJob(null);
    if (latestIndex == null) {
      setDismissedFor(null);
      return;
    }
    let cancelled = false;
    void isReaderOfferDismissed(pid, slug, threadId, latestIndex).then((dismissed) => {
      if (!cancelled) setDismissedFor({ index: latestIndex, dismissed });
    });
    return () => {
      cancelled = true;
    };
    // `job` is deliberately not a dependency: this reacts to the transcript moving, not to
    // poll snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, slug, threadId, latestIndex]);

  // Default selection: every readable candidate, re-derived when the candidate set changes.
  const candidateKey = candidates.map((c) => `${c.slug}:${c.has_text ? 1 : 0}`).join('|');
  useEffect(() => {
    setSelected(new Set(candidates.filter((c) => c.has_text).map((c) => c.slug)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, candidatesIndex]);

  const toggle = useCallback((target: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }, []);

  const start = useCallback(async () => {
    if (starting || latestIndex == null) return;
    const targets = candidates.filter((c) => c.has_text && selected.has(c.slug)).map((c) => c.slug);
    if (!targets.length) return;
    setStarting(true);
    setError(null);
    try {
      const started = (await startReaderJob(pid, slug, targets, {
        threadId,
        assistantIndex: candidatesIndex ?? latestIndex,
        deliveryMode,
      })).job;
      setStarting(false);
      await watch(started);
    } catch (e) {
      setStarting(false);
      if (presentSpendRefusal(e, { operation: 'other', retry: () => start() })) return;
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not start reading.');
    }
  }, [starting, latestIndex, candidates, selected, pid, slug, threadId, candidatesIndex, deliveryMode, watch]);

  const dismissOffer = useCallback(() => {
    if (latestIndex == null) return;
    dismissReaderOffer(pid, slug, threadId, latestIndex);
    setDismissedFor({ index: latestIndex, dismissed: true });
  }, [pid, slug, threadId, latestIndex]);

  const dismissJob = useCallback(() => {
    watchRef.current = null;
    setJob(null);
  }, []);

  const cancel = useCallback(async () => {
    if (!job || job.status !== 'running') return;
    try {
      setJob((await cancelReaderJob(pid, job.id)).job);
    } catch {
      // Best effort; the poll keeps reporting the true state.
    }
  }, [job, pid]);

  const offer = useMemo(() => {
    if (job || streaming || latestIndex == null) return null;
    if (!dismissedFor || dismissedFor.index !== latestIndex || dismissedFor.dismissed) return null;
    if (candidatesIndex !== latestIndex) return null; // stale data from the previous response
    if (!candidates.some((c) => c.has_text)) return null;
    return { assistantIndex: latestIndex, candidates };
  }, [job, streaming, latestIndex, dismissedFor, candidatesIndex, candidates]);

  return {
    offer,
    job: job && (job.status === 'running' || job.assistant_index === latestIndex) ? job : null,
    selected,
    toggle,
    start,
    dismissOffer,
    dismissJob,
    cancel,
    starting,
    error,
  };
}
