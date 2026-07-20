import TrackPlayer, {
  AndroidAudioContentType,
  AppKilledPlaybackBehavior,
  Capability,
  IOSCategory,
  IOSCategoryMode,
} from 'react-native-track-player';

import appConfig from '../app.json';
import { setupPlayer } from '@/audio/setup';

test('the TrackPlayer mock exercises setup without native services', async () => {
  await setupPlayer();
  await setupPlayer();

  expect(TrackPlayer.setupPlayer).toHaveBeenCalledTimes(1);
  expect(TrackPlayer.setupPlayer).toHaveBeenCalledWith({
    androidAudioContentType: AndroidAudioContentType.Speech,
    autoHandleInterruptions: true,
    iosCategory: IOSCategory.Playback,
    iosCategoryMode: IOSCategoryMode.SpokenAudio,
  });
  expect(TrackPlayer.updateOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
      },
      capabilities: expect.arrayContaining([Capability.Play, Capability.Pause]),
      progressUpdateEventInterval: 1,
    }),
  );
  expect(appConfig.expo.ios.infoPlist.UIBackgroundModes).toContain('audio');
});
