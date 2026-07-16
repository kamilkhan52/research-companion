// R6.6 — narration speed: persisted on device, restored on launch, junk values ignored.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, renderAsync, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import { ListeningProvider, PLAYBACK_RATES, useListeningMode } from '@/store/listening';

function RateProbe() {
  const { playbackRate, setPlaybackRate } = useListeningMode();
  return (
    <Pressable
      accessibilityLabel="cycle"
      onPress={() => {
        const i = PLAYBACK_RATES.indexOf(playbackRate);
        setPlaybackRate(PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]);
      }}
    >
      <Text>{`rate:${playbackRate}`}</Text>
    </Pressable>
  );
}

afterEach(() => AsyncStorage.clear());

test('restores a persisted rate', async () => {
  await AsyncStorage.setItem('rc.playbackRate', '1.5');
  await renderAsync(
    <ListeningProvider>
      <RateProbe />
    </ListeningProvider>,
  );

  expect(screen.getByText('rate:1.5')).toBeTruthy();
});

test('ignores junk persisted values and 2x wraps back to 1x', async () => {
  await AsyncStorage.setItem('rc.playbackRate', 'banana');
  await renderAsync(
    <ListeningProvider>
      <RateProbe />
    </ListeningProvider>,
  );

  expect(screen.getByText('rate:1')).toBeTruthy(); // junk ignored → default

  for (const expected of [1.25, 1.5, 1.75, 2, 1]) {
    await act(async () => {
      fireEvent.press(screen.getByLabelText('cycle'));
    });
    expect(screen.getByText(`rate:${expected}`)).toBeTruthy();
  }
  expect(await AsyncStorage.getItem('rc.playbackRate')).toBe('1');
});
