// DR-071 — Kamil: "Abstract in Discover results doesn't show." Root cause: a candidate that
// only surfaced through the reference-graph recall channel (app/discovery_recall.py's
// graph_recommendations) carries no `abstract` field at all — the button flipped to "Hide
// abstract" but there was never anything to reveal. The button itself must not offer to show
// something that doesn't exist.

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { setBaseUrl } from '@/api/config';
import type { PaperSuggestion } from '@/api/types';
import { createTestQueryClient } from './queryClient';

import { SuggestionCard } from '@/app/(tabs)/discover';

jest.mock('@/api/endpoints');

const BASE: PaperSuggestion = {
  candidate_id: 'c1',
  arxiv_id: '2401.00001',
  title: 'A Paper Worth Reading',
  abstract: '',
  authors: ['A. Author'],
  affiliations: [],
  year: 2024,
  category: 'cs.LG',
  url: 'https://arxiv.org/abs/2401.00001',
  pdf_url: 'https://arxiv.org/pdf/2401.00001',
  citation_count: 12,
  sources: ['arxiv'],
  relevance: 8,
  credibility: 3,
  score: 9.1,
  reasons: ['Cites a paper on your reading list'],
};

async function renderCard(suggestion: PaperSuggestion) {
  await setBaseUrl('https://api.test');
  jest.mocked(api.getProjectState).mockResolvedValue({ papers: [] } as never);
  const client = createTestQueryClient();
  return renderAsync(
    <QueryClientProvider client={client}>
      <SuggestionCard pid="proj" suggestion={suggestion} rank={1} />
    </QueryClientProvider>,
  );
}

test('a candidate with no abstract (graph-only recall) shows no Abstract toggle', async () => {
  await renderCard({ ...BASE, abstract: '' });
  expect(screen.queryByLabelText(/abstract for A Paper Worth Reading/i)).toBeNull();
});

test('a candidate with an abstract still offers the toggle, and it reveals the text', async () => {
  const { unmountAsync } = await renderCard({ ...BASE, abstract: 'This paper studies…' });
  const toggle = screen.getByLabelText('Show abstract for A Paper Worth Reading');
  expect(screen.queryByText('This paper studies…')).toBeNull();
  await fireEventAsync.press(toggle);
  expect(screen.getByText('This paper studies…')).toBeTruthy();
  await unmountAsync();
});
