// Custom JS entry: register the TrackPlayer playback service before the app boots, then hand
// off to expo-router. Order matters, so use require() (not hoisted imports). package.json
// "main" points here.

const TrackPlayer = require('react-native-track-player').default;

TrackPlayer.registerPlaybackService(() => require('./service'));

require('expo-router/entry');
