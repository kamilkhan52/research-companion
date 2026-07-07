// One-time TrackPlayer setup. Capabilities cover the lock-screen / notification controls we
// want for listening on a walk: play/pause, 15s skips, scrub, and stop.

import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
} from 'react-native-track-player';

export const SKIP_SECONDS = 15;

let setupPromise: Promise<void> | null = null;

/** Idempotent: safe to call from multiple mounts; the player is a singleton. */
export function setupPlayer(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
    } catch (e) {
      // "player already initialized" -> fine; anything else, reset the promise so we can retry.
      const msg = String((e as Error)?.message ?? e);
      if (!/already been initialized|already initialized/i.test(msg)) {
        setupPromise = null;
        throw e;
      }
    }
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
        Capability.JumpForward,
        Capability.JumpBackward,
        Capability.SkipToPrevious,
        Capability.SkipToNext,
      ],
      compactCapabilities: [Capability.Play, Capability.Pause, Capability.JumpForward],
      forwardJumpInterval: SKIP_SECONDS,
      backwardJumpInterval: SKIP_SECONDS,
      progressUpdateEventInterval: 1,
    });
  })();
  return setupPromise;
}
