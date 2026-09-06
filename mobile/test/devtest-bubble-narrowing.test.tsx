// DR-116 — Kamil: "Dev test bubble shows 11 of 117. I don't know how to view the rest. The Filter
// is set to All". Nothing was truncated: DR-077's search/filter persist across app launches, so a
// choice made days ago kept narrowing the list while the sheet reported only a NUMBER — never the
// reason, and with no way back. These tests pin the six guards the fix rests on: the caption names
// each narrowing; one tap restores the whole list without touching sort; no matched item stays
// hidden behind the collapsed "Everything else" section, and leaving a narrowed state by ANY of
// its three doors does not re-hide what was on screen; and the selected filter chip is revealed
// once per open — from that open's own measurement, and never in response to the tester's own tap.

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

/** DR-123: the filter and sort chip rows moved behind the header's ⋮, closed on every open. The
 *  count caption and its reset button deliberately did NOT move — see the comment at their usage
 *  site — so they stay reachable without this. */
function openOptions(screen: ReturnType<typeof render>) {
  fireEvent.press(screen.getByTestId('devtest-options-toggle'));
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

  openOptions(screen);
  fireEvent.press(screen.getByLabelText('Failed'));
  await waitFor(() => expect(screen.getByText(/0 of 3 shown/)).toBeTruthy());
  expect(screen.getByText(/narrowed by filter “Failed”/)).toBeTruthy();

  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'beta');
  await waitFor(() => expect(screen.getByText(/narrowed by filter “Failed” and search “beta”/)).toBeTruthy());
});

test('"Show visible" restores every visible item, clearing both filter and search in one tap', async () => {
  const screen = await openBubble();
  openOptions(screen);
  fireEvent.press(screen.getByLabelText('Passed'));
  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'zulu');
  await waitFor(() => expect(screen.queryByText('Beta gadget')).toBeNull());

  fireEvent.press(screen.getByText('Show visible 3'));

  await waitFor(() => expect(screen.getByText('Beta gadget')).toBeTruthy());
  expect(screen.getByText('Zulu widget')).toBeTruthy();
  expect(screen.getByPlaceholderText('Search by id or title').props.value).toBe('');
  expect(screen.getByLabelText('Visible').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('devtest-match-row')).toBeNull();
});

// Sort reorders the matched set; it never hides a row. Resetting it would undo a choice that has
// nothing to do with the complaint, so the reset must leave it exactly where the tester put it.
test('"Show visible" leaves the sort mode alone', async () => {
  const screen = await openBubble();
  openOptions(screen);
  fireEvent.press(screen.getByLabelText('A–Z'));
  fireEvent.press(screen.getByLabelText('Reviewed'));
  await waitFor(() => expect(screen.getByTestId('devtest-match-row')).toBeTruthy());

  fireEvent.press(screen.getByText('Show visible 3'));

  await waitFor(() => expect(screen.getByLabelText('A–Z').props.accessibilityState.selected).toBe(true));
  expect(screen.getByText(/^Results \(3\)/)).toBeTruthy();
});

// Opus review, PR #469: "Everything else" is force-open while narrowed, so LEAVING that state must
// not re-collapse it — the closed cards the filter had put on screen would disappear a frame later,
// a miniature of the reported confusion. All three ways out are covered, because the first pass
// special-cased the button and both other doors still reproduced it (and the All chip is the more
// likely one here — Kamil's complaint is literally about the filter chips).
describe.each([
  ['the "Show visible" button', (s: ReturnType<typeof render>) => fireEvent.press(s.getByText('Show visible 3'))],
  ['the "Visible" chip', (s: ReturnType<typeof render>) => fireEvent.press(s.getByLabelText('Visible'))],
])('leaving a filter via %s', (_label, leave) => {
  test('does not hide the closed items the filter had just put on screen', async () => {
    await seedVerdict('DR-C', 'fail');
    const screen = await openBubble();
    openOptions(screen);
    fireEvent.press(screen.getByLabelText('Failed'));
    await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());

    leave(screen);

    await waitFor(() => expect(screen.getByText('Zulu widget')).toBeTruthy());
    expect(screen.getByText('Alpha thing')).toBeTruthy();
  });
});

