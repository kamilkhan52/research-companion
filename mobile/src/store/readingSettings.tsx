// DR-115 — device-local preferences for the reading surface itself.
//
// The chat navigation rail is off by default: it is a permanent overlay on a page of prose,
// and a reader who never wanted it should not have to dismiss it. Kamil asked for it as "an
// option in settings", so this is the store behind that toggle.
//
// Unlike GraphSettingsProvider there is no app-wide ready-gate. The existing Library title is
// the safe initial default, then an explicitly hidden device preference arrives asynchronously;
// blocking every screen on these small chrome preferences would cost more than that one update.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const CHAT_NAV_RAIL_KEY = 'rc.chat.navRail';
export const LIBRARY_TITLE_KEY = 'rc.reading.libraryTitle';

interface ReadingSettingsContextValue {
  /** Whether the discussion transcript shows the landmark navigation rail. */
  chatNavRail: boolean;
  setChatNavRail: (enabled: boolean) => void;
  /** Whether the Library shows its in-app title header. Dev-adjustable, device-local. */
  libraryTitle: boolean;
  setLibraryTitle: (enabled: boolean) => void;
}

const ReadingSettingsContext = createContext<ReadingSettingsContextValue | undefined>(undefined);

export function ReadingSettingsProvider({ children }: { children: ReactNode }) {
  const [chatNavRail, setChatNavRailState] = useState(false);
  const [libraryTitle, setLibraryTitleState] = useState(true);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(CHAT_NAV_RAIL_KEY),
      AsyncStorage.getItem(LIBRARY_TITLE_KEY),
    ])
      .then(([navRail, title]) => {
        setChatNavRailState(navRail === 'true');
        // Absence means ON. Only an explicit false hides the title, so upgrades preserve the
        // existing Library and a failed/cleared store cannot make navigation disappear.
        setLibraryTitleState(title !== 'false');
      })
      .catch(() => undefined);
  }, []);

  const value = useMemo<ReadingSettingsContextValue>(
    () => ({
      chatNavRail,
      setChatNavRail: (enabled) => {
        setChatNavRailState(enabled);
        void AsyncStorage.setItem(CHAT_NAV_RAIL_KEY, String(enabled));
      },
      libraryTitle,
      setLibraryTitle: (enabled) => {
        setLibraryTitleState(enabled);
        void AsyncStorage.setItem(LIBRARY_TITLE_KEY, String(enabled));
      },
    }),
    [chatNavRail, libraryTitle],
  );

  return <ReadingSettingsContext.Provider value={value}>{children}</ReadingSettingsContext.Provider>;
}

export function useReadingSettings(): ReadingSettingsContextValue {
  const value = useContext(ReadingSettingsContext);
  if (!value) throw new Error('useReadingSettings must be used within ReadingSettingsProvider');
  return value;
}
