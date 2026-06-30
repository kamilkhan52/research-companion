const fs = require('fs');
const path = require('path');

// Compatibility patch for react-native-track-player 4.1.x with React Native 0.85 / Expo SDK 56.
// RN's Arguments.fromBundle now expects a non-null Bundle, while RNTP's originalItem is Bundle?.
// This keeps the native Android build working until RNTP publishes an upstream fix.
const file = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-track-player',
  'android',
  'src',
  'main',
  'java',
  'com',
  'doublesymmetry',
  'trackplayer',
  'module',
  'MusicModule.kt'
);

if (!fs.existsSync(file)) {
  console.warn('[patch-rntp] MusicModule.kt not found; skipping');
  process.exit(0);
}

let source = fs.readFileSync(file, 'utf8');
const before = source;

source = source.replace(
  'callback.resolve(Arguments.fromBundle(musicService.tracks[index].originalItem))',
  'callback.resolve(musicService.tracks[index].originalItem?.let { Arguments.fromBundle(it) })'
);

source = source.replace(
  `else Arguments.fromBundle(\n                musicService.tracks[musicService.getCurrentTrackIndex()].originalItem\n            )`,
  'else musicService.tracks[musicService.getCurrentTrackIndex()].originalItem?.let { Arguments.fromBundle(it) }'
);

if (source !== before) {
  fs.writeFileSync(file, source);
  console.log('[patch-rntp] Applied React Native 0.85 nullable Bundle compatibility patch');
} else if (source.includes('originalItem?.let { Arguments.fromBundle(it) }')) {
  console.log('[patch-rntp] Patch already applied');
} else {
  console.warn('[patch-rntp] Expected source patterns not found; patch may need updating');
}
