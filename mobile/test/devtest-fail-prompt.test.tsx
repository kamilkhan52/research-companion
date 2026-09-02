// Kamil, 2026-09-02: "Let's prompt for dispatch on Fail."
//
// Recording a fail and handing it to Claude were two unrelated gestures a screen apart, and the
// gap is where a fail sits: the DR-009 fail waited ten hours because nothing carried it
// anywhere. A fail is the one verdict that asks for work, so it now ends on a prompt.

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
    dispatch: { id: 'd1', model: 'opus', item_id: 'DR-091', log: '/x', started_at: '' },
  }),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { ItemCard } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

const ITEM: DevTestItem = {
  id: 'DR-091', state: 'open', raised: '2026-08-21', title: 'A figure bug',
  how_to_test: 'open the paper', feedback_count: 0,
};

const card = (extra = {}) => render(
  <ItemCard item={ITEM} shot={null} route="/discover" startExpanded dispatchModel="opus"
            {...extra} />,
);

beforeEach(() => jest.clearAllMocks());

test('a fail ends on a prompt to hand it over, not on a closed card', async () => {
  const view = card();
  fireEvent.press(await view.findByText('Fail'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  await view.findByTestId('devtest-fail-prompt');
  await view.findByText('Fail recorded. Hand it to Claude now?');
});

test('taking the prompt dispatches on that item and closes the card', async () => {
  const view = card();
  fireEvent.press(await view.findByText('Fail'));
  fireEvent.press(await view.findByTestId('devtest-fail-prompt-dispatch'));
  await waitFor(() =>
    expect(api.dispatchToClaude).toHaveBeenCalledWith('opus', 'DR-091', false));
  // Handed off, so the queue wants it gone — same as any other finished verdict.
  await waitFor(() => expect(view.queryByTestId('devtest-fail-prompt')).toBeNull());
});

test('declining closes the card without dispatching', async () => {
  const view = card();
  fireEvent.press(await view.findByText('Fail'));
  fireEvent.press(await view.findByTestId('devtest-fail-prompt-dismiss'));
  await waitFor(() => expect(view.queryByTestId('devtest-fail-prompt')).toBeNull());
  expect(api.dispatchToClaude).not.toHaveBeenCalled();
});

test('a pass closes the card and never prompts', async () => {
  // A pass finishes with the item; there is nothing to hand over.
  const view = card();
  fireEvent.press(await view.findByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  expect(view.queryByTestId('devtest-fail-prompt')).toBeNull();
});

test('a remark keeps the card open for the note, and does not prompt', async () => {
  // The remark path is about SEEING the comment land; a dispatch prompt on top of it would
  // bury the very thing that fix exists to show.
  const view = card();
  fireEvent.changeText(await view.findByPlaceholderText(/comment/i), 'just a note');
  fireEvent.press(await view.findByText('Remark'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  expect(view.queryByTestId('devtest-fail-prompt')).toBeNull();
});

test('without a model picked there is nothing to offer, so no prompt', async () => {
  // The persistence-test mount renders ItemCard with no dispatchModel; it must not grow a
  // prompt whose button cannot exist.
  const view = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  fireEvent.press(await view.findByText('Fail'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  expect(view.queryByTestId('devtest-fail-prompt')).toBeNull();
});
