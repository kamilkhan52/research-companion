import { createContext, createElement, useState, useEffect, useCallback, useContext, type ReactNode } from 'react';
import { listProjects, getProjectState } from '@/api/endpoints';
import type { Project, ProjectState } from '@/api/types';

const ACTIVE_PID_KEY = 'rc_active_project';

export function useActivePid(): [string | null, (pid: string) => void] {
  const shared = useContext(LibraryContext);
  const [pid, setPid] = useState<string | null>(() => localStorage.getItem(ACTIVE_PID_KEY));

  const set = useCallback((newPid: string) => {
    localStorage.setItem(ACTIVE_PID_KEY, newPid);
    setPid(newPid);
  }, []);

  return shared ? [shared.activePid, shared.setActivePid] : [pid, set];
}

export interface UseLibraryState {
  projects: Project[];
  activePid: string | null;
  setActivePid: (pid: string) => void;
  state: ProjectState | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const LibraryContext = createContext<UseLibraryState | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const value = useLibraryState();
  return createElement(LibraryContext.Provider, { value }, children);
}

export function usePaperIndex(): { title: string; slug: string }[] {
  return useContext(LibraryContext)?.state?.papers.map(({ title, slug }) => ({ title, slug })) ?? [];
}

export function useProjectDefaults() {
  const state = useContext(LibraryContext)?.state;
  return { model: state?.model ?? '', narrationModel: state?.narration_model ?? '' };
}

export function useLibrary(): UseLibraryState {
  const shared = useContext(LibraryContext);
  if (!shared) throw new Error('useLibrary must be used inside LibraryProvider');
  return shared;
}

function useLibraryState(): UseLibraryState {
  const [activePid, persistActivePid] = useActivePid();
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const setActivePid = useCallback((pid: string) => {
    setState(null);
    setLoading(true);
    persistActivePid(pid);
  }, [persistActivePid]);

  // Fetch projects
  useEffect(() => {
    let cancelled = false;
    setError(null);
    listProjects()
      .then((r) => {
        if (!cancelled) {
          setProjects(r.projects);
          // Auto-select first if none selected or selected no longer exists
          if (r.projects.length > 0 && (!activePid || !r.projects.some((p) => p.id === activePid))) {
            setActivePid(r.projects[0].id);
          } else if (r.projects.length === 0) {
            setLoading(false);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [tick]);

  // Fetch project state when activePid changes
  useEffect(() => {
    if (!activePid) { setState(null); return; }
    let cancelled = false;
    setLoading(true);
    setState(null);
    setError(null);
    getProjectState(activePid)
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePid, tick]);

  return { projects, activePid, setActivePid, state, loading, error, refetch };
}
