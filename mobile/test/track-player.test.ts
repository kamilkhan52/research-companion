import TrackPlayer, { Capability } from 'react-native-track-player';

import { setupPlayer } from '@/audio/setup';

test('the TrackPlayer mock exercises setup without native services', async () => {
  await setupPlayer();
  await setupPlayer();

  expect(TrackPlayer.setupPlayer).toHaveBeenCalledTimes(1);
  expect(TrackPlayer.updateOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      capabilities: expect.arrayContaining([Capability.Play, Capability.Pause]),
      progressUpdateEventInterval: 1,
    }),
  );
});
