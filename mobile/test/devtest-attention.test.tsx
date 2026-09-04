/**
 * DR-134 — Kamil: "I made comments on Passed items expecting they'd be seen." They were not.
 *
 * Every other filter in this sheet keys on the VERDICT, and recording a Pass drops the card out
 * of the default "Not reviewed" view — so a comment added afterwards lands somewhere he cannot
 * see, and nothing surfaces it. These pin the two things that fix it: a filter that ignores the
 * verdict, and a card that says when a session is on the item right now.
 */
import { cardMeta, matchesFilter, REVIEW_FILTERS } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

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
