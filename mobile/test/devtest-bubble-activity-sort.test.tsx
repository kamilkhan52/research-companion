// DR-118 — Kamil: "Sort by last activity in dev test bubble… I usually want to just find the last
// item I opened or dispatched or was last worked on by Claude."
//
// The three signals live on two sides: an agent reply and a dispatch are server facts (the item's
// `last_activity`), while "the last item I OPENED" never leaves the phone — the card's persisted
// draft is the only record that it was ever expanded. So the sort is a max of the two, and these
// tests pin each half, their combination, and the card note that says which one won.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import {
  DevTestBubble, activityAt, activityNote, loadLocalItemState,
} from '@/components/DevTestBubble';
import { draftKey } from '@/hooks/usePersistedDraft';
import { space } from '@/theme/tokens';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn(),
}));

import * as api from '@/api/endpoints';

const NOW = 1_800_000_000_000;          // fixed "now" in ms; all ages below are relative to it
const secondsAgo = (s: number) => (NOW - s * 1000) / 1000;   // → server epoch SECONDS

// Three items whose activity order (Zulu, Alpha, Beta) matches neither the fetch order
// (Zulu, Beta, Alpha) nor the alphabetical order (Alpha, Beta, Zulu) — the same discipline the
// DR-077 recency test settled on, so an implementation that quietly sorts by title or not at all
// cannot pass by coincidence.
const ITEMS: DevTestItem[] = [
  { id: 'DR-A', state: 'implemented — verify', raised: '2026-08-12', title: 'Zulu widget',
    how_to_test: '', feedback_count: 0, last_activity: secondsAgo(600), last_activity_kind: 'claude' },
  { id: 'DR-B', state: 'open', raised: '2026-08-12', title: 'Beta gadget',
    how_to_test: '', feedback_count: 0, last_activity: secondsAgo(86_400), last_activity_kind: 'you' },
  // `closed` lands in the collapsed "Everything else" section under the default sort — but the
  // activity sort flattens the sections, so it is in play like any other row.
  { id: 'DR-C', state: 'closed', raised: '2026-08-12', title: 'Alpha thing',
    how_to_test: '', feedback_count: 0, last_activity: secondsAgo(3_600), last_activity_kind: 'dispatch' },
];

async function seedDraft(id: string, value: Record<string, unknown>) {
  await AsyncStorage.setItem(
    draftKey('devtest-item', id),
    JSON.stringify({
      version: 1,
      value: { expanded: false, comment: '', attach: false, ...value },
      submitted: true,
      acceptedBaseline: null,
    }),
  );
}

async function openBubble(items: DevTestItem[] = ITEMS) {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Zulu widget')).toBeTruthy());
  return screen;
}

/** Rendered top-to-bottom order of the three fixture titles. */
function order(screen: ReturnType<typeof render>): string[] {
  const json = JSON.stringify(screen.toJSON());
  return ['Zulu widget', 'Beta gadget', 'Alpha thing']
    .map((title) => [title, json.indexOf(title)] as const)
    .filter(([, at]) => at > -1)
    .sort((a, b) => a[1] - b[1])
    .map(([title]) => title);
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

test('"Last activity" orders the whole matched set newest-first from the server timestamps', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Last activity'));
  await waitFor(() => expect(screen.queryByText(/^To verify/)).toBeNull());
  expect(screen.getByText(/^Results \(3\)/)).toBeTruthy();
  expect(order(screen)).toEqual(['Zulu widget', 'Alpha thing', 'Beta gadget']);
});

test('a card this phone opened counts as activity, even though the server never hears about it', async () => {
  // DR-B is the OLDEST by the server's reckoning (a day). Opening its card five minutes ago is
  // the freshest thing that has happened to anything here, so it must lead — and this can only
  // come from the local draft: no server field changed.
  await seedDraft('DR-B', { openedAt: NOW - 5 * 60 * 1000 });
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Last activity'));
  await waitFor(() => expect(screen.getByText(/^Results \(3\)/)).toBeTruthy());
  expect(order(screen)).toEqual(['Beta gadget', 'Zulu widget', 'Alpha thing']);
});

test('a local verdict older than the item\'s server activity does not drag it forward', async () => {
  // The max, not the local value alone: DR-C was dispatched an hour ago and passed a week ago,
  // so it stays where the dispatch puts it rather than sinking to the week-old verdict.
  await seedDraft('DR-C', { verdict: 'pass', verdictAt: NOW - 7 * 86_400 * 1000 });
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Last activity'));
  await waitFor(() => expect(screen.getByText(/^Results \(3\)/)).toBeTruthy());
  expect(order(screen)).toEqual(['Zulu widget', 'Alpha thing', 'Beta gadget']);
});

test('each card says what the timestamp it was sorted by refers to', async () => {
  await seedDraft('DR-B', { openedAt: NOW - 5 * 60 * 1000 });
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Last activity'));
  await waitFor(() => expect(screen.getByText(/^Results \(3\)/)).toBeTruthy());
  expect(screen.getByText('You opened it · 5 min ago')).toBeTruthy();
  expect(screen.getByText('Claude replied · 10 min ago')).toBeTruthy();
  expect(screen.getByText('Dispatched to Claude · 1h ago')).toBeTruthy();
});

