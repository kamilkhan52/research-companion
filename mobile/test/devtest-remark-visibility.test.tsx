// Kamil, 2026-09-02: "my main issue now is that I can't be sure if my comments are actually
// being placed. I don't see them after remarking."
//
// They WERE being placed — every remark he sent is in the inbox. The card just closed over
// them: submitting set `expanded: false`, and the history list is loaded only when you tap
// "Show earlier notes" and was never refreshed after posting. So the note he had just written
// went somewhere he could not see, with nothing to say it had landed.

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));
jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn(),
  dispatchToClaude: jest.fn(),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { showToast } from '@/ui/Toast';
import { ItemCard } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

const ITEM: DevTestItem = {
  id: 'DR-118', state: 'open', raised: '2026-09-01',
  title: 'Sort by last activity in dev test bubble', how_to_test: 'open the bubble',
  feedback_count: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.getDevTestFeedback).mockResolvedValue({ entries: [] });
});

async function remark(view: ReturnType<typeof render>, text: string) {
  fireEvent.changeText(await view.findByPlaceholderText(/comment/i), text);
  fireEvent.press(await view.findByText('Remark'));
}

test('a remark appears in the card instead of closing it', async () => {
  jest.mocked(api.getDevTestFeedback).mockResolvedValue({
    entries: [{ ts: '2026-09-02T15:18:16', item_id: 'DR-118', kind: 'feedback',
                verdict: 'remark', comment: 'It is working I think.' }],
  });
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  await remark(view, 'It is working I think.');

  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  // The note is fetched back and shown, which is the whole point: he can SEE that it landed.
  await waitFor(() => expect(api.getDevTestFeedback).toHaveBeenCalledWith('DR-118'));
  await view.findByText('It is working I think.');
});

test('a pass still closes the card and does not fetch a list nobody is looking at', async () => {
  // DR-077's queue wants a finished item out of the way, and loading history unasked would
  // spend a request per card on something not on screen.
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  fireEvent.press(await view.findByText('Pass'));

  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  expect(api.getDevTestFeedback).not.toHaveBeenCalled();
});

test('an already-open history refreshes after a pass, so it never shows a stale list', async () => {
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  fireEvent.press(await view.findByText('Show earlier notes'));
  await waitFor(() => expect(api.getDevTestFeedback).toHaveBeenCalledTimes(1));

  fireEvent.press(await view.findByText('Pass'));
  await waitFor(() => expect(api.getDevTestFeedback).toHaveBeenCalledTimes(2));
});

test('a failed history fetch does not lose the remark that already succeeded', async () => {
  jest.mocked(api.getDevTestFeedback).mockRejectedValue(new Error('offline'));
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  await remark(view, 'still worth recording');

  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  // Recording is what mattered; the list can wait for a reopen. Reporting failure here would
  // tell him the exact opposite of what happened — the remark IS saved.
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(
    expect.stringMatching(/recorded/i)));
  expect(showToast).not.toHaveBeenCalledWith(expect.stringMatching(/could not/i));
});
