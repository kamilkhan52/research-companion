import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHookAsync, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import * as api from '@/api/endpoints';
import { getBaseUrl, setBaseUrl } from '@/api/config';
import { useProjects } from '@/api/queries';
import type { Project } from '@/api/types';

test('useProjects fetches through the API module when a server is configured', async () => {
  const projects: Project[] = [
    {
      id: 'three-d-dram',
      name: '3D DRAM',
      created_at: '2026-07-05T00:00:00Z',
      paper_count: 4,
      read_count: 1,
    },
  ];
  jest.mocked(api.listProjects).mockResolvedValueOnce({ projects });
  await setBaseUrl('api.test');
  expect(getBaseUrl()).toBe('https://api.test');

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(() => useProjects(), {
    wrapper: Wrapper,
  });

  await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.data).toEqual(projects));

  await unmountAsync();
  client.clear();
});
