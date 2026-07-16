export const State = {
  None: 'none',
  Ready: 'ready',
  Playing: 'playing',
  Paused: 'paused',
  Stopped: 'stopped',
  Ended: 'ended',
  Buffering: 'buffering',
  Loading: 'loading',
} as const;

export const Capability = {
  Play: 'play',
  Pause: 'pause',
  Stop: 'stop',
  SeekTo: 'seek-to',
  JumpForward: 'jump-forward',
  JumpBackward: 'jump-backward',
  SkipToPrevious: 'skip-to-previous',
  SkipToNext: 'skip-to-next',
} as const;

export const AppKilledPlaybackBehavior = {
  StopPlaybackAndRemoveNotification: 'stop-playback-and-remove-notification',
} as const;

export const Event = {
  RemotePlay: 'remote-play',
  RemotePause: 'remote-pause',
  RemoteStop: 'remote-stop',
  RemoteJumpForward: 'remote-jump-forward',
  RemoteJumpBackward: 'remote-jump-backward',
  RemoteSeek: 'remote-seek',
  RemotePrevious: 'remote-previous',
  RemoteNext: 'remote-next',
  PlaybackActiveTrackChanged: 'playback-active-track-changed',
  PlaybackProgressUpdated: 'playback-progress-updated',
  PlaybackQueueEnded: 'playback-queue-ended',
} as const;

export const trackPlayerMock = {
  setupPlayer: jest.fn(async () => undefined),
  updateOptions: jest.fn(async () => undefined),
  getPlaybackState: jest.fn(async () => ({ state: State.None })),
  getActiveTrack: jest.fn(async () => undefined),
  getActiveTrackIndex: jest.fn(async () => undefined),
  getQueue: jest.fn(async () => []),
  reset: jest.fn(async () => undefined),
  removeUpcomingTracks: jest.fn(async () => undefined),
  remove: jest.fn(async () => undefined),
  add: jest.fn(async () => undefined),
  play: jest.fn(async () => undefined),
  pause: jest.fn(async () => undefined),
  stop: jest.fn(async () => undefined),
  seekTo: jest.fn(async () => undefined),
  seekBy: jest.fn(async () => undefined),
  setRate: jest.fn(async () => undefined),
  getRate: jest.fn(async () => 1),
  skipToNext: jest.fn(async () => undefined),
  skipToPrevious: jest.fn(async () => undefined),
  getProgress: jest.fn(async () => ({ position: 0, duration: 0, buffered: 0 })),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  registerPlaybackService: jest.fn(),
};

export const useActiveTrack = jest.fn(() => undefined);
export const useIsPlaying = jest.fn(() => ({ playing: false, bufferingDuringPlay: false }));
export const usePlaybackState = jest.fn(() => ({ state: State.None }));
export const useProgress = jest.fn(() => ({ position: 0, duration: 0, buffered: 0 }));
export const useTrackPlayerEvents = jest.fn();

export default trackPlayerMock;