test('the note appears only under the sort it explains', async () => {
  const screen = await openBubble();
  expect(screen.queryByText(/Claude replied/)).toBeNull();
  fireEvent.press(screen.getByLabelText('Last activity'));
  await waitFor(() => expect(screen.getByText(/Claude replied/)).toBeTruthy());
  fireEvent.press(screen.getByLabelText('A–Z'));
  await waitFor(() => expect(screen.queryByText(/Claude replied/)).toBeNull());
});

test('an item nothing has ever happened to sorts below every item something has', async () => {
  const quiet: DevTestItem = {
    id: 'DR-D', state: 'open', raised: '2026-08-12', title: 'Quiet row',
    how_to_test: '', feedback_count: 0, last_activity: null, last_activity_kind: null,
  };
  const screen = await openBubble([quiet, ...ITEMS]);
  fireEvent.press(screen.getByLabelText('Last activity'));
  await waitFor(() => expect(screen.getByText(/^Results \(4\)/)).toBeTruthy());
  const json = JSON.stringify(screen.toJSON());
  expect(json.indexOf('Quiet row')).toBeGreaterThan(json.indexOf('Beta gadget'));
});

test('expanding a card stamps the visit, and leaving a verdict does not erase it', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByText('Zulu widget'));
  await waitFor(async () => {
    expect((await loadLocalItemState())['DR-A']?.openedAt).toBe(NOW);
  }, { timeout: 3000 });

  // The verdict path rewrites the whole draft object; DR-118's stamp has to survive that, or a
  // pass would make the item look untouched to the very sort that should surface it.
  fireEvent.press(screen.getByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());
  await waitFor(async () => {
    const local = (await loadLocalItemState())['DR-A'];
    expect(local?.verdict?.verdict).toBe('pass');
    expect(local?.openedAt).toBe(NOW);
  }, { timeout: 3000 });
});

test('collapsing a card does not restamp it', async () => {
  // Otherwise "when did I last open this" would really mean "when did I last touch it", and the
  // tap that closes a card would keep it pinned to the top of the list.
  await seedDraft('DR-A', { expanded: true, openedAt: NOW - 60 * 60 * 1000 });
  const screen = await openBubble();
  await waitFor(() => expect(screen.getByText('Pass')).toBeTruthy());
  fireEvent.press(screen.getByText('Zulu widget'));
  await waitFor(() => expect(screen.queryByText('Pass')).toBeNull());
  // Wait for the COLLAPSE to reach storage before reading the stamp back. Asserting the stamp
  // alone would pass on the very first poll, against the seeded value, whether or not the
  // pending write was about to overwrite it — which is exactly what a restamping implementation
  // does (checked: without this the test stays green with the guard reverted).
  await waitFor(async () => {
    expect(await AsyncStorage.getItem(draftKey('devtest-item', 'DR-A')))
      .toContain('"expanded":false');
  }, { timeout: 3000 });
  expect((await loadLocalItemState())['DR-A']?.openedAt).toBe(NOW - 60 * 60 * 1000);
});

test('the list does not re-sort under the finger that opened a card', async () => {
  // Expanding IS activity, so a live activity map would slide the card away mid-read. The stamp
  // is taken now and honoured on the NEXT open of the sheet.
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Last activity'));
  await waitFor(() => expect(screen.getByText(/^Results \(3\)/)).toBeTruthy());
  fireEvent.press(screen.getByText('Beta gadget'));            // the last row
  await waitFor(() => expect(screen.getByText('Pass')).toBeTruthy());
  expect(order(screen)).toEqual(['Zulu widget', 'Alpha thing', 'Beta gadget']);

  // Both persisted writes are debounced, and the reopened sheet reads them from storage — so
  // wait for the bytes, not for a duration (the DR-077 reopen test's precedent).
  await waitFor(async () => {
    expect(await AsyncStorage.getItem(draftKey('devtest-toolbar'))).toContain('"sort":"activity"');
    expect((await loadLocalItemState())['DR-B']?.openedAt).toBe(NOW);
  }, { timeout: 3000 });
  fireEvent.press(screen.getByLabelText('Close'));

  const second = await openBubble();
  await waitFor(() => expect(second.getByText(/^Results \(3\)/)).toBeTruthy());
  expect(order(second)[0]).toBe('Beta gadget');
});

// --- the sort row is now wide enough to hide its own selection (Opus review, PR #471) ---------
//
// DR-116 was filed because a selected FILTER chip sat off-screen in a row that opens at offset 0,
// so every visible chip looked unselected. A fourth sort chip pushes the sort row past a phone's
// width too — and unlike the filter row it has no caption naming it (sort hides nothing, so it is
// deliberately excluded from `narrowingReasons`), which makes an invisible selection there strictly
// harder to diagnose. The DR-116 reveal is now shared by both rows; these pin the sort half.

async function openWithPersistedSort(sort: string) {
  await AsyncStorage.setItem(
    draftKey('devtest-toolbar'),
    JSON.stringify({ version: 1, value: { query: '', filter: 'all', sort }, submitted: false, acceptedBaseline: null }),
  );
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByLabelText('A–Z').props.accessibilityState.selected).toBe(true));
  return screen;
}

