import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, waitFor } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { Text } from 'react-native';

import LibraryScreen from '@/app/index';
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
