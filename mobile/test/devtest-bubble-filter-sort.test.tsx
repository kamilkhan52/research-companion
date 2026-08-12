// DR-077 — Kamil: "Add sorting and filtering options to the dev test bubble list... the idea is
// to be easily able to jump back into whatever I was working on and then find the next one to
// work on." Search narrows by id/title; filter narrows by review status (a card's persisted
// pass/fail verdict, not anything the server tracks); sort either keeps the ledger-priority
// sections (default) or flattens the matched set into one browsable list (A–Z / recently
// reviewed).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { DevTestBubble } from '@/components/DevTestBubble';
import { draftKey } from '@/hooks/usePersistedDraft';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn(),
}));

import * as api from '@/api/endpoints';

// Titles are deliberately NOT in alphabetical order matching their array position — the
// fetch/array order (Zulu, Beta, Alpha) differs from the alphabetical order (Alpha, Beta, Zulu),
// so the "A–Z" sort test can actually tell a real sort from a no-op that happens to leave
// already-sorted input looking sorted.
const ITEMS: DevTestItem[] = [
  { id: 'DR-A', state: 'implemented — verify', raised: '2026-08-12', title: 'Zulu widget', how_to_test: '', feedback_count: 0 },
  { id: 'DR-B', state: 'open', raised: '2026-08-12', title: 'Beta gadget', how_to_test: '', feedback_count: 0 },
  // `closed` lands in the collapsed "Everything else" section — its ItemCard never mounts unless
  // that section is expanded, which is exactly the case a bulk (not per-card) verdict read exists
  // to cover.
  { id: 'DR-C', state: 'closed', raised: '2026-08-12', title: 'Alpha thing', how_to_test: '', feedback_count: 0 },
];

async function openBubble() {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Zulu widget')).toBeTruthy());
  return screen;
}

async function seedVerdict(id: string, verdict: 'pass' | 'fail', at: number) {
  await AsyncStorage.setItem(
    draftKey('devtest-item', id),
    JSON.stringify({
      version: 1,
      value: { expanded: false, comment: '', attach: false, verdict, verdictAt: at },
      submitted: true,
      acceptedBaseline: null,
    }),
  );
}

// Several tests below reuse the same three item ids, seeding a fresh verdict before each
// `openBubble()` — but a verdict from an EARLIER test would otherwise linger in the mock
// AsyncStorage store and could accidentally satisfy a later test's assumption that an item is
// unreviewed (e.g. DR-C is expected to have no verdict in some tests, one in others).
afterEach(async () => {
  await AsyncStorage.clear();
});

test('search narrows the list to a matching id or title', async () => {
  const screen = await openBubble();
  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'beta');
  expect(screen.getByText('Beta gadget')).toBeTruthy();
  expect(screen.queryByText('Zulu widget')).toBeNull();
  expect(screen.queryByText('Alpha thing')).toBeNull();
});

// Opus review, PR #387: a persisted search query has no other affordance to notice or clear it
// once typed — the caption below is muted text, easy to miss on a phone.
test('a clear button appears once search text is entered, and empties the field', async () => {
  const screen = await openBubble();
  expect(screen.queryByLabelText('Clear search')).toBeNull();
  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'beta');
  fireEvent.press(screen.getByLabelText('Clear search'));
  expect(screen.getByPlaceholderText('Search by id or title').props.value).toBe('');
  expect(screen.getByText('Zulu widget')).toBeTruthy();
});

test('the "Not reviewed" filter excludes a verdict recorded on an item whose card never mounted', async () => {
  // DR-C sits in the collapsed "Everything else" section, which stays collapsed the whole test —
  // its ItemCard never mounts, so this can only pass if verdict knowledge comes from the bulk
  // storage read on open, not from a mounted card reporting itself (DR-A/DR-B, which always
  // mount, would pass this same assertion either way — the match count is what actually pins it
  // on DR-C specifically).
  await seedVerdict('DR-C', 'pass', 1000);
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Not reviewed'));
  await waitFor(() => expect(screen.getByText('2 of 3 shown')).toBeTruthy());
  expect(screen.getByText('Zulu widget')).toBeTruthy();
  expect(screen.getByText('Beta gadget')).toBeTruthy();

  // Expanding the collapsed section confirms it structurally, not just by count: DR-C is gone
  // from "Everything else" too, because the bulk read already knew about its verdict before its
  // card ever mounted.
  fireEvent.press(screen.getByText(/Everything else/));
  expect(screen.queryByText('Alpha thing')).toBeNull();
});

// Opus review, PR #387: DR-A always mounts (it's in the "To verify" section), so this alone
// doesn't prove the BULK read specifically — the "never mounted" test above does that. This one
// just checks filter membership.
test('the "Reviewed" filter shows only items with a persisted verdict', async () => {
  await seedVerdict('DR-A', 'pass', 1000);
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Reviewed'));
  await waitFor(() => expect(screen.queryByText('Beta gadget')).toBeNull());
  expect(screen.getByText('Zulu widget')).toBeTruthy();
  expect(screen.queryByText('Alpha thing')).toBeNull();
});

