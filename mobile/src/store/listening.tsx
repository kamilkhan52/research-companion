import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TextStyle } from 'react-native';

import { fonts } from '@/theme/tokens';

const LISTENING_KEY = 'rc.listeningMode';
const PLAYBACK_KEY = 'rc.audioPlayback';
const RATE_KEY = 'rc.playbackRate';
const NARRATION_FACE_KEY = 'rc.narration.face';
const NARRATION_SCALE_KEY = 'rc.narration.textScale';
const FOLLOW_DISCUSSION_KEY = 'rc.narration.followDiscussion';

// DR-135 — how the rolling transcript is SET, as opposed to how it plays. Device-local, like
// every other preference in this store: the right transcript size depends on the screen you
// are reading it on, so it belongs beside playback rate in AsyncStorage rather than in the
// account document (app/user_settings.py), whose keys follow the USER across devices and
// whose CHECK constraint would need a migration to carry a per-screen display choice.
//
// The old transcript was Manrope SemiBold 21/32 — the `title` variant's exact metrics, i.e. a
// section-heading size at a heading weight, applied to running prose, in the UI face, on the
// one screen in the app whose entire job is reading. Its own header, one row above it, is
// Newsreader. Hence "it generally just seems out of place… maybe the font too?". The default
// is now the reading face at a reading weight; both faces are offered because they are the two
// the app ships, and their base sizes are tuned to each other optically (Newsreader has the
// smaller x-height, so it carries the larger point size for the same apparent size).
export const NARRATION_FACES = {
  serif: {
    label: 'Serif',
    hint: 'Newsreader — the reading face',
    family: fonts.serif,
    fontSize: 19,
    lineHeight: 29,
  },
  sans: {
    label: 'Sans',
    hint: 'Manrope — the interface face',
    family: fonts.body,
    fontSize: 17,
    lineHeight: 27,
  },
} as const;

export type NarrationFace = keyof typeof NARRATION_FACES;
export const NARRATION_FACE_ORDER: NarrationFace[] = ['serif', 'sans'];
const DEFAULT_NARRATION_FACE: NarrationFace = 'serif';

export const MIN_NARRATION_SCALE = 0.8;
export const MAX_NARRATION_SCALE = 1.5;
export const NARRATION_SCALE_STEP = 0.1;
const DEFAULT_NARRATION_SCALE = 1;

function isNarrationFace(value: unknown): value is NarrationFace {
  return value === 'serif' || value === 'sans';
}

/** Same explicit 1-decimal rounding as ThemeProvider's clampTextScale, and for the same
 *  reason: `Math.round(n / 0.1) * 0.1` lands on 1.2000000000000002 for real inputs, which
 *  would be persisted verbatim and then fail every `=== 1.2` comparison downstream. */
export function clampNarrationScale(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_NARRATION_SCALE;
  const stepped = Math.round(Math.round(n / NARRATION_SCALE_STEP) * NARRATION_SCALE_STEP * 10) / 10;
  return Math.min(MAX_NARRATION_SCALE, Math.max(MIN_NARRATION_SCALE, stepped));
}

/** The resolved type for one transcript line. Sizes are rounded to a half-pixel so a scaled
 *  step never produces a fractional tail that Android rounds inconsistently between lines. */
export function narrationTextStyle(face: NarrationFace, scale: number): TextStyle {
  const base = NARRATION_FACES[face];
  return {
    fontFamily: base.family,
    fontSize: Math.round(base.fontSize * scale * 2) / 2,
    lineHeight: Math.round(base.lineHeight * scale),
  };
}

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
  /** DR-135 — typeface of the rolling transcript. */
  narrationFace: NarrationFace;
  setNarrationFace: (face: NarrationFace) => void;
  /** DR-135 — multiplier on the chosen face's base size. */
  narrationTextScale: number;
  setNarrationTextScale: (scale: number) => void;
  /** DR-133 — keep Discussion centered on the sentence represented by narration playback. */
  followNarrationInDiscussion: boolean;
  setFollowNarrationInDiscussion: (enabled: boolean) => void;
  ready: boolean;
}

const ListeningContext = createContext<ListeningContextValue | undefined>(undefined);

export function ListeningProvider({ children }: { children: ReactNode }) {
  const [listeningMode, setListeningModeState] = useState(false);
  const [playbackMode, setPlaybackModeState] = useState<AudioPlaybackMode>('full');
  const [playbackRate, setPlaybackRateState] = useState<PlaybackRate>(1);
  const [narrationFace, setNarrationFaceState] = useState<NarrationFace>(DEFAULT_NARRATION_FACE);
  const [narrationTextScale, setNarrationTextScaleState] = useState(DEFAULT_NARRATION_SCALE);
  // Default-on is intentional: only an explicit stored "false" disables following. A missing
  // or malformed value must not silently turn the feature off after an upgrade/storage reset.
  const [followNarrationInDiscussion, setFollowNarrationInDiscussionState] = useState(true);
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
      AsyncStorage.getItem(NARRATION_FACE_KEY).then((value) => {
        if (isNarrationFace(value)) setNarrationFaceState(value);
      }),
      AsyncStorage.getItem(NARRATION_SCALE_KEY).then((value) => {
        // A junk value must fall back to the default, not to the clamped minimum — hence the
        // isFinite gate here rather than leaning on clampNarrationScale alone.
        const parsed = value == null ? NaN : Number(value);
        if (Number.isFinite(parsed)) setNarrationTextScaleState(clampNarrationScale(parsed));
      }),
      AsyncStorage.getItem(FOLLOW_DISCUSSION_KEY).then((value) => {
        if (value === 'false') setFollowNarrationInDiscussionState(false);
        else if (value === 'true') setFollowNarrationInDiscussionState(true);
      }),
    ]).finally(() => setReady(true));
  }, []);

  const value = useMemo<ListeningContextValue>(() => ({
    listeningMode,
    playbackMode,
    playbackRate,
    narrationFace,
    narrationTextScale,
    followNarrationInDiscussion,
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
    setNarrationFace: (face) => {
      setNarrationFaceState(face);
      AsyncStorage.setItem(NARRATION_FACE_KEY, face);
    },
    setNarrationTextScale: (scale) => {
      const clamped = clampNarrationScale(scale);
      setNarrationTextScaleState(clamped);
      AsyncStorage.setItem(NARRATION_SCALE_KEY, String(clamped));
    },
    setFollowNarrationInDiscussion: (enabled) => {
      setFollowNarrationInDiscussionState(enabled);
      AsyncStorage.setItem(FOLLOW_DISCUSSION_KEY, String(enabled));
    },
  }), [
    followNarrationInDiscussion,
    listeningMode,
    narrationFace,
    narrationTextScale,
    playbackMode,
    playbackRate,
    ready,
  ]);

  if (!ready) return null;
  return <ListeningContext.Provider value={value}>{children}</ListeningContext.Provider>;
}

export function useListeningMode(): ListeningContextValue {
  const value = useContext(ListeningContext);
  if (!value) throw new Error('useListeningMode must be used within ListeningProvider');
  return value;
}
