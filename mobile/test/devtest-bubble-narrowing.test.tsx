// DR-116 — Kamil: "Dev test bubble shows 11 of 117. I don't know how to view the rest. The Filter
// is set to All". Nothing was truncated: DR-077's search/filter persist across app launches, so a
// choice made days ago kept narrowing the list while the sheet reported only a NUMBER — never the
// reason, and with no way back. These tests pin the three parts of the fix: the caption names each
// narrowing, one tap restores the whole list, and no matched item stays hidden behind the
// collapsed "Everything else" section while a filter is on.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import { DevTestBubble, narrowingReasons } from '@/components/DevTestBubble';
import { draftKey } from '@/hooks/usePersistedDraft';
import { space } from '@/theme/tokens';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn(),
}));

import * as api from '@/api/endpoints';

// One item per section, so "how many are on screen" and "which section is open" are separable.
// DR-C is `closed`, i.e. "Everything else" — the section that used to swallow a match.
const ITEMS: DevTestItem[] = [
  { id: 'DR-A', state: 'implemented — verify', raised: '2026-09-01', title: 'Zulu widget', how_to_test: '', feedback_count: 0 },
  { id: 'DR-B', state: 'open', raised: '2026-09-01', title: 'Beta gadget', how_to_test: '', feedback_count: 0 },
  { id: 'DR-C', state: 'closed', raised: '2026-09-01', title: 'Alpha thing', how_to_test: '', feedback_count: 0 },
];

async function openBubble() {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Zulu widget')).toBeTruthy());
  return screen;
}

async function seedVerdict(id: string, verdict: 'pass' | 'fail') {
  await AsyncStorage.setItem(
    draftKey('devtest-item', id),
    JSON.stringify({
      version: 1,
      value: { expanded: false, comment: '', attach: false, verdict, verdictAt: 1000 },
      submitted: true,
      acceptedBaseline: null,
    }),
  );
}

afterEach(async () => {
  await AsyncStorage.clear();
});

test('narrowingReasons names the filter and the search in the tester\'s own chip vocabulary', () => {
  expect(narrowingReasons('', 'all')).toEqual([]);
  // Whitespace is not a narrowing — it matches the caption's own `query.trim()` condition, so a
  // stray space must not raise a "narrowed by" claim the list does not actually reflect.
  expect(narrowingReasons('   ', 'all')).toEqual([]);
  expect(narrowingReasons('', 'failed')).toEqual(['filter “Failed”']);
  expect(narrowingReasons(' beta ', 'unreviewed')).toEqual(['filter “Not reviewed”', 'search “beta”']);
});

test('the count caption says WHAT is narrowing the list, not just how many survived', async () => {
  const screen = await openBubble();
  expect(screen.queryByTestId('devtest-match-row')).toBeNull();   // nothing hidden, nothing said

  fireEvent.press(screen.getByLabelText('Failed'));
  await waitFor(() => expect(screen.getByText(/0 of 3 shown/)).toBeTruthy());
  expect(screen.getByText(/narrowed by filter “Failed”/)).toBeTruthy();

  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'beta');
  await waitFor(() => expect(screen.getByText(/narrowed by filter “Failed” and search “beta”/)).toBeTruthy());
});

test('"Show all" restores every item, clearing both the filter and the search in one tap', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Passed'));
  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'zulu');
  await waitFor(() => expect(screen.queryByText('Beta gadget')).toBeNull());

  fireEvent.press(screen.getByText('Show all 3'));

  await waitFor(() => expect(screen.getByText('Beta gadget')).toBeTruthy());
  expect(screen.getByText('Zulu widget')).toBeTruthy();
  expect(screen.getByPlaceholderText('Search by id or title').props.value).toBe('');
  expect(screen.getByLabelText('All').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('devtest-match-row')).toBeNull();
});

