// DR-066 — Kamil: suggestions already on the reading list "shouldn't be included. We could
// have an option to reveal them, but not by default." The collapsed count row is the
// reveal: closed by default, expanding lists each excluded suggestion with the
// reading-list title it matched.

import { fireEvent, render } from '@testing-library/react-native';

import type { PaperSuggestion } from '@/api/types';
import { InLibraryRow } from '@/app/(tabs)/discover';

jest.mock('@/api/endpoints');

const item = (over: Partial<PaperSuggestion> & { library_match?: string }) =>
  ({
    candidate_id: 'c1',
    arxiv_id: '2401.00001',
    title: 'A Paper Worth Reading',
    abstract: '',
    authors: [],
    affiliations: [],
    year: 2024,
    category: 'cs.LG',
    reasons: [],
    sources: [],
    credibility: 0,
    score: 0,
    ...over,
  }) as PaperSuggestion & { library_match?: string };

test('collapsed by default, expands to the excluded suggestions with their matches', () => {
  const { getByText, queryByText } = render(
    <InLibraryRow
      items={[
        item({ candidate_id: 'c1', title: 'Attention is all you need', library_match: 'Attention Is All You Need' }),
        item({ candidate_id: 'c2', title: 'Second Duplicate', library_match: 'Second Duplicate' }),
      ]}
    />,
  );
  expect(getByText('2 already in your library')).toBeTruthy();
  expect(queryByText('Attention is all you need')).toBeNull();

  fireEvent.press(getByText('2 already in your library'));
  expect(getByText('Attention is all you need')).toBeTruthy();
  // The match line explains WHY it was excluded — shown when the titles differ…
  expect(getByText('matches “Attention Is All You Need”')).toBeTruthy();
  // …and omitted when it would just repeat the title above it.
  expect(getByText('Second Duplicate')).toBeTruthy();
  expect(queryByText('matches “Second Duplicate”')).toBeNull();
});
