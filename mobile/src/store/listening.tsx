import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const LISTENING_KEY = 'rc.listeningMode';
const PLAYBACK_KEY = 'rc.audioPlayback';
const RATE_KEY = 'rc.playbackRate';

/** Selectable narration speeds (R6.6). Applied via TrackPlayer.setRate and persisted. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/** How narration audio plays (polish plan I.1 — user-selectable while both are explored):
 *  - 'full': wait for the complete stitched track. Full duration visible while playing,
 *    survives lock/background state changes, rewind works across the whole response.
 *  - 'progressive': play synthesized segments as they land — audio starts sooner, but
 *    seeking is bounded by the current segment and background transitions can cut it off. */
export type AudioPlaybackMode = 'full' | 'progressive';

interface ListeningContextValue {
  listeningMode: boolean;
  setListeningMode: (enabled: boolean) => void;
  playbackMode: AudioPlaybackMode;
  setPlaybackMode: (mode: AudioPlaybackMode) => void;
  playbackRate: PlaybackRate;
  setPlaybackRate: (rate: PlaybackRate) => void;
  ready: boolean;
}

const ListeningContext = createContext<ListeningContextValue | undefined>(undefined);

export function ListeningProvider({ children }: { children: ReactNode }) {
  const [listeningMode, setListeningModeState] = useState(false);
  const [playbackMode, setPlaybackModeState] = useState<AudioPlaybackMode>('full');
  const [playbackRate, setPlaybackRateState] = useState<PlaybackRate>(1);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(LISTENING_KEY).then((value) => setListeningModeState(value === 'true')),
      AsyncStorage.getItem(PLAYBACK_KEY).then((value) => {
        if (value === 'progressive' || value === 'full') setPlaybackModeState(value);
      }),
      AsyncStorage.getItem(RATE_KEY).then((value) => {
        const rate = Number(value);
        if ((PLAYBACK_RATES as readonly number[]).includes(rate)) {
          setPlaybackRateState(rate as PlaybackRate);
        }
      }),
    ]).finally(() => setReady(true));
  }, []);

  const value = useMemo<ListeningContextValue>(() => ({
    listeningMode,
    playbackMode,
    playbackRate,
    ready,
    setListeningMode: (enabled) => {
      setListeningModeState(enabled);
      AsyncStorage.setItem(LISTENING_KEY, String(enabled));
    },
    setPlaybackMode: (mode) => {
      setPlaybackModeState(mode);
      AsyncStorage.setItem(PLAYBACK_KEY, mode);
    },
    setPlaybackRate: (rate) => {
      setPlaybackRateState(rate);
      AsyncStorage.setItem(RATE_KEY, String(rate));
    },
  }), [listeningMode, playbackMode, playbackRate, ready]);

  if (!ready) return null;
  return <ListeningContext.Provider value={value}>{children}</ListeningContext.Provider>;
}

export function useListeningMode(): ListeningContextValue {
  const value = useContext(ListeningContext);
  if (!value) throw new Error('useListeningMode must be used within ListeningProvider');
  return value;
}
