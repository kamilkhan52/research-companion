// DR-140/145 — drives the reading-assistant flow for one conversation: offer → pass → hand-off.
//
// The offer is earned by the LATEST response (its own `rc-paper:` links to unread project
// papers, decided server-side). DR-145 makes it a WINDOW that presents itself once and is then
// reachable from a small indicator under that response, rather than a card the reader has to
// answer: the per-response memory records that it has presented itself, so re-entering the paper
// never raises it again, while a later response citing other unread papers asks afresh.
//
// A candidate whose text has never been fetched used to be an unexplained dead row. Kamil:
// "if fetch is needed, the agent should just automatically try. It doesn't cost anything in most
// cases." So the hook starts the ordinary background retrieval job for each unfetched candidate,
// in sequence and bounded by what a pass can read, and re-reads the candidates when one lands.
//
// The pass is a server-side job (invariant 1): this hook only polls it and, when the job chains
// the agent's follow-up turn, hands the screen's ordinary turn watcher the job through
// `resumeTurn` — the follow-up then streams like any other turn.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '@/api/client';
import {
  cancelReaderJob,
  getActiveReaderJob,
  getReaderJob,
  getRetrievalJob,
  startReaderJob,
  startRetrievalJob,
} from '@/api/endpoints';
import { keys, useReaderCandidates } from '@/api/queries';
import type { ReaderCandidate, ReaderJob, TranscriptEntry } from '@/api/types';
import { presentSpendJobRefusal, presentSpendRefusal } from '@/components/SpendRefusalSheet';
import {
  deferReaderOffer,
  isReaderOfferDeferred,
  markReaderAutoFetchAttempted,
  readerAutoFetchAttempted,
  readerOfferKeyFor,
} from '@/lib/readerOffer';

const POLL_MS = 1500;
const FETCH_POLL_MS = 2000;
/** What a pass reads, and so also what may be auto-fetched, when the server has not said —
 *  an older backend, or a candidates payload from cache that predates `max_targets`. Mirrors
 *  `reader_jobs.MAX_TARGETS`. The live value travels with the candidates; this is the floor
 *  under it, never the authority. */
const DEFAULT_MAX_TARGETS = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where a candidate's on-demand text fetch has got to. Absent = never attempted here. */
export interface ReaderFetchState {
  status: 'running' | 'error' | 'needs_choice';
  error?: string | null;
}

export interface ReaderBriefing {
  /** The offer that exists for the latest response, or null (none earned, a pass in flight,
   *  streaming…). It survives the window being closed — the indicator reopens it. */
  offer: { assistantIndex: number; candidates: ReaderCandidate[] } | null;
  /** Is the offer window itself on screen? */
  offerOpen: boolean;
  openOffer: () => void;
  /** Close the window without answering; the indicator under the response keeps it reachable. */
  closeOffer: () => void;
  /** The pass to render (running, or terminal and not yet dismissed), or null. */
  job: ReaderJob | null;
  selected: ReadonlySet<string>;
  /** How many papers one pass may read — the server's `reader_jobs.MAX_TARGETS`. The offer
   *  shows it, and neither the default selection nor `toggle` may exceed it (DR-155). */
  maxTargets: number;
  toggle: (slug: string) => void;
  start: () => Promise<void>;
  dismissJob: () => void;
  cancel: () => Promise<void>;
  /** Per-slug state of text fetches this hook started (auto or asked for). */
  fetching: Record<string, ReaderFetchState>;
  fetchCandidate: (slug: string) => Promise<void>;
  starting: boolean;
  error: string | null;
}

