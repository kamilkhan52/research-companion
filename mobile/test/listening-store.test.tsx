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

function FollowProbe() {
  const { followNarrationInDiscussion, setFollowNarrationInDiscussion } = useListeningMode();
  return (
    <>
      <Text>{followNarrationInDiscussion ? 'following' : 'not following'}</Text>
      <Pressable
        accessibilityLabel="Toggle Discussion following"
        onPress={() => setFollowNarrationInDiscussion(!followNarrationInDiscussion)}
      />
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

test('Discussion narration following is default-on when no preference exists', async () => {
  await renderAsync(<ListeningProvider><FollowProbe /></ListeningProvider>);
  await waitFor(() => expect(screen.getByText('following')).toBeTruthy());
});

test('restores an explicit off preference and persists a later toggle', async () => {
  await AsyncStorage.setItem('rc.narration.followDiscussion', 'false');
  await renderAsync(<ListeningProvider><FollowProbe /></ListeningProvider>);
  await waitFor(() => expect(screen.getByText('not following')).toBeTruthy());

  await fireEventAsync.press(screen.getByLabelText('Toggle Discussion following'));
  expect(screen.getByText('following')).toBeTruthy();
  await waitFor(() => (
    expect(AsyncStorage.getItem('rc.narration.followDiscussion')).resolves.toBe('true')
  ));
});
