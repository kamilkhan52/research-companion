// D08 — with several projects, the New Project form used to render below the list and end
// up hidden under the keyboard. Creating now replaces the list with a dedicated panel, so
// the input sits at the sheet's top regardless of project count.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { Project } from '@/api/types';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';

beforeEach(() => setBaseUrl('https://api.test'));

const projects: Project[] = Array.from({ length: 5 }, (_, i) => ({
  id: `p${i}`,
  name: `Project ${i}`,
  created_at: null,
  favorite: false,
  paper_count: 3,
  read_count: 1,
}));

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test('creating replaces the list with a top-anchored panel and cancel restores it', async () => {
  jest.mocked(api.listProjects).mockResolvedValue({ projects });

  await renderAsync(
    wrap(
      <ProjectSwitcher visible activePid="p0" onSelect={() => {}} onClose={() => {}} />,
    ),
  );
  await waitFor(() => expect(screen.getByText('Project 4')).toBeTruthy());

  await fireEventAsync.press(screen.getByText('+ New project'));

  // The list is gone; the input + actions render at the top of the sheet.
  expect(screen.queryByText('Project 4')).toBeNull();
  expect(screen.getByText('New project')).toBeTruthy();
  expect(screen.getByPlaceholderText('Project name')).toBeTruthy();
  expect(screen.getByText('Create')).toBeTruthy();

  await fireEventAsync.press(screen.getByText('Cancel'));
  await waitFor(() => expect(screen.getByText('Project 4')).toBeTruthy());
  expect(screen.queryByPlaceholderText('Project name')).toBeNull();
});
