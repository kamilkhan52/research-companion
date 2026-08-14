// DR-080 — "The comments and your responses should be formatted as such, not just plain
// text. And yes, I expect you to respond to comments so I can see if we should pass the item
// or not." The item history renders as a role-distinguished conversation: tester entries with
// their verdict, agent `response` entries as markdown under an Agent chip.

import { fireEvent, render } from '@testing-library/react-native';

import { ItemCard } from '@/components/DevTestBubble';
import type { DevTestFeedbackEntry, DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));

const ENTRIES: DevTestFeedbackEntry[] = [
  {
    ts: '2026-08-13T20:11:00+00:00', item_id: 'DR-080', kind: 'feedback',
    verdict: 'fail', comment: 'History is plain text lines', route: '/paper/x', screenshot: null,
  },
  {
    ts: '2026-08-14T09:00:00+00:00', item_id: 'DR-080', kind: 'response',
    text: 'Rendered as a conversation now — fixed in PR #999. Please re-test and pass.',
  },
];

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn(),
  getDevTestFeedback: jest.fn(async () => ({ entries: ENTRIES })),
}));

const ITEM: DevTestItem = {
  id: 'DR-080', state: 'open', raised: '2026-08-12',
  title: 'Bubble comments and responses', how_to_test: '', feedback_count: 1,
  response_count: 1,
};

test('history renders tester and agent entries as a role-distinguished conversation', async () => {
  const screen = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  fireEvent.press(screen.getByText(ITEM.title)); // expand
  fireEvent.press(await screen.findByText('Show earlier notes'));

  // Tester entry: role + verdict chip, comment as body text.
  expect(await screen.findByText('You · fail')).toBeTruthy();
  expect(screen.getByText('History is plain text lines')).toBeTruthy();

  // Agent entry: Agent chip, markdown-rendered response text.
  expect(screen.getByText('Agent')).toBeTruthy();
  expect(
    screen.getByText(/Rendered as a conversation now — fixed in PR #999/),
  ).toBeTruthy();
});

test('the card head flags an existing agent reply before the history is opened', () => {
  const screen = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  expect(screen.getByText('1 reply')).toBeTruthy();
});
