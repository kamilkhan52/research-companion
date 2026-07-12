import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const ALLOW_ALL_FILTER_KEY = 'rc.graph.allowAllFilter';

interface GraphSettingsContextValue {
  /** Whether the Map screen's "All" filter chip is offered at all. Off by default: a project's
   *  full reference graph can run into the hundreds of external nodes, which is why the Map
   *  defaults to the "Significant" filter + paginated view instead. */
  allowAllFilter: boolean;
  setAllowAllFilter: (enabled: boolean) => void;
  ready: boolean;
}

const GraphSettingsContext = createContext<GraphSettingsContextValue | undefined>(undefined);

export function GraphSettingsProvider({ children }: { children: ReactNode }) {
  const [allowAllFilter, setAllowAllFilterState] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ALLOW_ALL_FILTER_KEY)
      .then((value) => setAllowAllFilterState(value === 'true'))
      .finally(() => setReady(true));
  }, []);

  const value = useMemo<GraphSettingsContextValue>(
    () => ({
      allowAllFilter,
      ready,
      setAllowAllFilter: (enabled) => {
        setAllowAllFilterState(enabled);
        AsyncStorage.setItem(ALLOW_ALL_FILTER_KEY, String(enabled));
      },
    }),
    [allowAllFilter, ready],
  );

  if (!ready) return null;
  return <GraphSettingsContext.Provider value={value}>{children}</GraphSettingsContext.Provider>;
}

export function useGraphSettings(): GraphSettingsContextValue {
  const value = useContext(GraphSettingsContext);
  if (!value) throw new Error('useGraphSettings must be used within GraphSettingsProvider');
  return value;
}
