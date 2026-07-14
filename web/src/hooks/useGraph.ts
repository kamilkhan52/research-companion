import { useState, useEffect, useCallback, useRef } from 'react';
import { getGraph, getGraphBuildStatus, buildGraph } from '@/api/endpoints';
import type { GraphResponse, GraphBuildJob, GraphRetrievalCandidate, ReferenceGraph, GraphRecommendation } from '@/api/graph-types';

interface UseGraphState {
  graph: ReferenceGraph | null;
  recommendations: GraphRecommendation[];
  build: GraphBuildJob | null;
  hasGraph: boolean;
  totalPapers: number;
  readyPapers: number;
  stalePapers: string[];
  retrievalCandidates: Record<string, GraphRetrievalCandidate[]>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  startBuild: (force?: boolean, retrievalSources?: Record<string, string>) => void;
}

export function useGraph(pid: string | null): UseGraphState {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!pid) { setData(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getGraph(pid)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [pid, tick]);

  // Poll build status
  useEffect(() => {
    if (!pid || !data?.build || data.build.status !== 'running') {
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
      return;
    }
    let cancelled = false;
    const poll = () => {
      pollRef.current = setTimeout(() => {
        getGraphBuildStatus(pid)
        .then((r) => {
          if (cancelled) return;
          setData((prev) => prev ? { ...prev, build: r.build } : null);
          if (r.build && r.build.status !== 'running') {
            pollRef.current = null;
            setTick((t) => t + 1); // refetch full graph
          } else {
            poll();
          }
        })
        .catch(() => { if (!cancelled) poll(); }); // polling failures are best-effort
      }, 2000);
    };
    poll();
    return () => {
      cancelled = true;
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    };
  }, [pid, data?.build?.status]);

  const startBuild = useCallback((force = false, retrievalSources: Record<string, string> = {}) => {
    if (!pid) return;
    buildGraph(pid, force, retrievalSources)
      .then((r) => setData((prev) => prev ? { ...prev, build: r.build } : null))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [pid]);

  return {
    graph: data?.graph ?? null,
    recommendations: data?.recommendations ?? [],
    build: data?.build ?? null,
    hasGraph: data?.status?.has_graph ?? false,
    totalPapers: data?.status?.total_papers ?? 0,
    readyPapers: data?.status?.retrievable_papers ?? 0,
    stalePapers: data?.status?.stale_papers ?? [],
    retrievalCandidates: data?.build?.retrieval_candidates
      ?? data?.status?.retrieval_candidates
      ?? {},
    loading,
    error,
    refetch,
    startBuild,
  };
}
