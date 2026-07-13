// TrackPlayer playback service: wires remote controls (lock screen, notification, headset) to
// the player. Registered at the JS entry (index.js). Must stay plain JS / CommonJS.

const TrackPlayer = require('react-native-track-player').default;
const { Event } = require('react-native-track-player');
const { seekSentence } = require('./sentence-seek');
const {
  checkpointPlayback,
  clearPlaybackSnapshot,
  savePlaybackProgress,
} = require('./playback-persistence');

const SKIP_SECONDS = 15;
const PROGRESS_SAVE_INTERVAL_MS = 5000;
let lastProgressSavedAt = 0;

module.exports = async function () {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, async () => {
    await TrackPlayer.pause();
    await checkpointPlayback(TrackPlayer).catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemoteStop, async () => {
    await clearPlaybackSnapshot().catch(() => {});
    await TrackPlayer.stop();
  });
  TrackPlayer.addEventListener(Event.RemoteJumpForward, async (e) => {
    await TrackPlayer.seekBy(e?.interval ?? SKIP_SECONDS);
  });
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (e) => {
    await TrackPlayer.seekBy(-(e?.interval ?? SKIP_SECONDS));
  });
  TrackPlayer.addEventListener(Event.RemoteSeek, (e) => TrackPlayer.seekTo(e.position));
  TrackPlayer.addEventListener(Event.RemotePrevious, () => seekSentence(TrackPlayer, -1));
  TrackPlayer.addEventListener(Event.RemoteNext, () => seekSentence(TrackPlayer, 1));
  // This event is emitted by the native playback service while the React tree is backgrounded,
  // so relaunch restoration does not depend on a mounted screen or foreground timer.
  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, (event) => {
    const now = Date.now();
    if (now - lastProgressSavedAt < PROGRESS_SAVE_INTERVAL_MS) return;
    lastProgressSavedAt = now;
    void savePlaybackProgress(TrackPlayer, event).catch(() => {});
  });
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
    void clearPlaybackSnapshot().catch(() => {});
  });
};