test('clearing the search box does not hide the closed items the search had put on screen', async () => {
  const screen = await openBubble();
  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'alpha');
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());

  fireEvent.press(screen.getByLabelText('Clear search'));

  await waitFor(() => expect(screen.getByText('Zulu widget')).toBeTruthy());
  expect(screen.getByText('Alpha thing')).toBeTruthy();
});

// The worst version of the bug, one level down: the caption counts a match that the collapsed
// section is still hiding, so FEWER cards are on screen than the number being read.
test('a match inside "Everything else" is on screen while a filter is active, with no expand tap', async () => {
  await seedVerdict('DR-C', 'fail');
  const screen = await openBubble();

  openOptions(screen);
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
  openOptions(screen);
  return screen;
}

test('a selected off-screen filter chip is scrolled into view when the options menu opens', async () => {
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
    const screen = await openBubble();                     // renders on the default "Visible"
    openOptions(screen);
    expect(screen.getByLabelText('Visible').props.accessibilityState.selected).toBe(true);
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
  openOptions(screen);

  fireEvent.press(screen.getByLabelText('Failed'));
  await waitFor(() => expect(screen.getByLabelText('Failed').props.accessibilityState.selected).toBe(true));
  // The re-measure a selection triggers on device.
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 78, height: 28 } } });

  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});

// The "once per OPEN" reset is the whole mechanism, and it is load-bearing because the chips'
// container returns null while closed — children unmount and every chip lays out again next time.
//
// DR-123 moved the chips into the ⋮ menu, so the container that unmounts them is now the MENU.
// That is what this asserts: the reveal must re-arm on every menu open, not once per sheet open —
// with the chips behind a menu, a token spent on the first open and never reset would leave a
// restored "Failed"/"A–Z" sitting off the right edge for the rest of the session, which is DR-116
// itself.
//
// The reopen deliberately reports a DIFFERENT x (Opus review, PR #469). Keeping the previous
// open's measurements would let the effect path fire from that cache the instant the row
// remounts — before its ScrollView has been laid out natively, which on Android clamps the
// scroll to 0 — and spend the token, so the real measurement arriving a moment later is thrown
// away and the chip stays off-screen. Asserting "nothing yet, then the FRESH offset" is what tells
// a live measurement from a stale one; RNTL computes no layout, so an equal x could not.
test('reopening the options menu reveals the still-active filter chip from a fresh measurement', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openWithPersistedFilter('failed');
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 70, height: 28 } } });
  expectScrolledFilterRow(scrollTo, 320 - space.md);

  openOptions(screen);                                   // close it
  scrollTo.mockClear();
  openOptions(screen);                                   // and open it again
  expect(scrollTo).not.toHaveBeenCalled();               // nothing has been measured THIS open yet

  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 400, y: 0, width: 70, height: 28 } } });
  expectScrolledFilterRow(scrollTo, 400 - space.md);
  scrollTo.mockRestore();
});

// Closing the SHEET must also re-arm it, and it does so through a different path: `menuOpen` is
// reset with everything else this-sitting-is-over, so the next sheet open starts from a closed
// menu with no measurements carried over. Without that reset the menu would come back open — the
// opposite of "everything collapsible should be collapsed by default" — and its reveal token
// would still be spent from the previous sitting.
test('closing the sheet closes the options menu and re-arms the reveal', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openWithPersistedFilter('failed');
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 320, y: 0, width: 70, height: 28 } } });
  expectScrolledFilterRow(scrollTo, 320 - space.md);

  fireEvent.press(screen.getByLabelText('Close'));
  scrollTo.mockClear();
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText(/0 of 3 shown/)).toBeTruthy());
  expect(screen.queryByTestId('devtest-options-menu')).toBeNull();   // closed by default

  openOptions(screen);
  expect(scrollTo).not.toHaveBeenCalled();
  fireEvent(screen.getByLabelText('Failed'), 'layout', { nativeEvent: { layout: { x: 400, y: 0, width: 70, height: 28 } } });
  expectScrolledFilterRow(scrollTo, 400 - space.md);
  scrollTo.mockRestore();
});

test('the default "Visible" chip never triggers a scroll — it is already the leftmost chip', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();
  openOptions(screen);
  fireEvent(screen.getByLabelText('Visible'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 56, height: 28 } } });
  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});
