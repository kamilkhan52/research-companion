import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const LISTENING_KEY = 'rc.listeningMode';

interface ListeningContextValue {
  listeningMode: boolean;
  setListeningMode: (enabled: boolean) => void;
  ready: boolean;
}

const ListeningContext = createContext<ListeningContextValue | undefined>(undefined);

export function ListeningProvider({ children }: { children: ReactNode }) {
  const [listeningMode, setListeningModeState] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(LISTENING_KEY)
      .then((value) => setListeningModeState(value === 'true'))
      .finally(() => setReady(true));
  }, []);

  const value = useMemo<ListeningContextValue>(() => ({
    listeningMode,
    ready,
    setListeningMode: (enabled) => {
      setListeningModeState(enabled);
      AsyncStorage.setItem(LISTENING_KEY, String(enabled));
    },
  }), [listeningMode, ready]);

  if (!ready) return null;
  return <ListeningContext.Provider value={value}>{children}</ListeningContext.Provider>;
}

export function useListeningMode(): ListeningContextValue {
  const value = useContext(ListeningContext);
  if (!value) throw new Error('useListeningMode must be used within ListeningProvider');
  return value;
}
