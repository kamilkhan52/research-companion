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
  // Exactly one toast. Asserting only "no /could not/" passed even with the try/catch removed,
  // because the rejection then surfaced as its own message ("offline") that matched neither
  // pattern — the test agreed with itself rather than with the guarantee.
  expect(showToast).toHaveBeenCalledTimes(1);
});

// Kamil, 2026-09-02: "the description, after it is fixed, should start collapsed" and "when I
// collapse the issue, I have to scroll up… I should end up where I was when I expanded it."

test('the description starts collapsed and opens on request', async () => {
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  // The prose is present but clipped, with an affordance rather than a wall of text.
  await view.findByText('Show details');
  fireEvent.press(view.getByTestId('devtest-item-details'));
  await view.findByText('Hide details');
});

test('reopening a card starts its description collapsed again', async () => {
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  fireEvent.press(view.getByTestId('devtest-item-details'));
  await view.findByText('Hide details');

  fireEvent.press(view.getByLabelText(/Tap to collapse/i));   // close the card
  fireEvent.press(await view.findByLabelText(/Tap to leave a pass/i));
  // Collapsed is the right state to come back to: remembering it would recreate the wall of
  // text on exactly the cards he reads most.
  await view.findByText('Show details');
});

test('the list is told when a card opens and closes, so it can restore the position', () => {
  const seen: Array<[boolean, string]> = [];
  const view = render(
    <ItemCard item={ITEM} shot={null} route="/discover"
              onExpandChange={(e, id) => seen.push([e, id])} />);
  fireEvent.press(view.getByLabelText(/Tap to leave a pass/i));
  fireEvent.press(view.getByLabelText(/Tap to collapse/i));
  expect(seen).toEqual([[true, 'DR-118'], [false, 'DR-118']]);
});

test('a Pass closes the card the same way a header tap does', async () => {
  // The commonest way a card closes, and the one that follows reading the whole thing. It used
  // to write `expanded: false` straight into the draft, bypassing the collapse helper — so the
  // scroll restore never ran on the very case the feature exists for, and the description
  // stayed expanded on reopen.
  const seen: Array<[boolean, string]> = [];
  const view = render(
    <ItemCard item={ITEM} shot={null} route="/discover" startExpanded
              onExpandChange={(e, id) => seen.push([e, id])} />);
  fireEvent.press(view.getByTestId('devtest-item-details'));
  await view.findByText('Hide details');

  fireEvent.press(await view.findByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  await waitFor(() => expect(seen).toContainEqual([false, 'DR-118']));

  fireEvent.press(await view.findByLabelText(/Tap to leave a pass/i));
  await view.findByText('Show details');    // and the description reset with it
});

test('the description is clamped until it is asked for', async () => {
  // Without this the "Show details" label exists but clamps nothing, which every other test
  // here would happily accept.
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  const prose = await view.findByText(ITEM.how_to_test);
  expect(prose.props.numberOfLines).toBe(3);
  fireEvent.press(view.getByTestId('devtest-item-details'));
  await waitFor(() => expect(
    view.getByText(ITEM.how_to_test).props.numberOfLines).toBeUndefined());
});

test('the details toggle still announces the description it hides', async () => {
  // An explicit accessibilityLabel on a Pressable REPLACES what its children would have read
  // out, which this component documents at the card header — so the prose has to be carried
  // in the label or a screen reader loses the description entirely.
  const view = render(<ItemCard item={ITEM} shot={null} route="/discover" startExpanded />);
  await view.findByLabelText(new RegExp(`Show details\\. ${ITEM.how_to_test}`));
});