// Sort reorders the matched set; it never hides a row. Resetting it would undo a choice that has
// nothing to do with the complaint, so "Show all" must leave it exactly where the tester put it.
test('"Show all" leaves the sort mode alone', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('A–Z'));
  fireEvent.press(screen.getByLabelText('Reviewed'));
  await waitFor(() => expect(screen.getByTestId('devtest-match-row')).toBeTruthy());

  fireEvent.press(screen.getByText('Show all 3'));

  await waitFor(() => expect(screen.getByLabelText('A–Z').props.accessibilityState.selected).toBe(true));
  expect(screen.getByText(/^Results \(3\)/)).toBeTruthy();
});

// Opus review, PR #469: "Everything else" is force-open while narrowed, so clearing the filter
// without also opening it makes cards that were on screen a frame ago disappear — a miniature of
// the reported confusion, produced by the button that exists to end it.
test('"Show all" does not hide the closed items the filter had just put on screen', async () => {
  await seedVerdict('DR-C', 'fail');
  const screen = await openBubble();
  fireEvent.press(screen.getByLabelText('Failed'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());

  fireEvent.press(screen.getByText('Show all 3'));

  await waitFor(() => expect(screen.getByText('Zulu widget')).toBeTruthy());
  expect(screen.getByText('Alpha thing')).toBeTruthy();
});

// The worst version of the bug, one level down: the caption counts a match that the collapsed
// section is still hiding, so FEWER cards are on screen than the number being read.
test('a match inside "Everything else" is on screen while a filter is active, with no expand tap', async () => {
  await seedVerdict('DR-C', 'fail');
  const screen = await openBubble();

  fireEvent.press(screen.getByLabelText('Failed'));

  await waitFor(() => expect(screen.getByText(/1 of 3 shown/)).toBeTruthy());
  expect(screen.getByText('Alpha thing')).toBeTruthy();
  expect(screen.queryByText('Zulu widget')).toBeNull();
});

test('with nothing narrowing the list, "Everything else" is still a collapsed toggle', async () => {
  const screen = await openBubble();
  expect(screen.queryByText('Alpha thing')).toBeNull();
  fireEvent.press(screen.getByText(/Everything else/));
  expect(screen.getByText('Alpha thing')).toBeTruthy();
});

// The chips live in a horizontal ScrollView that opens at offset 0, so an active "Passed"/"Failed"
// chip is off-screen on a phone and every VISIBLE chip looks unselected — which is how an active
// filter reads as "the Filter is set to All". RNTL computes no layout, so the chip's own onLayout
// is fired here to stand in for the real measurement.
//
// The receiver is asserted, not just the arguments (Opus review, PR #469): a prototype spy matches
// ANY of the three ScrollViews in this sheet, and pointing the call at the vertical item list — a
// total no-op on device, since you cannot scroll a vertical list horizontally — otherwise leaves
// every test in this file green.
function expectScrolledFilterRow(scrollTo: jest.SpyInstance, x: number) {
  expect(scrollTo).toHaveBeenCalledWith({ x, animated: false });
  const receiver = (scrollTo.mock.contexts ?? scrollTo.mock.instances)[0] as { props: { horizontal?: boolean } };
  expect(receiver.props.horizontal).toBe(true);
}

async function openWithPersistedFilter(filter: string) {
  await AsyncStorage.setItem(
    draftKey('devtest-toolbar'),
    JSON.stringify({ version: 1, value: { query: '', filter, sort: 'default' }, submitted: false, acceptedBaseline: null }),
  );
  // The persisted filter matches nothing here, so the item list is not the readiness signal —
  // the restored chip selection is. (That empty result is itself the reported situation: a
  // filter from a previous session, still on, with no visible cause.)
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText(/0 of 3 shown/)).toBeTruthy());
  return screen;
}

