// DR-065 — Kamil: "The bubble should remember the last state. Such as which item was opened,
// any unfinished message... It should be minimize when collapsed and reappear with full
// resumption of previous state." Closing the sheet used to unmount everything and lose it.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ItemCard } from '@/components/DevTestBubble';
import { draftKey } from '@/hooks/usePersistedDraft';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('@/api/endpoints', () => ({
  recordDevTestFeedback: jest.fn(),
  getDevTestFeedback: jest.fn(),
}));

const ITEM: DevTestItem = {
  id: 'DR-065', state: 'open', raised: '2026-08-11',
  title: 'Bubble should remember its state', how_to_test: '', feedback_count: 0,
};

test('an in-progress remark survives the card unmounting and remounting', async () => {
  const first = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  fireEvent.press(first.getByText(ITEM.title));
  const input = await first.findByPlaceholderText('Comment (optional for pass/fail, required for remark)');
  fireEvent.changeText(input, 'The search stopped but the indicator kept spinning.');
  // usePersistedDraft debounces its AsyncStorage write (real setTimeout, no fake timers in this
  // suite) — wait for the write to actually land, not just for the input's own state to update,
  // or unmounting races the debounce and the test would pass by accident on a slow machine and
  // fail on a fast one.
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-item', ITEM.id));
    expect(raw).toContain('The search stopped but the indicator kept spinning.');
  }, { timeout: 2000 });
  first.unmount();

  const second = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  // Expanded state resumes on its own — the comment field (and its text) only exist once
  // expanded, so finding it at all proves the expansion was restored, not just the text.
  const restored = await second.findByDisplayValue(
    'The search stopped but the indicator kept spinning.');
  expect(restored).toBeTruthy();
});

test('a fresh item with no prior draft starts collapsed, no leftover text', async () => {
  const screen = render(<ItemCard item={{ ...ITEM, id: 'DR-999' }} shot={null} route="/" />);
  expect(screen.queryByPlaceholderText(/Comment/)).toBeNull();
});
