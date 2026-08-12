// DR-077 — Kamil: "Add sorting and filtering options to the dev test bubble list... the idea is
// to be easily able to jump back into whatever I was working on and then find the next one to
// work on." Search narrows by id/title; filter narrows by review status (a card's persisted
// pass/fail verdict, not anything the server tracks); sort either keeps the ledger-priority
// sections (default) or flattens the matched set into one browsable list (A–Z / recently
// reviewed).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

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

test('search narrows the list to a matching id or title', async () => {
  const screen = await openBubble();
  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'beta');
  expect(screen.getByText('Beta gadget')).toBeTruthy();
  expect(screen.queryByText('Zulu widget')).toBeNull();
  expect(screen.queryByText('Alpha thing')).toBeNull();
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

test('the "Reviewed" filter shows only items with a persisted verdict, seeded in bulk on open', async () => {
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

  await waitFor(() => expect(screen.queryByText('Zulu widget')).toBeNull());
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

test('"Recently reviewed" sort orders reviewed items newest-verdict-first', async () => {
  await seedVerdict('DR-A', 'pass', 1000);
  await seedVerdict('DR-B', 'fail', 5000);
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Reviewed'));
  fireEvent.press(screen.getByLabelText('Recently reviewed'));
  await waitFor(() => expect(screen.getByText('Beta gadget')).toBeTruthy());
  expect(screen.queryByText('Alpha thing')).toBeNull();

  const json = JSON.stringify(screen.toJSON());
  const zulu = json.indexOf('Zulu widget');
  const beta = json.indexOf('Beta gadget');
  // DR-B's verdict (5000) is newer than DR-A's (1000), so it sorts first.
  expect(beta).toBeGreaterThan(-1);
  expect(beta).toBeLessThan(zulu);
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
