// DR-071 — Kamil: "Abstract in Discover results doesn't show." Root cause (corrected after an
// Opus review checked it against Kamil's actual stored run): app/discovery_recall.py's
// chase_citations (the R2 forward-citation channel) requested OpenAlex fields without
// abstract_inverted_index, so every candidate it produced reached the client with the `abstract`
// key missing entirely — not merely empty. That's fixed at the source now, but some candidates
// (an S2 bulk-search hit with a null abstract, an OpenAlex work with no inverted index) will
// still legitimately lack one, so the toggle must not offer to reveal nothing.

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

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

test('a candidate with no abstract shows no Abstract toggle', async () => {
  const { unmountAsync } = await renderCard({ ...BASE, abstract: '' });
  expect(screen.queryByLabelText(/abstract for A Paper Worth Reading/i)).toBeNull();
  await unmountAsync();
});

test('a candidate whose payload omits `abstract` entirely (the real shape from a channel gap) also shows no toggle', async () => {
  const { abstract: _drop, ...withoutAbstract } = BASE;
  const { unmountAsync } = await renderCard(withoutAbstract);
  expect(screen.queryByLabelText(/abstract for A Paper Worth Reading/i)).toBeNull();
  await unmountAsync();
});

test('a candidate with an abstract still offers the toggle, and it reveals the text', async () => {
  const { unmountAsync } = await renderCard({ ...BASE, abstract: 'This paper studies…' });
  const toggle = screen.getByLabelText('Show abstract for A Paper Worth Reading');
  expect(screen.queryByText('This paper studies…')).toBeNull();
  await fireEventAsync.press(toggle);
  expect(screen.getByText('This paper studies…')).toBeTruthy();
  await unmountAsync();
});

// DR-070 — Kamil: "turn these large buttons into icons so they're more compact." The pills lost
// their text labels, so the toggled-on state has to read some other way — a real style diff on
// the pressable, not just a relabel, or a sighted user loses the affordance the words used to give.
test('toggling the abstract icon on marks it visually active, not just relabeled', async () => {
  const { unmountAsync } = await renderCard({ ...BASE, abstract: 'This paper studies…' });
  const toggle = screen.getByLabelText('Show abstract for A Paper Worth Reading');
  const flatStyleBefore = StyleSheet.flatten(toggle.props.style);
  await fireEventAsync.press(toggle);
  const active = screen.getByLabelText('Hide abstract for A Paper Worth Reading');
  const flatStyleAfter = StyleSheet.flatten(active.props.style);
  expect(flatStyleAfter.borderColor).not.toBe(flatStyleBefore.borderColor);
  await unmountAsync();
});

test('full paper and hide actions render as icon-only buttons with their labels intact', async () => {
  const { unmountAsync } = await renderCard({ ...BASE, url: 'https://arxiv.org/abs/2401.00001' });
  expect(screen.getByLabelText('Open full paper for A Paper Worth Reading')).toBeTruthy();
  expect(screen.getByLabelText('Hide A Paper Worth Reading from recommendations')).toBeTruthy();
  await unmountAsync();
});

// Opus review, PR #381: the icon-button conversion repurposed `styles.actionBtn` into a fixed
// 48x48 square with no horizontal padding — a style the hidden-state "Undo" TEXT button also
// used, unaccounted for in the original diff. A word doesn't fit a zero-padding icon square the
// same way an icon does, especially at a larger accessibility font scale.
test('the Undo control on a hidden suggestion keeps its own padded geometry, not the icon-square style', async () => {
  // `jest.mock('@/api/endpoints')` (bare, no factory) doesn't automock `hideSuggestion`/
  // `unhideSuggestion` in this suite for reasons unrelated to this PR (confirmed: even the real,
  // unmocked module reports them `undefined` via `Object.keys` in this test environment — a
  // pre-existing jest/babel transform quirk, not something introduced here). Direct assignment
  // onto the mocked module namespace sidesteps it without touching every other test's automock.
  (api as unknown as { hideSuggestion: jest.Mock }).hideSuggestion = jest.fn().mockResolvedValue({
    hidden: { keys: ['c1'], title: 'A Paper Worth Reading', hidden_at: '2026-08-12T00:00:00Z' },
  });
  const { unmountAsync } = await renderCard({ ...BASE, abstract: '' });
  await fireEventAsync.press(screen.getByLabelText('Hide A Paper Worth Reading from recommendations'));
  const undo = await screen.findByLabelText('Undo hiding A Paper Worth Reading');
  const flat = StyleSheet.flatten(undo.props.style);
  // Not the icon-square dimensions — a fixed 48x48 with no padding is exactly what broke here.
  expect(flat.width).not.toBe(48);
  expect(flat.paddingHorizontal).toBeTruthy();
  await unmountAsync();
});
