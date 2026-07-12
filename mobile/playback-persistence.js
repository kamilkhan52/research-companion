// Background-safe playback snapshot storage shared by the TrackPlayer service (plain
// CommonJS) and the React provider. Persist only replay metadata — never authorization headers.

const storageModule = require('@react-native-async-storage/async-storage');
const AsyncStorage = storageModule.default ?? storageModule;

const PLAYBACK_SNAPSHOT_KEY = 'rc.playbackSnapshot.v1';
const SNAPSHOT_VERSION = 1;
let persistenceTail = Promise.resolve();

function serialize(operation) {
  const task = persistenceTail.then(operation, operation);
  persistenceTail = task.catch(() => {});
  return task;
}

function restorableTrack(track) {
  const id = String(track?.id ?? '');
  const slotId = String(track?.slotId ?? id);
  return !!id && !!slotId && !id.startsWith('preview:')
    && (typeof track?.sourceUrl === 'string' || typeof track?.url === 'string');
}

function safeTrack(track) {
  return {
    id: String(track.id),
    slotId: String(track.slotId ?? track.id),
    url: typeof track.url === 'string' ? track.url : undefined,
    sourceUrl: typeof track.sourceUrl === 'string' ? track.sourceUrl : undefined,
    title: typeof track.title === 'string' ? track.title : undefined,
    artist: typeof track.artist === 'string' ? track.artist : undefined,
    narration: typeof track.narration === 'string' ? track.narration : undefined,
    sentenceText: typeof track.sentenceText === 'string' ? track.sentenceText : undefined,
    segmentIndex: Number.isInteger(track.segmentIndex) ? track.segmentIndex : undefined,
  };
}

function clearPlaybackSnapshot() {
  return serialize(() => AsyncStorage.removeItem(PLAYBACK_SNAPSHOT_KEY));
}

function savePlaybackProgress(player, event) {
  return serialize(async () => {
    const queue = await player.getQueue();
    const activeIndex = Number.isInteger(event?.track) ? event.track : -1;
    const active = queue[activeIndex];
    if (!restorableTrack(active)) return;

    // Preserve the active final track and all later final tracks. Preview cues are ephemeral and
    // must never replace or re-enter a restored narration queue.
    const tracks = queue.slice(activeIndex).filter(restorableTrack).map(safeTrack);
    if (!tracks.length) return;
    await AsyncStorage.setItem(PLAYBACK_SNAPSHOT_KEY, JSON.stringify({
      version: SNAPSHOT_VERSION,
      slotId: tracks[0].slotId,
      title: tracks[0].title ?? '',
      position: Math.max(0, Number(event.position) || 0),
      duration: Math.max(0, Number(event.duration) || 0),
      tracks,
    }));
  });
}

async function readPlaybackSnapshot() {
  await persistenceTail;
  try {
    const parsed = JSON.parse(await AsyncStorage.getItem(PLAYBACK_SNAPSHOT_KEY) ?? 'null');
    if (parsed?.version !== SNAPSHOT_VERSION || typeof parsed.slotId !== 'string'
        || !Array.isArray(parsed.tracks) || !parsed.tracks.length
        || !parsed.tracks.every(restorableTrack)) return null;
    return {
      ...parsed,
      position: Math.max(0, Number(parsed.position) || 0),
      duration: Math.max(0, Number(parsed.duration) || 0),
      tracks: parsed.tracks.map(safeTrack),
    };
  } catch {
    return null;
  }
}

module.exports = {
  PLAYBACK_SNAPSHOT_KEY,
  clearPlaybackSnapshot,
  readPlaybackSnapshot,
  savePlaybackProgress,
};
