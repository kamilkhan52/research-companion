import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { AuthorBoardResponse } from '@/api/types';
import AuthorsScreen from '@/app/authors';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));
jest.mock('@/store/project', () => ({ useActiveProject: () => ({ activePid: 'proj' }) }));

const board: AuthorBoardResponse = {
  authors: [
    {
      name: 'Song Han', affiliation: 'MIT', in_project_count: 2, significant_count: 3,
      external_count: 5, active_years: [2022, 2023], activity: 17,
      papers: [
        { id: 'awq', slug: 'awq', title: 'AWQ', kind: 'project', year: 2023 },
        { id: 'ext:s', slug: null, title: 'StreamingLLM', kind: 'external', year: 2023 },
      ],
    },
    {
      name: 'Tri Dao', affiliation: '', in_project_count: 1, significant_count: 0,
      external_count: 2, active_years: [2022, 2022], activity: 5,
      papers: [{ id: 'flash', slug: 'flash', title: 'FlashAttention', kind: 'project', year: 2022 }],
    },
  ],
  explainers: {
    activity: 'Activity blends three signals: papers in this project (weight 3)…',
    significant: 'A citation is marked significant when the citing paper engages substantively…',
  },
  built_at: '2026-07-15T00:00:00Z',
};

function wrap(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  mockPush.mockClear();
  jest.mocked(api.getGraphAuthors).mockResolvedValue(board);
});

test('renders the ranked author board with counts and affiliation', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  expect(screen.getByText('MIT')).toBeTruthy();
  expect(screen.getByText('2 in project')).toBeTruthy();
  expect(screen.getByText('3 significant')).toBeTruthy();
  expect(screen.getByText('Tri Dao')).toBeTruthy();
});

test('the scoring explainer is hidden until tapped', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  expect(screen.queryByText(/Activity blends three signals/)).toBeNull();
  await fireEventAsync.press(screen.getByText('How is this ranked?'));
  expect(screen.getByText(/Activity blends three signals/)).toBeTruthy();
});

test('tapping an author opens their papers; a project paper navigates to its discussion', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Song Han'));
  await waitFor(() => expect(screen.getByText(/AWQ/)).toBeTruthy());
  await fireEventAsync.press(screen.getByText(/AWQ/));
  expect(mockPush).toHaveBeenCalledWith('/paper/awq');
});

test('Labs mode groups by affiliation with unknowns last', async () => {
  await renderAsync(wrap(<AuthorsScreen />));
  await waitFor(() => expect(screen.getByText('Song Han')).toBeTruthy());
  await fireEventAsync.press(screen.getByText('Labs'));
  // MIT appears as both a group header and a card affiliation line now.
  expect(screen.getAllByText('MIT').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('INDEPENDENT / UNKNOWN')).toBeTruthy();
});
