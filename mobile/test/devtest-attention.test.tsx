/**
 * DR-134 — Kamil: "I made comments on Passed items expecting they'd be seen." They were not.
 *
 * Every other filter in this sheet keys on the VERDICT, and recording a Pass drops the card out
 * of the default "Not reviewed" view — so a comment added afterwards lands somewhere he cannot
 * see, and nothing surfaces it. These pin the two things that fix it: a filter that ignores the
 * verdict, and a card that says when a session is on the item right now.
 */
jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  dispatchToClaude: jest.fn(),
  getDispatchStatus: jest.fn().mockResolvedValue({ dispatch: null }),
  getDeployState: jest.fn(),
  deployNow: jest.fn(),
  resumeDispatch: jest.fn(),
  createDevTestItem: jest.fn(),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import * as api from '@/api/endpoints';
import { cardMeta, ItemCard, matchesFilter, REVIEW_FILTERS } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

const ITEM: DevTestItem = {
  id: 'DR-900', raised: '2026-09-04', title: 'A thing to check', state: 'implemented — verify',
  how_to_test: 'Tap it.', feedback_count: 0,
};

beforeEach(() => jest.clearAllMocks());

const item = (over: Partial<DevTestItem>): DevTestItem => ({
  id: 'DR-001', raised: '2026-09-04', title: 'A thing', state: 'implemented — verify',
  how_to_test: 'Tap it.', feedback_count: 0, ...over,
});

const passes = matchesFilter;

test('a PASSED item he has since commented on is reachable — the case that was getting lost', () => {
  const passedAndCommented = item({ awaiting_reply: true, feedback_count: 2 });

  // Every verdict-keyed filter hides it. This is the bug, stated as a test.
  expect(passes(passedAndCommented, 'unreviewed', 'pass')).toBe(false);
  expect(passes(passedAndCommented, 'failed', 'pass')).toBe(false);

  // "Needs reply" finds it anyway, because it never looks at the verdict.
  expect(passes(passedAndCommented, 'needsreply', 'pass')).toBe(true);
});

test('an item whose last word was ours is not in the queue', () => {
  expect(passes(item({ awaiting_reply: false, response_count: 1 }), 'needsreply', 'pass')).toBe(false);
});

test('the filter is offered in the menu, before the verdict-keyed ones', () => {
  const keys = REVIEW_FILTERS.map((f) => f.key);
  expect(keys).toContain('needsreply');
  // Ahead of "Not reviewed": it answers "what is waiting on me", which is the first question.
  expect(keys.indexOf('needsreply')).toBeLessThan(keys.indexOf('unreviewed'));
});

test('a parked row appears only in Hidden, regardless of its other queue properties', () => {
  const hidden = item({ hidden: true, awaiting_reply: true, state: 'closed' });

  expect(passes(hidden, 'all', undefined)).toBe(false);
  expect(passes(hidden, 'needsreply', 'pass')).toBe(false);
  expect(passes(hidden, 'closed', 'pass')).toBe(false);
  expect(passes(hidden, 'passed', 'pass')).toBe(false);
  expect(passes(hidden, 'hidden', 'pass')).toBe(true);
  expect(passes(item({ hidden: false }), 'hidden', undefined)).toBe(false);
});

test('a card says when a session is on it right now, and stays quiet otherwise', () => {
  expect(cardMeta(item({ agent_state: 'working' }), undefined)).toContain('Claude is on it');
  // `worked` is already implied by the reply count; only the LIVE state earns a word.
  expect(cardMeta(item({ agent_state: 'worked' }), undefined)).not.toContain('Claude');
  expect(cardMeta(item({ agent_state: 'idle' }), undefined)).not.toContain('Claude');
});

test('the live badge sits last, so a font scale truncates it before the verdict', () => {
  const meta = cardMeta(item({ agent_state: 'working', feedback_count: 1 }), 'fail');
  expect(meta.indexOf('Failed')).toBeLessThan(meta.indexOf('Claude is on it'));
});

// --- DR-132: settled rows out of the way -----------------------------------------------------

test('closed rows leave the working queue, and nowhere else', () => {
  const closed = item({ id: 'DR-013', state: 'closed' });

  // The one view they are noise in: "what is left to do".
  expect(passes(closed, 'unreviewed', undefined)).toBe(false);
  expect(passes(closed, 'closed', undefined)).toBe(true);

  // Not excluded from All — a list quietly short by 42 with nothing on screen saying so is
  // DR-116, a row in this same ledger.
  expect(passes(closed, 'all', undefined)).toBe(true);
  // Nor from an explicit selection of a property it HAS: a closed item he failed belongs under
  // Failed. An earlier cut of this hid it, and an existing test caught that.
  expect(passes(closed, 'failed', 'fail')).toBe(true);
  expect(passes(closed, 'passed', 'pass')).toBe(true);
});

test('the Closed view holds nothing but closed rows', () => {
  // Otherwise "show me what is settled" would also show live work, which is the same
  // undifferentiated list DR-132 is about.
  expect(passes(item({ state: 'implemented — verify' }), 'closed', undefined)).toBe(false);
  expect(passes(item({ state: 'open' }), 'closed', undefined)).toBe(false);
});

test('a closed row he came back to IS in Needs reply — settled is not answered', () => {
  // Taking closed rows out of every view nearly re-created DR-134 one state over: a closed row
  // only carries `awaiting_reply` when he commented AFTER a reply, which is him reopening it.
  // Hiding that is the same "lands where he cannot see it" failure, so `needsreply` overrides
  // the exclusion.
  expect(passes(item({ state: 'closed', awaiting_reply: true }), 'needsreply', 'pass')).toBe(true);
  // A settled closed row with nothing waiting stays out of it.
  expect(passes(item({ state: 'closed', awaiting_reply: false }), 'needsreply', 'pass')).toBe(false);
});

// --- DR-134: the two fields are SERVER-derived, so the sheet has to re-ask -------------------

test('recording a verdict re-asks the server, or Needs reply cannot move in that sitting', async () => {
  // Without this, both halves of DR-134's own verify text fail as written: a comment recorded
  // after a Pass does not move the item into Needs reply, because the client still holds the
  // `awaiting_reply: false` it fetched when the sheet opened. He would record a Fail on working
  // code. This shipped unpinned for a round — the review caught that deleting `onRecorded?.()`
  // left all 1059 client tests green.
  const onRecorded = jest.fn();
  const screen = render(
    <ItemCard item={{ ...ITEM, id: 'DR-997' }} shot={null} route="/discover"
              onRecorded={onRecorded} />);
  fireEvent.press(screen.getByText(ITEM.title));
  fireEvent.changeText(await screen.findByPlaceholderText('Comment (optional for Pass and Fail)'),
                       'one more thing');
  fireEvent.press(screen.getByText('Pass'));

  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  // AFTER the record resolves, not before — a refetch that raced the write would read the old
  // state and look like it worked.
  await waitFor(() => expect(onRecorded).toHaveBeenCalled());
});

test('a FAILED record does not re-ask — nothing changed server-side to re-read', async () => {
  const onRecorded = jest.fn();
  jest.mocked(api.recordDevTestFeedback).mockRejectedValueOnce(new Error('offline'));
  const screen = render(
    <ItemCard item={{ ...ITEM, id: 'DR-996' }} shot={null} route="/discover"
              onRecorded={onRecorded} />);
  fireEvent.press(screen.getByText(ITEM.title));
  fireEvent.press(await screen.findByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  expect(onRecorded).not.toHaveBeenCalled();
});
