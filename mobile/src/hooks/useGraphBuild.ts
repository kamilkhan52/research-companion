// Drives a reference-graph (re)build. The build itself runs server-side as a background job
// (see app/graph_jobs.py) that is NOT tied to this connection — so this hook's job is just to
// (a) kick it off and (b) poll its status for live progress. Polling (rather than holding an
// SSE stream open) is what makes this robust to the app being backgrounded, the network
// blipping, or the screen unmounting/remounting: each poll is an independent short request,
// and the build keeps running regardless. resume() lets a freshly-opened screen re-attach to a
// build that's already in flight.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getGraphBuildStatus, startGraphBuild } from '@/api/endpoints';
import { keys } from '@/api/queries';
import type { GraphBuildJob, GraphResponse } from '@/api/types';

const POLL_INTERVAL_MS = 1500;

export type PaperBuildStatus = 'pending' | 'extracting' | 'cached' | 'done' | 'error';

export interface GraphBuildProgress {
  total: number;
  done: number;
  currentTitle: string | null;
  perPaper: Record<string, PaperBuildStatus>;
}

export interface GraphBuildState {
  building: boolean;
  progress: GraphBuildProgress | null;
  error: string | null;
  run: (force?: boolean) => Promise<void>;
  /** Re-attach to an already-running build (e.g. the screen just loaded a GraphResponse whose
   *  `build` is still running). No-op if the job isn't running. */
  resume: (job: GraphBuildJob | null | undefined) => void;
  clearError: () => void;
}

function toProgress(job: GraphBuildJob): GraphBuildProgress {
  const perPaper: Record<string, PaperBuildStatus> = {};
  for (const [slug, s] of Object.entries(job.per_paper)) perPaper[slug] = s.status;
  return { total: job.total, done: job.done, currentTitle: job.current_title, perPaper };
}

export function useGraphBuild(pid: string | null): GraphBuildState {
  const qc = useQueryClient();
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<GraphBuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards a start against a fast double-tap in the same tick (before `building` re-renders).
  const startingRef = useRef(false);

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
      if (job.status === 'running') {
        setBuilding(true);
        return;
      }
      // done | error
      setBuilding(false);
      if (job.status === 'error') setError(job.error ?? 'Graph build failed.');
      if (job.status === 'done' && job.graph && pid) {
        qc.setQueryData<GraphResponse>(keys.graph(pid), (old) => ({
          graph: job.graph,
          recommendations: job.recommendations ?? [],
          status: old?.status ?? {
            has_graph: true,
            built_at: job.graph!.built_at,
            model: job.graph!.model,
            total_papers: job.graph!.nodes.filter((n) => n.kind === 'project').length,
            retrievable_papers: 0,
            stale_papers: [],
            removed_papers: [],
            missing_text_papers: [],
          },
          build: job,
        }));
      }
      if (pid) qc.invalidateQueries({ queryKey: keys.graph(pid) });
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
      try {
        const { build } = await getGraphBuildStatus(pid);
        if (!cancelled) applyJob(build);
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
    async (force = false) => {
      if (!pid || startingRef.current || building) return;
      startingRef.current = true;
      setError(null);
      setBuilding(true); // optimistic: disables the button immediately; applyJob corrects it
      setProgress({ total: 0, done: 0, currentTitle: null, perPaper: {} });
      try {
        const { build } = await startGraphBuild(pid, force);
        applyJob(build);
      } catch (e) {
        setError((e as Error).message ?? 'Graph build failed.');
        setBuilding(false);
      } finally {
        startingRef.current = false;
      }
    },
    [pid, building, applyJob],
  );

  const resume = useCallback(
    (job: GraphBuildJob | null | undefined) => {
      if (job?.status === 'running') applyJob(job);
    },
    [applyJob],
  );

  const clearError = useCallback(() => setError(null), []);

  return { building, progress, error, run, resume, clearError };
}
