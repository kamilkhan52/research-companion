import type { Track } from 'react-native-track-player';

export interface PersistedPlaybackTrack extends Track {
  id: string;
  slotId: string;
  sourceUrl?: string;
}

export interface PlaybackSnapshot {
  version: 1;
  slotId: string;
  title: string;
  position: number;
  duration: number;
  tracks: PersistedPlaybackTrack[];
}

export const PLAYBACK_SNAPSHOT_KEY: string;
export function clearPlaybackSnapshot(): Promise<void>;
export function readPlaybackSnapshot(): Promise<PlaybackSnapshot | null>;
export function savePlaybackProgress(
  player: typeof import('react-native-track-player').default,
  event: { track: number; position: number; duration: number },
): Promise<void>;
