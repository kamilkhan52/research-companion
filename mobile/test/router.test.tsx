import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, waitFor } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { Text } from 'react-native';

import LibraryScreen from '@/app/(tabs)/index';
import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { ProjectProvider } from '@/store/project';

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
});

function TestLayout() {
  return (
    <QueryClientProvider client={client}>
      <ProjectProvider>
        <Slot />
      </ProjectProvider>
    </QueryClientProvider>
  );
}

test('renders an in-memory app route and navigates from the existing Library screen', async () => {
  const rendered = renderRouter(
    {
      _layout: TestLayout,
      index: LibraryScreen,
      settings: () => <Text>Settings route</Text>,
    },
    { initialUrl: '/' },
  );

  await waitFor(() => expect(screen.getByText('Connect to your server')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Open Settings'));

  await waitFor(() => expect(rendered.getPathname()).toBe('/settings'));
  expect(screen.getByText('Settings route')).toBeTruthy();
});

test('continues the latest unfinished session across projects', async () => {
  await setBaseUrl('api.test');
  jest.mocked(api.listProjects).mockResolvedValueOnce({
    projects: [
      { id: 'current', name: 'Current', created_at: null, paper_count: 0, read_count: 0 },
      { id: 'three-d-dram', name: '3D DRAM', created_at: null, paper_count: 1, read_count: 0 },
    ],
  });
  jest.mocked(api.getProjectState).mockResolvedValueOnce({
    project: { id: 'current', name: 'Current' },
    has_key: true,
    model: null,
    narration_model: null,
    preview_model: null,
    speech_provider: null,
    has_openai_key: false,
    papers: [],
  });
  jest.mocked(api.getRecentSessions).mockResolvedValueOnce({
    sessions: [{
      project_id: 'three-d-dram',
      project_name: '3D DRAM',
      slug: 'memory-paper',
      title: 'Memory Paper',
      kind: 'paper',
      state: 'in_discussion',
      started_at: '2026-07-05T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
    }],
  });

  const rendered = renderRouter(
    {
      _layout: TestLayout,
      index: LibraryScreen,
      'paper/[slug]': () => <Text>Paper route</Text>,
    },
    { initialUrl: '/' },
  );

  await waitFor(() => expect(screen.getByText('Memory Paper')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Memory Paper'));

  await waitFor(() => expect(rendered.getPathname()).toBe('/paper/memory-paper'));
  await waitFor(() => expect(AsyncStorage.getItem('rc.activeProject')).resolves.toBe('three-d-dram'));
});
