// TrackPlayer playback service: wires remote controls (lock screen, notification, headset) to
// the player. Registered at the JS entry (index.js). Must stay plain JS / CommonJS.

const TrackPlayer = require('react-native-track-player').default;
const { Event } = require('react-native-track-player');

const SKIP_SECONDS = 15;

module.exports = async function () {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteJumpForward, async (e) => {
    await TrackPlayer.seekBy(e?.interval ?? SKIP_SECONDS);
  });
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (e) => {
    await TrackPlayer.seekBy(-(e?.interval ?? SKIP_SECONDS));
  });
  TrackPlayer.addEventListener(Event.RemoteSeek, (e) => TrackPlayer.seekTo(e.position));
};
