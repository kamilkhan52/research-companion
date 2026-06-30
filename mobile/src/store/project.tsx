// Which project is currently active, shared app-wide and persisted across launches.
// Kept tiny (React context + AsyncStorage) to avoid a state-management dependency.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const ACTIVE_KEY = 'rc.activeProject';

interface ProjectContextValue {
  activePid: string | null;
  setActivePid: (pid: string | null) => void;
  ready: boolean; // true once the persisted value has loaded
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [activePid, setActivePidState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ACTIVE_KEY)
      .then((v) => setActivePidState(v))
      .finally(() => setReady(true));
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      activePid,
      ready,
      setActivePid: (pid) => {
        setActivePidState(pid);
        if (pid) AsyncStorage.setItem(ACTIVE_KEY, pid);
        else AsyncStorage.removeItem(ACTIVE_KEY);
      },
    }),
    [activePid, ready],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useActiveProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useActiveProject must be used within ProjectProvider');
  return ctx;
}
