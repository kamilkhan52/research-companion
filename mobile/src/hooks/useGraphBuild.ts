// Drives a reference-graph (re)build. The build itself runs server-side as a background job
// (see app/graph_jobs.py) that is NOT tied to this connection — so this hook's job is just to
// (a) kick it off and (b) poll its status for live progress. Polling (rather than holding an
// SSE stream open) is what makes this robust to the app being backgrounded, the network
// blipping, or the screen unmounting/remounting: each poll is an independent short request,
// and the build keeps running regardless. resume() lets a freshly-opened screen re-attach to a
// build that's already in flight.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getServerGeneration } from '@/api/config';
import { getGraph, getGraphBuildStatus, startGraphBuild } from '@/api/endpoints';
import { keys } from '@/api/queries';
import { showToast } from '@/ui/Toast';
import type {
  GraphBuildJob,
  GraphResponse,
  GraphRetrievalCandidate,
  ReferenceGraph,
} from '@/api/types';
import { presentSpendJobRefusal, presentSpendRefusal } from '@/components/SpendRefusalSheet';

const POLL_INTERVAL_MS = 1500;

export type PaperBuildStatus =
  | 'pending'
  | 'metadata'
  | 'metadata_cached'
  | 'retrieving'
  | 'retrieval_cached'
  | 'needs_confirmation'
  | 'extracting'
  | 'cached'
  | 'done'
  | 'not_found'
  | 'error';

export interface GraphBuildProgress {
  phase: GraphBuildJob['phase'];
  graphStage: ReferenceGraph['stage'] | null;
  total: number;
  ready: number;
  done: number;
  currentTitle: string | null;
  perPaper: Record<string, PaperBuildStatus>;
  retrievalCandidates: Record<string, GraphRetrievalCandidate[]>;
}

export interface GraphBuildState {
  building: boolean;
  progress: GraphBuildProgress | null;
  error: string | null;
  run: (force?: boolean, retrievalSources?: Record<string, string>) => Promise<void>;
  /** Re-attach to an already-running build (e.g. the screen just loaded a GraphResponse whose
   *  `build` is still running). No-op if the job isn't running. */
  resume: (job: GraphBuildJob | null | undefined) => void;
  clearError: () => void;
}

function toProgress(job: GraphBuildJob): GraphBuildProgress {
  const perPaper: Record<string, PaperBuildStatus> = {};
  for (const [slug, s] of Object.entries(job.per_paper)) perPaper[slug] = s.status;
  return {
    phase: job.phase,
    graphStage: job.graph_stage ?? job.graph?.stage ?? null,
    total: job.total,
    ready: job.ready,
    done: job.done,
    currentTitle: job.current_title,
    perPaper,
    retrievalCandidates: job.retrieval_candidates,
  };
}

