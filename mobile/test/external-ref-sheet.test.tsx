import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { ProjectState } from '@/api/types';
import { ExternalRefSheet, parseArxivId } from '@/components/ExternalRefSheet';

const projectState = {
  project: { id: 'proj', name: 'Proj' },
  has_key: true,
  model: null,
  narration_model: null,
  preview_model: null,
  speech_provider: null,
  has_openai_key: false,
  papers: [
    {
      slug: 'gpt4', title: 'GPT-4 Technical Report', group: 'Core', list_status: 'unread',
      cites: [], retrieved: true, has_notes: false, session_state: null, arxiv_id: '2303.08774',
    },
  ],
} as ProjectState;

function wrap(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getProjectState).mockResolvedValue(projectState as never);
});

test('parseArxivId reads abs and pdf urls only', () => {
  expect(parseArxivId('https://arxiv.org/abs/2303.08774')).toBe('2303.08774');
  expect(parseArxivId('https://arxiv.org/pdf/2303.08774v2')).toBe('2303.08774');
  expect(parseArxivId('https://example.com/paper')).toBeNull();
});

test('a web-found paper can be added straight from the sheet', async () => {
  jest.mocked(api.addPaper).mockResolvedValue({ paper: { slug: 'new' } } as never);
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: 'https://arxiv.org/abs/2401.12345', label: 'A New Related Work' }}
        onClose={() => {}}
      />,
    ),
  );
  expect(screen.getByText('A New Related Work')).toBeTruthy();
  expect(screen.getByText('Open link')).toBeTruthy();

  await fireEventAsync.press(screen.getByText('Add to reading list'));
  await waitFor(() =>
    expect(api.addPaper).toHaveBeenCalledWith('proj', 'A New Related Work', undefined, '2401.12345', undefined),
  );
  expect(screen.getByText('Added to reading list')).toBeTruthy();
});

test('a reference already in the project cannot be re-added', async () => {
  await renderAsync(
    wrap(
      <ExternalRefSheet
        pid="proj"
        refItem={{ href: 'https://arxiv.org/abs/2303.08774v1', label: 'GPT-4 Technical Report' }}
        onClose={() => {}}
      />,
    ),
  );
  await waitFor(() => expect(screen.getByText('Already in this project')).toBeTruthy());
  expect(screen.queryByText('Add to reading list')).toBeNull();
});
