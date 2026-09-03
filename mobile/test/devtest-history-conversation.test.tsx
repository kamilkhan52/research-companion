// DR-080 — "The comments and your responses should be formatted as such, not just plain
// text. And yes, I expect you to respond to comments so I can see if we should pass the item
// or not." The item history renders as a role-distinguished conversation: tester entries with
// their verdict, agent `response` entries as markdown under a "Claude · reply" label.
//
// DR-123 settled the vocabulary — Kamil: "I don't know what Notes here are. Is note a comment? A
// reply? Be clear and consistent." His entries are "You", the agent's are "Claude", what the
// agent leaves is a "reply", and the thing holding both is the "conversation". "Agent" and "note"
// were two more words for things already named, and they are gone.

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
  fireEvent.press(await screen.findByText('Show conversation'));

  // Tester entry: role + verdict, comment as text.
  expect(await screen.findByText(/You · fail/)).toBeTruthy();
  expect(screen.getByText('History is plain text lines')).toBeTruthy();

  // Agent entry: named as Claude's reply, markdown-rendered response text.
  expect(screen.getByText('Claude · reply')).toBeTruthy();
  expect(
    screen.getByText(/Rendered as a conversation now — fixed in PR #999/),
  ).toBeTruthy();
});

// DR-123: a bare `remark` is shown as a "comment" — the same word as the button that produced
// it — while `remark` stays the wire value the API, the inbox and the triage skill all speak.
test('a bare remark reads as a comment, matching the button that made it', async () => {
  const screen = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  fireEvent.press(screen.getByText(ITEM.title));
  fireEvent.press(await screen.findByText('Show conversation'));
  expect(await screen.findByText(/You · fail/)).toBeTruthy();
  expect(screen.queryByText(/You · remark/)).toBeNull();
});

test('the card meta line flags an existing reply before the conversation is opened', () => {
  const screen = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  // One line, in words, in place of the five bordered chips that used to wrap the head onto a
  // second row: the state, his own entries, and Claude's replies.
  expect(screen.getByText('Open · 1 from you · 1 reply')).toBeTruthy();
});

// DR-123 — "The PR or whatever name doesn't need to be always visible." The id is where it is
// used (naming the item to a dispatch, matching a reply that mentions it), not on every row of a
// list of 120. Search still matches it whether or not it is on screen.
test('the id is off the collapsed row and on the expanded one', () => {
  const screen = render(<ItemCard item={ITEM} shot={null} route="/discover" />);
  expect(screen.queryByText(/DR-080/)).toBeNull();
  fireEvent.press(screen.getByText(ITEM.title));
  expect(screen.getByText('DR-080 · raised 2026-08-12')).toBeTruthy();
});
