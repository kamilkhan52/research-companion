// Playback position that advances smoothly between the player's coarse progress polls.
// useProgress alone updates in discrete steps (and each value is already slightly stale when
// it arrives), which made the transcript highlight visibly lag and jump. This dead-reckons
// with the wall clock while playing, re-anchored by each real poll: extrapolation within
// normal poll error is kept (and kept MONOTONIC, so the highlight never stutters backwards);
// a big disagreement means the user sought/skipped, and we snap to the anchor.

import { useEffect, useRef, useState } from 'react';
import { useIsPlaying, useProgress } from 'react-native-track-player';

const TICK_MS = 100; // 10Hz — plenty for sentence-level following
const SNAP_S = 1.2; // anchor vs extrapolation disagreement that means a seek happened

export function useSmoothPosition(): { position: number; duration: number } {
  const { position: anchor, duration } = useProgress(500);
  const { playing } = useIsPlaying();
  const base = useRef({ pos: 0, at: Date.now() });
  const playingRef = useRef(playing);
  const [position, setPosition] = useState(0);

  // Play/pause transitions: bank the elapsed time when pausing, restart the clock on resume,
  // so paused wall-time is never counted as playback.
  useEffect(() => {
    const now = Date.now();
    if (playingRef.current && !playing) {
      base.current = { pos: base.current.pos + (now - base.current.at) / 1000, at: now };
    } else if (!playingRef.current && playing) {
      base.current = { pos: base.current.pos, at: now };
    }
    playingRef.current = playing;
  }, [playing]);

  // Re-anchor on every real progress poll.
  useEffect(() => {
    const now = Date.now();
    const extrapolated =
      base.current.pos + (playingRef.current ? (now - base.current.at) / 1000 : 0);
    const pos = Math.abs(anchor - extrapolated) < SNAP_S ? Math.max(anchor, extrapolated) : anchor;
    base.current = { pos, at: now };
    setPosition(pos);
  }, [anchor]);

  // The smooth clock between anchors.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setPosition(base.current.pos + (Date.now() - base.current.at) / 1000);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing]);

  return { position: duration > 0 ? Math.min(position, duration) : position, duration };
}