export function useReaderBriefing({
  pid,
  slug,
  threadId,
  enabled = true,
  state,
  transcript,
  streaming,
  deliveryMode,
  focused = true,
  resumeTurn,
}: {
  pid: string;
  slug: string;
  threadId: string;
  /** False while the route has no established discussion. No reader-job request is made. */
  enabled?: boolean;
  /** The session state: the offer exists only while the discussion is open (`in_discussion`)
   *  — after Finish the trailing records are a proposal, and the server refuses a pass then. */
  state: string | null;
  transcript: TranscriptEntry[];
  /** A turn is generating — no offer while the response it would be about is still forming. */
  streaming: boolean;
  deliveryMode: 'reading' | 'listening';
  /** Whether this paper's screen is the one on top. The window may only PRESENT itself while it
   *  is: a response can land after the reader has navigated to the Library or Discover, and the
   *  sheet is mounted by a screen that is still alive underneath, so it would otherwise open
   *  over whatever they moved to. Closing/reopening from the indicator is unaffected. */
  focused?: boolean;
  /** The screen's turn watcher's reattach (useStreamingTurn.resume). */
  resumeTurn: () => Promise<void>;
}): ReaderBriefing {
  const qc = useQueryClient();
  const last = transcript.length ? transcript[transcript.length - 1] : undefined;
  const latestIndex = last?.role === 'assistant' ? last.assistant_index : null;
  // The response's identity for the "Not now" memory: its job id, so a retried response at
  // the same index is asked afresh (see lib/readerOffer).
  const latestKey = last?.role === 'assistant' ? readerOfferKeyFor(last) : null;

  const [job, setJob] = useState<ReaderJob | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = not yet checked for this response; the offer stays hidden until it is, so a window
  // that has already presented itself never flashes before AsyncStorage answers.
  const [deferredFor, setDeferredFor] = useState<{ key: string; deferred: boolean } | null>(null);
  const [offerOpen, setOfferOpen] = useState(false);
  const [fetching, setFetching] = useState<Record<string, ReaderFetchState>>({});
  //: The response whose window has already been raised on this mount.
  const presentedRef = useRef<string | null>(null);
  //: Slugs a fetch has been started for, so the auto-pass never re-attempts one it has tried.
  const attemptedRef = useRef<Set<string>>(new Set());
  //: Slugs whose fetch is polling right now (a manual press must not duplicate the auto one).
  const fetchingRef = useRef<Set<string>>(new Set());
  //: Auto-fetches run one after another rather than as a burst of paid hunts.
  const autoQueueRef = useRef<Promise<void>>(Promise.resolve());
  //: How many automatic fetches this conversation may still spend. A TOTAL, not a concurrency
  //: limit — see the auto-fetch effect.
  const autoFetchBudgetRef = useRef(DEFAULT_MAX_TARGETS);
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

  const candidatesEnabled = enabled && latestIndex != null && !streaming && job == null;
  const candidatesQuery = useReaderCandidates(pid, slug, threadId, candidatesEnabled);
  const candidates = candidatesQuery.data?.candidates ?? [];
  const candidatesIndex = candidatesQuery.data?.assistant_index ?? null;
  const maxTargets = candidatesQuery.data?.max_targets ?? DEFAULT_MAX_TARGETS;

  const watch = useCallback(async (start: ReaderJob) => {
    const epoch = epochRef.current;
    watchRef.current = start.id;
    setJob(start);
    let snap = start;
    // Until `finished_at`, not until `status` leaves running: a Stop flips the status at once
    // while the worker still unwinds — and may still chain the follow-up turn — so reading
    // `analysis_job_id` before finalization would miss it (Opus review of #492).
    while (aliveRef.current && watchRef.current === start.id && (snap.status === 'running' || !snap.finished_at)) {
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
    setDeferredFor(null);
    setOfferOpen(false);
    setFetching({});
    presentedRef.current = null;
    attemptedRef.current = new Set();
    autoFetchBudgetRef.current = DEFAULT_MAX_TARGETS;
    fetchingRef.current = new Set();
    autoQueueRef.current = Promise.resolve();
    if (!enabled) return;
    void (async () => {
      try {
        const active = (await getActiveReaderJob(pid, slug, threadId)).job;
        if (epochRef.current !== epoch || !aliveRef.current) return;
        // The server also returns a cooperatively-cancelled pass until its worker has really
        // finalized. Reattach to it too: the in-flight paid read may still retain and hand off a
        // brief, and offering a replacement pass in this window would duplicate the call.
        if (active) await watch(active);
      } catch {
        // No reattach; the offer flow below still works.
      }
    })();
  }, [pid, slug, threadId, enabled, watch]);

  // A new response arrived (the follow-up landed, or the reader just replied): a terminal pass
  // card from the previous response is stale, and the "Not now" memory is per response.
  useEffect(() => {
    if (job && job.status !== 'running' && job.assistant_index !== latestIndex) setJob(null);
    if (latestKey == null) {
      setDeferredFor(null);
      return;
    }
    let cancelled = false;
    void isReaderOfferDeferred(pid, slug, threadId, latestKey).then((deferred) => {
      if (!cancelled) setDeferredFor({ key: latestKey, deferred });
    });
    return () => {
      cancelled = true;
    };
    // `job` is deliberately not a dependency: this reacts to the transcript moving, not to
    // poll snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, slug, threadId, latestIndex, latestKey]);

  // Default selection: every readable candidate, up to what one pass may read. The cap is why
  // it is a slice — Kamil's response cited seventeen, all seventeen were ticked, and the button
  // offered to "Read 17 papers" that the server would refuse (DR-155).
  //
  // A fetch landing mid-offer flips one row's `has_text` without the paper set changing — that
  // ADDS the new row rather than re-deriving the whole selection, or a fetch finishing would
  // silently re-check papers the reader had just unchecked (DR-145 made this reachable: before
  // it, `has_text` never changed here). An arrival can only fill room the reader left; it never
  // displaces a paper they chose.
  const slugKey = candidates.map((c) => c.slug).join('|');
  const readableKey = candidates.filter((c) => c.has_text).map((c) => c.slug).join('|');
  const prevSelectionBasis = useRef<{ slugKey: string; index: number | null; readable: Set<string> } | null>(null);
  useEffect(() => {
    const readable = candidates.filter((c) => c.has_text).map((c) => c.slug);
    const prev = prevSelectionBasis.current;
    if (prev && prev.slugKey === slugKey && prev.index === candidatesIndex) {
      const added = readable.filter((s) => !prev.readable.has(s));
      if (added.length) {
        setSelected((current) => {
          const next = new Set(current);
          for (const s of added) {
            if (next.size >= maxTargets) break;
            next.add(s);
          }
          return next;
        });
      }
    } else {
      setSelected(new Set(readable.slice(0, maxTargets)));
    }
    prevSelectionBasis.current = { slugKey, index: candidatesIndex, readable: new Set(readable) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugKey, readableKey, candidatesIndex, maxTargets]);

  const toggle = useCallback((target: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      // Unticking is always allowed; ticking stops at the pass limit. Refusing here rather than
      // at the server is the whole of DR-155: a ninth tick used to arm a button reading "Read 9
      // papers" and then fail on submit. The offer says the cap, so the row going inert has an
      // explanation on screen beside it.
      if (next.has(target)) next.delete(target);
      else if (next.size < maxTargets) next.add(target);
      return next;
    });
  }, [maxTargets]);

  /** Fetch one candidate's text with the ordinary background retrieval job (invariant 1: this
   *  polls a server-side job, it does not hold a request open). Best effort — a failure leaves a
   *  row the reader can retry, never an error over the discussion. */
  const fetchCandidate = useCallback(async (target: string) => {
    if (!enabled || !target || fetchingRef.current.has(target)) return;
    const epoch = epochRef.current;
    fetchingRef.current.add(target);
    attemptedRef.current.add(target);
    setFetching((prev) => ({ ...prev, [target]: { status: 'running' } }));
    const settle = (state: ReaderFetchState | null) => {
      fetchingRef.current.delete(target);
      if (!aliveRef.current || epochRef.current !== epoch) return;
      setFetching((prev) => {
        const next = { ...prev };
        if (state) next[target] = state;
        else delete next[target];
        return next;
      });
    };
    try {
      // No `auto_analyze`: the reader asked for the paper's TEXT so an assistant can read it,
      // not for a summary turn on it — that would be a paid turn nobody requested.
      let snap = (await startRetrievalJob(pid, target, {})).job;
      while (aliveRef.current && epochRef.current === epoch && snap.status === 'running') {
        await sleep(FETCH_POLL_MS);
        if (!aliveRef.current || epochRef.current !== epoch) return settle(null);
        try {
          snap = (await getRetrievalJob(pid, snap.id)).job;
        } catch {
          // The retrieval keeps running server-side; a dead poll only delays the next snapshot.
        }
      }
      if (!aliveRef.current || epochRef.current !== epoch) return settle(null);
      if (snap.retrieved) {
        settle(null);
        // `has_text` is server-derived, so the offer only learns the paper became readable by
        // re-reading the candidates.
        await qc.invalidateQueries({
          queryKey: [...keys.session(pid, slug, threadId), 'reader-candidates'],
        });
        return;
      }
      if (snap.phase === 'confirmation') return settle({ status: 'needs_choice' });
      settle({ status: 'error', error: snap.error ?? null });
    } catch (e) {
      settle({
        status: 'error',
        error: e instanceof ApiError ? e.message : (e as Error)?.message ?? null,
      });
    }
  }, [enabled, pid, slug, threadId, qc]);

  const start = useCallback(async () => {
    if (!enabled || starting || latestIndex == null) return;
    const targets = candidates
      .filter((c) => c.has_text && selected.has(c.slug))
      .map((c) => c.slug)
      // Unreachable while the selection itself is capped, and kept anyway: a server that lowers
      // the cap between the candidates arriving and the reader pressing Read would otherwise
      // send a list it will refuse.
      .slice(0, maxTargets);
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
      // The pass has its own surface — the header indicator (DR-146). Nothing is left to answer.
      setOfferOpen(false);
      await watch(started);
    } catch (e) {
      setStarting(false);
      if (presentSpendRefusal(e, { operation: 'other', retry: () => start() })) return;
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not start reading.');
    }
  }, [enabled, starting, latestIndex, candidates, selected, maxTargets, pid, slug, threadId,
      candidatesIndex, deliveryMode, watch]);

  const openOffer = useCallback(() => setOfferOpen(true), []);

  /** Closing is a deferral, never an answer (DR-145): the record that this response's window has
   *  been seen is written when it OPENS, so the app cannot re-raise it even if it is killed with
   *  the window up, and the indicator under the response keeps the offer one tap away. */
  const closeOffer = useCallback(() => setOfferOpen(false), []);

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
    if (!enabled || job || streaming || latestIndex == null || latestKey == null) return null;
    if (state !== 'in_discussion') return null; // the server refuses a pass behind a proposal
    // Wait for the memory to answer before anything shows, so a window that has already
    // presented itself cannot flash open while AsyncStorage is still being read.
    if (!deferredFor || deferredFor.key !== latestKey) return null;
    if (candidatesIndex !== latestIndex) return null; // stale data from the previous response
    // Unfetched papers still count: the offer is what OFFERS to fetch them (DR-145).
    if (!candidates.length) return null;
    return { assistantIndex: latestIndex, candidates };
  }, [enabled, job, streaming, state, latestIndex, latestKey, deferredFor, candidatesIndex, candidates]);

  // The window presents itself once per response, and records that it has — so re-entering the
  // paper leaves only the indicator, and the reader is never made to answer (DR-145).
  useEffect(() => {
    if (!offer || latestKey == null || deferredFor?.key !== latestKey) return;
    // Not while another screen is on top. Deliberately does NOT mark the offer as presented, so
    // it still gets its one chance when the reader comes back to the paper — a window they never
    // saw must not be spent.
    if (!focused) return;
    if (presentedRef.current === latestKey) return;
    presentedRef.current = latestKey;
    if (deferredFor.deferred) return;
    deferReaderOffer(pid, slug, threadId, latestKey);
    setOfferOpen(true);
  }, [offer, latestKey, deferredFor, pid, slug, threadId, focused]);

  // "if fetch is needed, the agent should just automatically try. It doesn't cost anything in
  // most cases" (Kamil, DR-145). In sequence, never as a burst, and bounded three ways — each
  // bound closes a way the same paid hunt could be bought more than once (Opus review of #503):
  //
  //  * `readerAutoFetchAttempted` is DURABLE. A paper whose PDF cannot be resolved escalates to
  //    the ~$0.10 agentic hunt, and an in-memory set only lives as long as the screen, so
  //    re-entering the paper re-bought that hunt every single time.
  //  * `autoFetchBudgetRef` counts TOTAL attempts, not how many are outstanding. The old slice
  //    was taken from the currently-unfetched list on every change, so as fetches landed and the
  //    list shrank, fresh candidates kept entering the first eight and the real total was
  //    unbounded.
  //  * the queued closure re-checks the EPOCH, not just liveness. Switching threads resets the
  //    queue ref, which detaches the new queue but leaves the old chain running: its remaining
  //    entries would go on buying retrievals for a conversation the reader had left.
  useEffect(() => {
    if (!offer) return;
    const epoch = epochRef.current;
    let cancelled = false;
    const missing = offer.candidates.filter((c) => !c.has_text).map((c) => c.slug);
    if (!missing.length) return undefined;
    void readerAutoFetchAttempted(pid, missing).then((already) => {
      if (cancelled || epochRef.current !== epoch || !aliveRef.current) return;
      for (const target of missing) {
        if (autoFetchBudgetRef.current <= 0) break;
        if (already.has(target) || attemptedRef.current.has(target)) continue;
        attemptedRef.current.add(target);
        markReaderAutoFetchAttempted(pid, target);
        autoFetchBudgetRef.current -= 1;
        autoQueueRef.current = autoQueueRef.current
          .then(() => {
            // Guard again at run time: the reader may have pressed Fetch on this row while it
            // waited its turn, and the conversation may have moved on entirely.
            if (!aliveRef.current || epochRef.current !== epoch) return undefined;
            if (fetchingRef.current.has(target)) return undefined;
            return fetchCandidate(target);
          })
          .catch(() => undefined);
      }
    });
    return () => { cancelled = true; };
  }, [offer, fetchCandidate, pid]);

  return {
    offer,
    offerOpen,
    openOffer,
    closeOffer,
    job: enabled && job && (job.status === 'running' || job.assistant_index === latestIndex) ? job : null,
    selected,
    maxTargets,
    toggle,
    start,
    dismissJob,
    cancel,
    fetching,
    fetchCandidate,
    starting,
    error,
  };
}
