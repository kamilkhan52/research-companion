// Audio controller: turns an assistant message into spoken audio and plays it through
// TrackPlayer (background + lock screen). The two-stage backend pipeline is narrate (adapt
// canonical text into a listening transcript) -> speak (synthesize mp3), both cached server-
// side, so re-listening is instant. Shared loading/current state lets messages + the mini
// player reflect what's playing.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import TrackPlayer from 'react-native-track-player';

import { apiUrl, authHeaders } from '@/api/client';
import * as api from '@/api/endpoints';
import { setupPlayer } from '@/audio/setup';

interface PlayRequest {
  id: string; // stable key for the message (e.g. `${slug}:${index}`)
  title: string;
  text: string; // canonical assistant text
}

interface AudioContextValue {
  playText: (req: PlayRequest) => Promise<void>;
  /** id currently being prepared (narrate+speak in flight), or null. */
  loadingId: string | null;
  /** id of the track currently loaded in the player, or null. */
  currentId: string | null;
}

const AudioContext = createContext<AudioContextValue | undefined>(undefined);

export function AudioProvider({ children }: { children: ReactNode }) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    setupPlayer().catch(() => {});
  }, []);

  const playText = useCallback(async ({ id, title, text }: PlayRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoadingId(id);
    try {
      await setupPlayer();
      const { narration } = await api.narrate(text);
      const { url } = await api.speak(narration);
      await TrackPlayer.reset();
      await TrackPlayer.add({
        id,
        url: apiUrl(url),
        title,
        artist: 'Reading Companion',
        headers: authHeaders(),
      });
      setCurrentId(id);
      await TrackPlayer.play();
    } catch (e) {
      Alert.alert('Audio unavailable', (e as Error).message ?? 'Could not synthesize audio.');
    } finally {
      setLoadingId(null);
      inFlight.current = false;
    }
  }, []);

  return (
    <AudioContext.Provider value={{ playText, loadingId, currentId }}>{children}</AudioContext.Provider>
  );
}

export function useAudio(): AudioContextValue {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used within AudioProvider');
  return ctx;
}
