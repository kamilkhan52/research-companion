// Kamil, 2026-09-02: "Let's prompt for dispatch on Fail."
//
// Recording a fail and handing it to Claude were two unrelated gestures a screen apart, and the
// gap is where a fail sits: DR-009's waited ten hours because nothing carried it anywhere.
//
// The prompt lives on the SHEET, not on the card. Recording a verdict re-runs the list filter,
// and under "Not reviewed" — the flow DR-077 exists for — that unmounts the card in the same
// commit, so a prompt owned by the card would never be seen.

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  createDevTestItem: jest.fn(),
  dispatchToClaude: jest.fn(),
  getDispatchStatus: jest.fn().mockResolvedValue({ dispatch: null }),
  resumeDispatch: jest.fn(),
  getDeployState: jest.fn().mockRejectedValue(new Error('no deploy state')),
  deployNow: jest.fn(),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { DevTestBubble } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

const ITEMS: DevTestItem[] = [
  { id: 'DR-A', state: 'open', raised: '2026-09-01', title: 'Alpha thing',
    how_to_test: 'open it', feedback_count: 0 },
];

const OK = { dispatch: { id: 'd1', model: 'opus' as const, item_id: 'DR-A', log: '/x',
                         started_at: '' } };

async function failTheItem() {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  fireEvent.press(screen.getByText('Alpha thing'));          // expand the card
  fireEvent.press(await screen.findByText('Fail'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  return screen;
}

beforeEach(() => jest.clearAllMocks());

test('a fail raises a prompt to hand it over', async () => {
  const screen = await failTheItem();
  await screen.findByTestId('devtest-fail-prompt');
  await screen.findByText('DR-A failed. Hand it to Claude now?');
});

test('the prompt survives the card being filtered away by its own verdict', async () => {
  // Recording the verdict re-runs the filter. Under "Not reviewed" the item stops matching and
  // its card unmounts in the same commit — which is precisely why the prompt is not on the card.
  const screen = await failTheItem();
  fireEvent.press(screen.getByLabelText('Not reviewed'));
  await waitFor(() => expect(screen.queryByText('Alpha thing')).toBeNull());
  expect(screen.getByTestId('devtest-fail-prompt')).toBeTruthy();
});

test('taking the prompt dispatches on that item and clears it', async () => {
  jest.mocked(api.dispatchToClaude).mockResolvedValue(OK);
  const screen = await failTheItem();
  fireEvent.press(await screen.findByTestId('devtest-fail-prompt-dispatch'));
  await waitFor(() => expect(api.dispatchToClaude).toHaveBeenCalledWith('sonnet', 'DR-A', false));
  await waitFor(() => expect(screen.queryByTestId('devtest-fail-prompt')).toBeNull());
});

test('a REFUSED dispatch leaves the prompt up, because retrying later is the right move', async () => {
  // `fireDispatch` swallows its own errors and resolves either way, so dismissing on `.then`
  // treated a refusal as a hand-off. And a refusal is the EXPECTED answer while another session
  // is running — most of the time once you are working a queue of fails — so this left the fail
  // carried nowhere while the UI said otherwise: the exact gap this feature exists to close.
  jest.mocked(api.dispatchToClaude).mockRejectedValue(
    new Error('A dispatched session is already running (dispatch-1)'));
  const screen = await failTheItem();
  fireEvent.press(await screen.findByTestId('devtest-fail-prompt-dispatch'));
  await waitFor(() => expect(api.dispatchToClaude).toHaveBeenCalled());
  expect(screen.getByTestId('devtest-fail-prompt')).toBeTruthy();
});

test('declining clears it without dispatching', async () => {
  const screen = await failTheItem();
  fireEvent.press(await screen.findByTestId('devtest-fail-prompt-dismiss'));
  await waitFor(() => expect(screen.queryByTestId('devtest-fail-prompt')).toBeNull());
  expect(api.dispatchToClaude).not.toHaveBeenCalled();
});

test('a pass raises nothing — there is nothing to hand over', async () => {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  fireEvent.press(screen.getByText('Alpha thing'));
  fireEvent.press(await screen.findByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  expect(screen.queryByTestId('devtest-fail-prompt')).toBeNull();
});

test('a remark raises nothing — it would bury the note DR-119 exists to show', async () => {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  fireEvent.press(screen.getByText('Alpha thing'));
  fireEvent.changeText(
    await screen.findByPlaceholderText('Comment (optional — a remark needs a comment or a screenshot)'),
    'a note');
  fireEvent.press(await screen.findByText('Remark'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  expect(screen.queryByTestId('devtest-fail-prompt')).toBeNull();
});

test('the prompt works under a non-default sort, not just the default one', async () => {
  // The branch that renders under `sort !== 'default'` was missing the callback entirely, so
  // the feature was inert under "Last activity" — the sort Kamil asked for precisely so he
  // could work the queue ("find the last item I opened or dispatched or was last worked on").
  // That made the queue-working sort the first place a fail went nowhere.
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());

  fireEvent.press(screen.getByLabelText('Last activity'));
  fireEvent.press(screen.getByText('Alpha thing'));
  fireEvent.press(await screen.findByText('Fail'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  await screen.findByTestId('devtest-fail-prompt');
});

test('a second fail queues behind the first instead of replacing it', async () => {
  // A single slot dropped the first item's prompt silently — "recorded and carried nowhere",
  // one level up from the gap this feature exists to close.
  const two = [...ITEMS, { id: 'DR-B', state: 'open', raised: '2026-09-01',
                           title: 'Beta gadget', how_to_test: 'open it', feedback_count: 0 }];
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: two });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Beta gadget')).toBeTruthy());

  fireEvent.press(screen.getByText('Alpha thing'));
  fireEvent.press(await screen.findByText('Fail'));
  await screen.findByText('DR-A failed. Hand it to Claude now?');

  fireEvent.press(screen.getByText('Beta gadget'));
  fireEvent.press(await screen.findByText('Fail'));
  // Still showing the FIRST one; the second is behind it, not instead of it.
  await screen.findByText('DR-A failed. Hand it to Claude now?');

  fireEvent.press(screen.getByTestId('devtest-fail-prompt-dismiss'));
  await screen.findByText('DR-B failed. Hand it to Claude now?');
});

test('an unanswered prompt does not outlive the sitting that raised it', async () => {
  // DevTestBubble stays mounted to render the floating trigger, so without an explicit reset
  // the prompt greeted him on the next open, about a fail from a previous session.
  const screen = await failTheItem();
  await screen.findByTestId('devtest-fail-prompt');
  fireEvent.press(screen.getByLabelText('Close'));
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  expect(screen.queryByTestId('devtest-fail-prompt')).toBeNull();
});
