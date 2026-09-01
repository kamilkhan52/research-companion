// DR-115 — device-local preferences for the reading surface itself.
//
// The chat navigation rail is off by default: it is a permanent overlay on a page of prose,
// and a reader who never wanted it should not have to dismiss it. Kamil asked for it as "an
// option in settings", so this is the store behind that toggle.
//
// Unlike GraphSettingsProvider there is no ready-gate. Nothing here changes what the app
// looks like before first paint (the rail is chrome over an already-scrolling transcript), so
// blocking the whole tree on one more AsyncStorage read would buy nothing; the preference
// simply arrives a frame later than the screen.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const CHAT_NAV_RAIL_KEY = 'rc.chat.navRail';

interface ReadingSettingsContextValue {
  /** Whether the discussion transcript shows the landmark navigation rail. */
  chatNavRail: boolean;
  setChatNavRail: (enabled: boolean) => void;
}

const ReadingSettingsContext = createContext<ReadingSettingsContextValue | undefined>(undefined);

export function ReadingSettingsProvider({ children }: { children: ReactNode }) {
  const [chatNavRail, setChatNavRailState] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(CHAT_NAV_RAIL_KEY)
      .then((value) => setChatNavRailState(value === 'true'))
      .catch(() => undefined);
  }, []);

  const value = useMemo<ReadingSettingsContextValue>(
    () => ({
      chatNavRail,
      setChatNavRail: (enabled) => {
        setChatNavRailState(enabled);
        void AsyncStorage.setItem(CHAT_NAV_RAIL_KEY, String(enabled));
      },
    }),
    [chatNavRail],
  );

  return <ReadingSettingsContext.Provider value={value}>{children}</ReadingSettingsContext.Provider>;
}

export function useReadingSettings(): ReadingSettingsContextValue {
  const value = useContext(ReadingSettingsContext);
  if (!value) throw new Error('useReadingSettings must be used within ReadingSettingsProvider');
  return value;
}
