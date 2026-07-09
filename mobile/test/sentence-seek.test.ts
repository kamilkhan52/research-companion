import TrackPlayer from 'react-native-track-player';

import { seekSentence, splitSentences } from '../sentence-seek';

test('shared parser keeps dotted abbreviations inside a sentence', () => {
  expect(splitSentences('The O.P.T. model improves. Next result.').map((item) => item.text))
    .toEqual(['The O.P.T. model improves.', 'Next result.']);
});

test('sentence seek uses the next proportional boundary when metadata exists', async () => {
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({
    sentenceText: 'First sentence. Second sentence. Third sentence.',
  } as never);
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
    position: 2,
    duration: 30,
    buffered: 30,
  });

  await expect(seekSentence(TrackPlayer, 1)).resolves.toBe('sentence');
  expect(TrackPlayer.seekTo).toHaveBeenCalledWith(expect.any(Number));
  expect(TrackPlayer.seekBy).not.toHaveBeenCalled();
});

test('previous sentence steps fully to the sentence before the current one, not restarting it', async () => {
  const text = 'First sentence. Second sentence. Third sentence.';
  const duration = 30;
  const sentences = splitSentences(text);
  const firstStart = sentences[0].startFrac * duration;
  const secondStart = sentences[1].startFrac * duration;

  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({ sentenceText: text } as never);
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
    position: secondStart + 2, // well into the second sentence, not near its start
    duration,
    buffered: duration,
  });

  await expect(seekSentence(TrackPlayer, -1)).resolves.toBe('sentence');
  expect(TrackPlayer.seekTo).toHaveBeenCalledWith(firstStart);
});

test('previous sentence falls through to the previous track once already at the first sentence', async () => {
  const text = 'First sentence. Second sentence. Third sentence.';

  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({ sentenceText: text } as never);
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
    position: 1, // still inside the first sentence
    duration: 30,
    buffered: 30,
  });

  await expect(seekSentence(TrackPlayer, -1)).resolves.toBe('track');
  expect(TrackPlayer.skipToPrevious).toHaveBeenCalled();
  expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
});

test('sentence seek falls back to seconds without sentence metadata', async () => {
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({ id: 'legacy' } as never);
  jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
    position: 20,
    duration: 60,
    buffered: 60,
  });

  await expect(seekSentence(TrackPlayer, -1, 15)).resolves.toBe('fallback');
  expect(TrackPlayer.seekBy).toHaveBeenCalledWith(-15);
});