export function useGraphBuild(pid: string | null): GraphBuildState {
  const qc = useQueryClient();
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<GraphBuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards a start against a fast double-tap in the same tick (before `building` re-renders).
  const startingRef = useRef(false);
  // This hook remains mounted while the active project changes. A pending start from project A
  // must never block the first tap in project B or apply A's late response to B's UI.
  const startGenerationRef = useRef(0);
  const runRef = useRef<GraphBuildState['run']>(async () => {});
  const loadedSnapshotRef = useRef<string | null>(null);

  useEffect(() => {
    startGenerationRef.current += 1;
    startingRef.current = false;
    loadedSnapshotRef.current = null;
    setBuilding(false);
    setProgress(null);
    setError(null);
  }, [pid]);

  // Apply a job snapshot from the server: update progress, and when the job has finished, tear
  // down polling (by flipping `building` off) and push the final graph into the query cache so
  // the screen reflects it without an extra round-trip.
  const applyJob = useCallback(
    (job: GraphBuildJob | null | undefined) => {
      if (!job) {
        setBuilding(false);
        return;
      }
      setProgress(toProgress(job));
      const snapshotRevision = job.graph_revision;
      if (
        pid
        && job.graph_stage === 'skeleton'
        && snapshotRevision
        && loadedSnapshotRef.current !== snapshotRevision
      ) {
        loadedSnapshotRef.current = snapshotRevision;
        // This write bypasses TanStack Query, so `queryClient.clear()` on a server switch cannot
        // cancel it. Without the generation check a response from server A, resolving after the
        // switch, would reinstate A's graph as fresh data under a project id that also exists on B.
        const requestedOnGeneration = getServerGeneration();
        void getGraph(pid)
          .then((response) => {
            // A final job snapshot can arrive while this one-off skeleton fetch is in flight.
            // Never let the slower, older response overwrite the enriched graph.
            if (
              getServerGeneration() === requestedOnGeneration
              && loadedSnapshotRef.current === snapshotRevision
              && response.graph?.revision === snapshotRevision
              && response.graph.stage === 'skeleton'
            ) {
              qc.setQueryData(keys.graph(pid), response);
            }
          })
          .catch(() => {
            if (loadedSnapshotRef.current === snapshotRevision) {
              loadedSnapshotRef.current = null;
            }
          });
      }
      if (job.graph && pid) {
        loadedSnapshotRef.current = job.graph.revision;
        qc.setQueryData<GraphResponse>(keys.graph(pid), (old) => ({
          graph: job.graph,
          recommendations: job.recommendations ?? [],
          status: old?.status ? {
            ...old.status,
            has_graph: true,
            built_at: job.graph!.built_at,
            model: job.graph!.model,
            graph_revision: job.graph!.revision,
            graph_stage: job.graph!.stage,
            graph_completeness: job.graph!.completeness,
            graph_needs_enrichment: job.graph!.stage === 'skeleton',
          } : {
            has_graph: true,
            built_at: job.graph!.built_at,
            model: job.graph!.model,
            graph_revision: job.graph!.revision,
            graph_stage: job.graph!.stage,
            graph_completeness: job.graph!.completeness,
            graph_needs_enrichment: job.graph!.stage === 'skeleton',
            total_papers: job.graph!.completeness.total_papers,
            retrievable_papers: job.graph!.completeness.ready_papers,
            stale_papers: [],
            removed_papers: [],
            missing_text_papers: [],
            semantic_scholar_enabled: false,
            semantic_scholar_papers: job.graph!.completeness.metadata_papers,
            semantic_scholar_stale_papers: [],
            retrieval_candidates: {},
            retrieval_errors: {},
          },
          build: job,
        }));
      }
      if (job.status === 'running') {
        setBuilding(true);
        return;
      }
      // done | error
      setBuilding(false);
      if (job.status === 'error' && !presentSpendJobRefusal(job.refusal, { operation: 'other' })) {
        setError(job.error ?? 'Graph build failed.');
      }
      // R6.5 — a build takes minutes and finishes while the user is usually elsewhere in the
      // app (tab screens stay mounted, so this poll loop keeps running); a quiet toast is the
      // only completion signal off the Map tab. applyJob only ever sees a settled job once
      // (polling stops right here), so this can't double-fire.
      // DR-069: the count turns this into a real signal ("did my new papers make it in?"), not
      // just a "something happened" chime. Opus review caught that `completeness.total_papers`
      // (the reading-list paper count) is a different, smaller number than what the Map header
      // itself shows (`graph.nodes.length`, project papers PLUS external works) — a toast
      // disagreeing with the count directly above it would read as a second, contradictory
      // source of truth. Match the header's own number.
      if (job.status === 'done') {
        const n = job.graph?.nodes.length;
        showToast(n != null ? `Map updated · ${n} paper${n === 1 ? '' : 's'}` : 'Reference map ready');
      }
      if (pid) {
        qc.invalidateQueries({ queryKey: keys.graph(pid) });
        // A completed build refreshes authors/affiliations too (U.9) — an open Authors
        // screen would otherwise keep showing the pre-build board.
        qc.invalidateQueries({ queryKey: keys.graphAuthors(pid) });
      }
    },
    [pid, qc],
  );

  // Poll while a build is running. Effect-driven off `building`, so it starts when a build
  // begins (or is resumed) and tears down as soon as the job reports done/error or the screen
  // unmounts. Transient poll failures (a blip) are swallowed so polling keeps going.
  useEffect(() => {
    if (!building || !pid) return;
    let cancelled = false;
    const tick = async () => {
      // Captured BEFORE the request: a poll that merely RESOLVES after the start POST
      // settles may still have READ the server before the job was registered.
      const beganWhileStarting = startingRef.current;
      try {
        const { build } = await getGraphBuildStatus(pid);
        if (cancelled) return;
        // While the start POST is in flight (at request or response time), the server may
        // not know the new job yet — or may still report the PREVIOUS settled build.
        // Applying such a snapshot flipped `building` back off (the D17 first-tap
        // flash-revert) and could fire a spurious completion toast. A RUNNING snapshot is
        // always safe to apply: builds are deduped per project, so a running job during a
        // start can only be the one being started (or the one the POST will dedup onto).
        if ((beganWhileStarting || startingRef.current) && build?.status !== 'running') return;
        applyJob(build);
      } catch {
        // transient network error — keep polling; the next tick may succeed
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    tick(); // fire once immediately rather than waiting a full interval
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [building, pid, applyJob]);

  const run = useCallback(
    async (force = false, retrievalSources: Record<string, string> = {}) => {
      if (!pid || startingRef.current || building) return;
      const requestPid = pid;
      const generation = ++startGenerationRef.current;
      startingRef.current = true;
      setError(null);
      setBuilding(true); // optimistic: disables the button immediately; applyJob corrects it
      setProgress({
        phase: 'preparing', graphStage: null,
        total: 0, ready: 0, done: 0, currentTitle: null, perPaper: {},
        retrievalCandidates: {},
      });
      try {
        const { build } = await startGraphBuild(requestPid, force, retrievalSources);
        if (generation !== startGenerationRef.current) return;
        applyJob(build);
      } catch (e) {
        if (generation !== startGenerationRef.current) return;
        if (presentSpendRefusal(e, {
          operation: 'other',
          retry: () => runRef.current(force, retrievalSources),
        })) {
          setError(null);
          setBuilding(false);
          return;
        }
        // The POST response can be lost while the job started fine server-side (the tunnel
        // kills long requests). Reconcile with the registry before declaring failure, so a
        // real running build is never left untracked.
        try {
          const { build } = await getGraphBuildStatus(requestPid);
          if (generation !== startGenerationRef.current) return;
          if (build?.status === 'running') {
            applyJob(build);
            return;
          }
        } catch {
          // status unreachable too — fall through to the error
        }
        setError((e as Error).message ?? 'Graph build failed.');
        setBuilding(false);
        // If the job actually ran to completion before the lost POST settled, the refetch
        // still surfaces the new graph.
        qc.invalidateQueries({ queryKey: keys.graph(requestPid) });
      } finally {
        if (generation === startGenerationRef.current) startingRef.current = false;
      }
    },
    [pid, building, applyJob, qc],
  );
  runRef.current = run;

  const resume = useCallback(
    (job: GraphBuildJob | null | undefined) => {
      if (job?.status === 'running') applyJob(job);
    },
    [applyJob],
  );

  const clearError = useCallback(() => setError(null), []);

  return { building, progress, error, run, resume, clearError };
}
