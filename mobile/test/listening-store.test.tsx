import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import { ListeningProvider, useListeningMode } from '@/store/listening';

function Probe() {
  const { listeningMode, ready, setListeningMode } = useListeningMode();
  return (
    <>
      <Text>{ready ? (listeningMode ? 'listening' : 'reading') : 'loading'}</Text>
      <Pressable accessibilityLabel="Toggle listening" onPress={() => setListeningMode(!listeningMode)} />
    </>
  );
}

test('loads and persists the per-device listening mode', async () => {
  await AsyncStorage.setItem('rc.listeningMode', 'true');
  await renderAsync(<ListeningProvider><Probe /></ListeningProvider>);

  await waitFor(() => expect(screen.getByText('listening')).toBeTruthy());
  await fireEventAsync.press(screen.getByLabelText('Toggle listening'));
  expect(screen.getByText('reading')).toBeTruthy();
  await waitFor(() => expect(AsyncStorage.getItem('rc.listeningMode')).resolves.toBe('false'));
});
