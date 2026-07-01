// Drives a reference-graph (re)build: runs the SSE build endpoint, tracks per-paper progress
// (extracting / cached / done / error) so the UI can show real feedback during what may be a
// multi-minute operation across many papers, and updates the graph query cache in place when
// it finishes so the Graph screen reflects the new data immediately.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { graphBuildPath } from '@/api/endpoints';
import { keys } from '@/api/queries';
import { streamPost } from '@/api/stream';
import type { GraphBuildEvent, GraphResponse } from '@/api/types';

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
  cancel: () => void;
  clearError: () => void;
}

export function useGraphBuild(pid: string | null): GraphBuildState {
  const qc = useQueryClient();
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<GraphBuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // A ref guard (not the `building` state) so back-to-back calls in the same tick — e.g. a
  // fast double-tap on "Build graph" before React re-renders with the disabled button — can't
  // both slip past the check and start two concurrent builds racing to write the same
  // per-project graph-store file.
  const buildingRef = useRef(false);

  const run = useCallback(
    async (force = false) => {
      if (!pid || buildingRef.current) return;
      buildingRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setBuilding(true);
      setProgress({ total: 0, done: 0, currentTitle: null, perPaper: {} });

      try {
        await streamPost<GraphBuildEvent>(
          graphBuildPath(pid),
          { force },
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === 'start') {
                setProgress({ total: event.total, done: 0, currentTitle: null, perPaper: {} });
              } else if (event.type === 'extracting') {
                setProgress((p) =>
                  p && {
                    ...p,
                    currentTitle: event.title,
                    perPaper: { ...p.perPaper, [event.slug]: 'extracting' },
                  },
                );
              } else if (event.type === 'progress') {
                setProgress((p) =>
                  p && {
                    ...p,
                    done: event.done,
                    perPaper: {
                      ...p.perPaper,
                      [event.slug]: event.cached ? 'cached' : event.status,
                    },
                  },
                );
              } else if (event.type === 'error') {
                setError(event.detail);
              } else if (event.type === 'done') {
                qc.setQueryData<GraphResponse>(keys.graph(pid), (old) => ({
                  graph: event.graph,
                  recommendations: event.recommendations,
                  status: old?.status ?? {
                    has_graph: true,
                    built_at: event.graph.built_at,
                    model: event.graph.model,
                    total_papers: event.graph.nodes.filter((n) => n.kind === 'project').length,
                    retrievable_papers: 0,
                    stale_papers: [],
                    missing_text_papers: [],
                  },
                }));
                qc.invalidateQueries({ queryKey: keys.graph(pid) });
              }
            },
          },
        );
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') {
          setError((e as Error).message ?? 'Graph build failed.');
        }
      } finally {
        buildingRef.current = false;
        setBuilding(false);
        abortRef.current = null;
      }
    },
    [pid, qc],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const clearError = useCallback(() => setError(null), []);

  return { building, progress, error, run, cancel, clearError };
}