test('"Passed" and "Failed" filters split reviewed items by verdict', async () => {
  await seedVerdict('DR-A', 'pass', 1000);
  await seedVerdict('DR-B', 'fail', 2000);
  const screen = await openBubble();

  fireEvent.press(screen.getByLabelText('Passed'));
  await waitFor(() => expect(screen.queryByText('Beta gadget')).toBeNull());
  expect(screen.getByText('Zulu widget')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Failed'));
  await waitFor(() => expect(screen.queryByText('Zulu widget')).toBeNull());
  expect(screen.getByText('Beta gadget')).toBeTruthy();
});

test('a verdict recorded in the current session updates the filter immediately, no reopen needed', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Not reviewed'));
  expect(screen.getByText('Zulu widget')).toBeTruthy();

  fireEvent.press(screen.getByText('Zulu widget'));
  fireEvent.press(screen.getByText('Pass'));
  await waitFor(() => expect(api.recordDevTestFeedback).toHaveBeenCalled());

  // This propagation crosses two components (ItemCard's own draft update -> its
  // onVerdictChange effect -> the PARENT's verdicts state -> filteredItems recompute -> this
  // card unmounting), one hop more indirect than the single-component DR-075 updates elsewhere
  // in this file — CI's shared runners are slow enough (~13x local, from the suite's own total
  // time) that the default 1000ms waitFor budget was observed to fail this specific assertion
  // on CI (twice) while never failing locally. Same generous-timeout precedent as the
  // AsyncStorage round-trips in devtest-bubble-persistence.test.tsx.
  await waitFor(() => expect(screen.queryByText('Zulu widget')).toBeNull(), { timeout: 3000 });
  expect(screen.getByText('Beta gadget')).toBeTruthy();
});

test('"A–Z" sort flattens the sections into one alphabetical list', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('A–Z'));
  // Sections collapse into one "Results" group — the priority section headers disappear.
  await waitFor(() => expect(screen.queryByText(/^To verify/)).toBeNull());
  expect(screen.getByText(/^Results \(3\)/)).toBeTruthy();

  const json = JSON.stringify(screen.toJSON());
  const alpha = json.indexOf('Alpha thing');
  const beta = json.indexOf('Beta gadget');
  const zulu = json.indexOf('Zulu widget');
  expect(alpha).toBeGreaterThan(-1);
  expect(alpha).toBeLessThan(beta);
  expect(beta).toBeLessThan(zulu);
});

// Opus review, PR #387: with only two reviewed items, "most recent first" and "alphabetical"
// are the only two possible orderings — whichever one a test picks, a WRONG implementation
// (alphabetical sort standing in for recency, same coincidence class as the A–Z fixture above)
// can pass it by accident. Three items with recency order (Beta, Alpha, Zulu) that matches
// neither the fetch/array order (Zulu, Beta, Alpha) nor the alphabetical order (Alpha, Beta,
// Zulu) rules both wrong implementations out at once. Revert-verified: swapping the recency
// comparator for `title.localeCompare` reds this test (it didn't before this fix).
test('"Recently reviewed" sort orders reviewed items newest-verdict-first', async () => {
  await seedVerdict('DR-B', 'fail', 9000);
  await seedVerdict('DR-C', 'pass', 5000);
  await seedVerdict('DR-A', 'pass', 1000);
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Reviewed'));
  fireEvent.press(screen.getByLabelText('Recently reviewed'));
  await waitFor(() => expect(screen.getByText('Beta gadget')).toBeTruthy());

  const json = JSON.stringify(screen.toJSON());
  const beta = json.indexOf('Beta gadget');
  const alpha = json.indexOf('Alpha thing');
  const zulu = json.indexOf('Zulu widget');
  expect(beta).toBeGreaterThan(-1);
  expect(beta).toBeLessThan(alpha);
  expect(alpha).toBeLessThan(zulu);
});

// Kamil's 2026-08-12 device screenshot: each bare horizontal ScrollView stretched to claim a
// third of the screen's height (RN ScrollView's base style is `flexGrow: 1`, and the sheet is a
// flex column with spare space), shoving the list to the very bottom. The fix wraps each
// label+chips pair in a plain row View, which defaults to `flexGrow: 0` and hugs its content.
// RNTL computes no real layout, so this pins the structure the fix depends on instead: the
// label and its chips must share a flexDirection-row wrapper whose own style does not grow.
test('each chip row is wrapped in a non-growing row View, label inline with its chips', async () => {
  const screen = await openBubble();
  for (const [testID, label, chip] of [
    ['devtest-filter-toolbar', 'Filter', 'Not reviewed'],
    ['devtest-sort-toolbar', 'Sort', 'Recently reviewed'],
  ] as const) {
    const row = screen.getByTestId(testID);
    const style = StyleSheet.flatten(row.props.style) as { flexDirection?: string; flexGrow?: number };
    expect(style.flexDirection).toBe('row');
    expect(style.flexGrow ?? 0).toBe(0);
    expect(within(row).getByText(label)).toBeTruthy();
    expect(within(row).getByLabelText(chip)).toBeTruthy();
  }
});

test('the search/filter/sort choices survive closing and reopening the sheet', async () => {
  const first = await openBubble();
  fireEvent.press(first.getByLabelText('Not reviewed'));
  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(draftKey('devtest-toolbar'));
    expect(raw).toContain('"filter":"unreviewed"');
  });
  fireEvent.press(first.getByLabelText('Close'));

  const second = await openBubble();
  expect(second.getByLabelText('Not reviewed').props.accessibilityState.selected).toBe(true);
});
