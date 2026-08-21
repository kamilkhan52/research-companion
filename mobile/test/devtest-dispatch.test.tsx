// DR-092 — Kamil: dispatch a Claude Code session straight from the bubble. Fire-on-tap
// (his decision), a model picker, per-item and one for the whole pending batch.

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));
jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  dispatchToClaude: jest.fn().mockResolvedValue({
    dispatch: { id: 'dispatch-1', model: 'sonnet', item_id: 'DR-091', log: '/x', started_at: '' },
  }),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { ItemCard } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

const ITEM: DevTestItem = {
  id: 'DR-091', state: 'open', raised: '2026-08-21',
  title: 'A figure bug', how_to_test: 'open the paper', feedback_count: 0,
};

beforeEach(() => jest.clearAllMocks());

test('an expanded card dispatches THIS issue on the picked model, fire-on-tap', async () => {
  const { getByText, findByText } = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded dispatchModel="opus" />,
  );
  const button = await findByText('Dispatch to Claude (opus)');
  fireEvent.press(button);
  await waitFor(() =>
    expect(api.dispatchToClaude).toHaveBeenCalledWith('opus', 'DR-091'));
});

test('no dispatch control without a model (the persistence-test mount stays unaffected)', () => {
  const { queryByText } = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded />,
  );
  expect(queryByText(/Dispatch to Claude/)).toBeNull();
});