test('a selected off-screen filter chip is scrolled into view when the sheet opens', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openWithPersistedFilter('failed');
  expect(screen.getByLabelText('Failed').props.accessibilityState.selected).toBe(true);

  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 70, height: 28 } } });
  expectScrolledFilterRow(scrollTo, 320 - space.md);

  // Once per open, and only for the selected chip: an unselected chip laying out later must not
  // drag the row away from the selection the tester is looking at.
  scrollTo.mockClear();
  fireEvent(screen.getByLabelText('Reviewed'), 'layout', { nativeEvent: { layout: { x: 180, y: 0, width: 70, height: 28 } } });
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 70, height: 28 } } });
  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});

// The reverse arrival order: the chip is measured first and the persisted selection lands after.
// The layout callback alone cannot cover it — the chip's layout does not change when the filter
// hydrates, so RN fires no second onLayout and nothing would ever scroll (Opus review, PR #469).
// The toolbar's storage read is held open here to force that order deterministically.
test('the reveal still happens when the chip is measured before the filter is restored', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  let releaseHydration = () => {};
  const held = new Promise<void>((resolve) => { releaseHydration = resolve; });
  const toolbarDraft = JSON.stringify({
    version: 1, value: { query: '', filter: 'failed', sort: 'default' }, submitted: false, acceptedBaseline: null,
  });
  // Swapped by assignment and restored in `finally`, not via `jest.spyOn`: AsyncStorage's own
  // module mock IS a `jest.fn`, so `mockRestore` would leave it returning `undefined` for every
  // later test in this file rather than restoring the store-backed implementation.
  const realGetItem = AsyncStorage.getItem;
  // Serves the toolbar draft only, and only once released. Every other draft key answers `null`
  // (its own default), which is what this component sees on a fresh install anyway.
  (AsyncStorage as { getItem: unknown }).getItem = async (key: string) => {
    if (key !== draftKey('devtest-toolbar')) return null;
    await held;
    return toolbarDraft;
  };
  try {
    const screen = await openBubble();                     // renders on the pre-hydration "All"
    expect(screen.getByLabelText('All').props.accessibilityState.selected).toBe(true);
    fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 70, height: 28 } } });
    expect(scrollTo).not.toHaveBeenCalled();               // nothing is selected there yet

    await act(async () => { releaseHydration(); await Promise.resolve(); });

    await waitFor(() => expect(screen.getByLabelText('Failed').props.accessibilityState.selected).toBe(true));
    expectScrolledFilterRow(scrollTo, 320 - space.md);     // no second layout pass was needed
  } finally {
    (AsyncStorage as { getItem: unknown }).getItem = realGetItem;
    scrollTo.mockRestore();
  }
});

// The tester's own tap must never move the row: the chip he pressed is by definition already on
// screen, and selecting it switches its label to semibold, which changes its measured width and
// re-fires onLayout for the whole row (Opus review, PR #469 — this used to snap the row sideways,
// unanimated, on the first filter tap of each open).
test('tapping a filter chip never scrolls the chip row', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();

  fireEvent.press(screen.getByLabelText('Failed'));
  await waitFor(() => expect(screen.getByLabelText('Failed').props.accessibilityState.selected).toBe(true));
  // The re-measure a selection triggers on device.
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 78, height: 28 } } });

  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});

// The "once per OPEN" reset is the whole mechanism, and it is load-bearing because RN's Modal
// returns null while hidden — children unmount and every chip lays out again on the next open.
test('reopening the sheet reveals the still-active filter chip again', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openWithPersistedFilter('failed');
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 70, height: 28 } } });
  expectScrolledFilterRow(scrollTo, 320 - space.md);

  fireEvent.press(screen.getByLabelText('Close'));
  scrollTo.mockClear();
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText(/0 of 3 shown/)).toBeTruthy());
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 70, height: 28 } } });

  expectScrolledFilterRow(scrollTo, 320 - space.md);
  scrollTo.mockRestore();
});

test('the default "All" chip never triggers a scroll — it is already the leftmost chip', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();
  fireEvent(screen.getByLabelText('All'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 40, height: 28 } } });
  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});
