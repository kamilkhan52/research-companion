// DR-092 — Kamil: dispatch a Claude Code session straight from the bubble. Fire-on-tap
// (his decision), a model picker, per-item and one for the whole pending batch.

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));
jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));

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
import { showToast } from '@/ui/Toast';
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
  // The third argument is `fresh`: false here, because continuing a session that already knows
  // the item is the default.
  await waitFor(() =>
    expect(api.dispatchToClaude).toHaveBeenCalledWith('opus', 'DR-091', false));
});

test('no dispatch control without a model (the persistence-test mount stays unaffected)', () => {
  const { queryByText } = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded />,
  );
  expect(queryByText(/Dispatch to Claude/)).toBeNull();
});

test('the card offers a fresh session as a separate, deliberate act', async () => {
  // Continuing is the default and the common case, so it stays one tap; starting over is for
  // when the accumulated context is the problem rather than the point, and reads as such.
  const { findByTestId } = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded dispatchModel="opus" />,
  );
  fireEvent.press(await findByTestId('devtest-dispatch-fresh'));
  await waitFor(() => expect(api.dispatchToClaude).toHaveBeenCalledWith('opus', 'DR-091', true));
});

test('the ordinary dispatch does not ask for a fresh session', async () => {
  const { findByTestId } = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded dispatchModel="opus" />,
  );
  fireEvent.press(await findByTestId('devtest-dispatch-item'));
  await waitFor(() => expect(api.dispatchToClaude).toHaveBeenCalledWith('opus', 'DR-091', false));
});

test('the toast says when a session was picked back up, rather than guessing', async () => {
  // The server decides this — it depends on what is on disk and how old it is — so a client
  // that inferred it would eventually tell him the opposite of what ran.
  jest.mocked(api.dispatchToClaude).mockResolvedValue({
    dispatch: { id: 'd2', model: 'opus', item_id: 'DR-091', log: '/x', started_at: '',
                continued_session: true },
  });
  const { findByTestId } = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded dispatchModel="opus" />,
  );
  fireEvent.press(await findByTestId('devtest-dispatch-item'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(
    expect.stringMatching(/picking DR-091 back up/)));
});
