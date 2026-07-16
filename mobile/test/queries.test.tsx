import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHookAsync, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import * as api from '@/api/endpoints';
import { getBaseUrl, setBaseUrl } from '@/api/config';
import { keys, useProjects, useRecentSessions, useSaveSettings } from '@/api/queries';
import type { Project, RecentSession } from '@/api/types';

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

test('useRecentSessions fetches cross-project activity', async () => {
  const sessions: RecentSession[] = [{
    project_id: 'three-d-dram',
    project_name: '3D DRAM',
    slug: 'memory-paper',
    title: 'Memory Paper',
    kind: 'paper',
    state: 'in_discussion',
    started_at: '2026-07-05T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  }];
  jest.mocked(api.getRecentSessions).mockResolvedValueOnce({ sessions });
  await setBaseUrl('api.test');

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(() => useRecentSessions(), { wrapper: Wrapper });
  await waitFor(() => expect(result.current.data).toEqual(sessions));

  await unmountAsync();
  client.clear();
});

test('saving settings invalidates cached opening drafts so a model change reaches reopened papers', async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.saveSettings).mockResolvedValue({} as never);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  // A previously-cached opening draft carrying the old default model.
  client.setQueryData(keys.opening('proj', 'awq'), { prompt: 'x', model: 'old/model', title: 'AWQ' });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  const { result, unmountAsync } = await renderHookAsync(() => useSaveSettings(), { wrapper: Wrapper });
  result.current.mutate({ model: 'new/model' });

  await waitFor(() =>
    expect(client.getQueryState(keys.opening('proj', 'awq'))?.isInvalidated).toBe(true));

  await unmountAsync();
  client.clear();
});
