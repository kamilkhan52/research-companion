import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import { ProjectProvider, useActiveProject } from '@/store/project';

function ProjectProbe() {
  const { activePid, ready, setActivePid } = useActiveProject();
  return (
    <>
      <Text>{ready ? activePid ?? 'none' : 'loading'}</Text>
      <Pressable accessibilityLabel="Select project" onPress={() => setActivePid('project-b')} />
      <Pressable accessibilityLabel="Clear project" onPress={() => setActivePid(null)} />
    </>
  );
}

test('loads, persists, and clears the active project', async () => {
  await AsyncStorage.setItem('rc.activeProject', 'project-a');
  await renderAsync(
    <ProjectProvider>
      <ProjectProbe />
    </ProjectProvider>,
  );

  await waitFor(() => expect(screen.getByText('project-a')).toBeTruthy());

  await fireEventAsync.press(screen.getByLabelText('Select project'));
  expect(screen.getByText('project-b')).toBeTruthy();
  await waitFor(() => expect(AsyncStorage.getItem('rc.activeProject')).resolves.toBe('project-b'));

  await fireEventAsync.press(screen.getByLabelText('Clear project'));
  expect(screen.getByText('none')).toBeTruthy();
  await waitFor(() => expect(AsyncStorage.getItem('rc.activeProject')).resolves.toBeNull());
});
