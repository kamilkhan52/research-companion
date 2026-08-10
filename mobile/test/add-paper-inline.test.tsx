import { QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import { AddPaperInline, parseKnownPaper } from '@/components/AddPaperInline';
import { PaperSummaryOfferHost } from '@/components/PaperSummaryOffer';
import { createTestQueryClient } from './queryClient';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/store/listening', () => ({
  useListeningMode: () => ({ listeningMode: false }),
}));

beforeEach(async () => {
  mockPush.mockReset();
  await setBaseUrl('https://api.test');
});

test('parses title, arXiv, and direct-PDF entries through one contract', () => {
  expect(parseKnownPaper('A Paper Title')).toEqual({ title: 'A Paper Title', source: null });
  expect(parseKnownPaper('https://arxiv.org/abs/2401.01234v2')).toEqual({
    title: 'arXiv 2401.01234',
    source: '2401.01234',
    arxivId: '2401.01234',
  });
  expect(parseKnownPaper('https://papers.test/My_Paper.pdf')).toEqual({
    title: 'My Paper',
    source: 'https://papers.test/My_Paper.pdf',
    pdfUrl: 'https://papers.test/My_Paper.pdf',
  });
});

test('the shared compact field adds, requests auto-analysis, and routes to its running paper', async () => {
  jest.mocked(api.addPaper).mockResolvedValue({
    paper: {
      slug: 'awq',
      title: 'AWQ',
      group: 'Unsorted',
      list_status: 'unread',
      cites: [],
      retrieved: false,
      has_notes: false,
      session_state: null,
      arxiv_id: '2306.00978',
    },
  });
  const client = createTestQueryClient();
  await renderAsync(
    <QueryClientProvider client={client}>
      <AddPaperInline pid="project" showDivider={false} />
      <PaperSummaryOfferHost />
    </QueryClientProvider>,
  );

  expect(screen.getByLabelText('Add and start analysis')).toBeDisabled();

  await fireEventAsync.changeText(
    screen.getByLabelText('Paper title, DOI, or arXiv link'),
    '2306.00978',
  );
  expect(screen.getByText('Add')).toBeTruthy();
  await fireEventAsync.press(screen.getByLabelText('Add and start analysis'));

  await waitFor(() => expect(api.addPaper).toHaveBeenCalledWith(
    'project', 'arXiv 2306.00978', undefined, '2306.00978', undefined, undefined,
  ));
  expect(mockPush).toHaveBeenCalledWith('/paper/awq?autoStart=1&source=2306.00978');
  expect(screen.queryByText('Start the paper summary?')).toBeNull();
});

test('the specific-paper route focuses the same compact field', async () => {
  const client = createTestQueryClient();
  await renderAsync(
    <QueryClientProvider client={client}>
      <AddPaperInline pid="project" autoFocus />
    </QueryClientProvider>,
  );
  expect(screen.getByLabelText('Paper title, DOI, or arXiv link').props.autoFocus).toBe(true);
  expect(screen.queryByText('Add a paper you already know')).toBeNull();
});

test('an add failure stays attached to the field and preserves the draft', async () => {
  jest.mocked(api.addPaper).mockRejectedValue(new Error('That paper could not be added.'));
  const client = createTestQueryClient();
  await renderAsync(
    <QueryClientProvider client={client}>
      <AddPaperInline pid="project" showDivider={false} />
    </QueryClientProvider>,
  );

  const input = screen.getByLabelText('Paper title, DOI, or arXiv link');
  await fireEventAsync.changeText(input, 'A paper to keep');
  await fireEventAsync.press(screen.getByLabelText('Add and start analysis'));

  await waitFor(() => expect(screen.getByText('That paper could not be added.')).toBeTruthy());
  expect(input.props.value).toBe('A paper to keep');
});