/** The receiver matters, not just the arguments (Opus review, PR #469): a prototype spy matches
 *  any of the sheet's ScrollViews, and a call aimed at the vertical item list — a no-op on device
 *  — would otherwise satisfy every assertion here. The row is named by testID rather than merely
 *  checked for `horizontal` (Opus review, PR #471): there are two horizontal rows now, so "some
 *  horizontal row scrolled" would stop being the assertion this means to make. */
function expectScrolledChipRow(scrollTo: jest.SpyInstance, x: number) {
  expect(scrollTo).toHaveBeenCalledWith({ x, animated: false });
  const receiver = (scrollTo.mock.contexts ?? scrollTo.mock.instances)[0] as {
    props: { horizontal?: boolean; testID?: string };
  };
  expect(receiver.props.horizontal).toBe(true);
  expect(receiver.props.testID).toBe('devtest-sort-chips');
}

test('a selected off-screen SORT chip is scrolled into view when the sheet opens', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openWithPersistedSort('az');
  fireEvent(screen.getByLabelText('A–Z'), 'layout', { nativeEvent: { layout: { x: 420, y: 0, width: 52, height: 28 } } });
  expectScrolledChipRow(scrollTo, 420 - space.md);

  // Once per open, and only for the selection: another chip measuring later must not drag the row.
  scrollTo.mockClear();
  fireEvent(screen.getByLabelText('Last activity'), 'layout', { nativeEvent: { layout: { x: 100, y: 0, width: 126, height: 28 } } });
  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});

test('tapping a sort chip never scrolls the sort row', async () => {
  // Selecting a chip switches its label to semibold, which re-measures the row — the bug that
  // snapped the filter row sideways under the finger in PR #469.
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('A–Z'));
  await waitFor(() => expect(screen.getByLabelText('A–Z').props.accessibilityState.selected).toBe(true));
  fireEvent(screen.getByLabelText('A–Z'), 'layout', { nativeEvent: { layout: { x: 420, y: 0, width: 58, height: 28 } } });
  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});

test('the default "Priority" chip never triggers a scroll — it is already leftmost', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();
  fireEvent(screen.getByLabelText('Priority'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 89, height: 28 } } });
  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});

test('reopening the sheet reveals the still-active sort chip from a FRESH measurement', async () => {
  // Keeping the previous open's measurement would fire the effect path before this open's
  // ScrollView has been laid out natively — which on Android clamps the scroll to 0 — and spend
  // the once-per-open token, so the real measurement arriving after is discarded (PR #469).
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openWithPersistedSort('az');
  fireEvent(screen.getByLabelText('A–Z'), 'layout', { nativeEvent: { layout: { x: 420, y: 0, width: 52, height: 28 } } });
  expectScrolledChipRow(scrollTo, 420 - space.md);

  fireEvent.press(screen.getByLabelText('Close'));
  scrollTo.mockClear();
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByLabelText('A–Z').props.accessibilityState.selected).toBe(true));
  expect(scrollTo).not.toHaveBeenCalled();          // nothing measured THIS open yet
  fireEvent(screen.getByLabelText('A–Z'), 'layout', { nativeEvent: { layout: { x: 480, y: 0, width: 52, height: 28 } } });
  expectScrolledChipRow(scrollTo, 480 - space.md);
  scrollTo.mockRestore();
});

// --- the two pure helpers, directly ----------------------------------------------------------

test('activityAt takes the newest of the server and local timestamps', () => {
  const item = { ...ITEMS[1] };                                 // server: a day ago
  expect(activityAt(item, undefined)).toBe(NOW - 86_400 * 1000);
  expect(activityAt(item, { openedAt: NOW - 1000 })).toBe(NOW - 1000);
  expect(activityAt(item, { verdict: { verdict: 'pass', at: NOW - 2000 } })).toBe(NOW - 2000);
  // Server seconds vs local milliseconds: the conversion is the whole reason this can go wrong,
  // and getting it backwards would put every server timestamp in 1970 (or the year 57000).
  expect(activityAt({ ...item, last_activity: secondsAgo(0) }, undefined)).toBe(NOW);
  expect(activityAt({ ...item, last_activity: null }, undefined)).toBe(0);
});

test('activityNote names the winner, not merely the server kind', () => {
  const claude = ITEMS[0];                                      // server: Claude, 10 min ago
  expect(activityNote(claude, undefined)).toBe('Claude replied · 10 min ago');
  expect(activityNote(claude, { openedAt: NOW - 120_000 })).toBe('You opened it · 2 min ago');
  // …and an OLDER local open must not steal the label from the newer server event.
  expect(activityNote(claude, { openedAt: NOW - 3_600_000 })).toBe('Claude replied · 10 min ago');
  expect(activityNote({ ...claude, last_activity: null, last_activity_kind: null }, undefined))
    .toBe('');
  expect(activityNote({ ...claude, last_activity_kind: 'raised' }, undefined))
    .toBe('You raised it · 10 min ago');
});
