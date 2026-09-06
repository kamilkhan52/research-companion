// DR-123 — Kamil, from the phone: "Too much top space used by options. Issues and comments space
// is cramped… a lot of the top space is taken by options like filter, sort, how many shown and
// hidden, dispatch. Put these all into a three dot or hamburger menu… Everything collapsible
// should be collapsed by default." Then, as a remark: "Buttons and fonts are too big too. Too
// large margin as well… The buttons for Show all, Dispatch all, Pass, Fail, Remark etc. are too
// big. Use icons where possible and clear. 'Implemented -- verify' is too big. The PR or whatever
// name doesn't need to be always visible. I don't know what Notes here are. Is note a comment? A
// reply? Be clear and consistent."
//
// Four separable claims, one group of tests each: the header is emptied into a ⋮ menu that starts
// closed; the type and the controls shrink without the touch target shrinking with them; the card
// head becomes one line of words instead of five chips; and the sheet speaks ONE vocabulary.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { DevTestBubble, ItemCard, cardMeta, optionsNote, shortState } from '@/components/DevTestBubble';
import { control } from '@/theme/tokens';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/' }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));

// Captured rather than rendered: what this file asserts about the description and the replies is
// the SCALE they are handed, and reaching a resolved fontSize through the real renderer's block
// tree would pin the renderer's internals instead of this component's choice.
const markdownProps: Array<{ text: string; textScale?: number }> = [];
jest.mock('@/components/Markdown', () => ({
  Markdown: (props: { text: string; textScale?: number }) => {
    markdownProps.push(props);
    return null;
  },
  // DR-128's preview renderer. It takes no scale — it inherits the caption it is dropped
  // into — so it is stubbed to its text, which keeps the prose findable for the assertions
  // below that read the card as a whole.
  MarkdownRuns: (props: { text: string }) => props.text,
}));

jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  createDevTestItem: jest.fn(),
  dispatchToClaude: jest.fn().mockResolvedValue({
    dispatch: { id: 'd1', model: 'sonnet', item_id: null, log: '/x', started_at: '' },
  }),
  getDispatchStatus: jest.fn().mockResolvedValue({ dispatch: null }),
  getDeployState: jest.fn().mockResolvedValue({ deploy: null }),
}));

import * as api from '@/api/endpoints';

const ITEMS: DevTestItem[] = [
  { id: 'DR-A', state: 'implemented — verify', raised: '2026-09-01', title: 'Zulu widget',
    how_to_test: 'Open **the** bubble', feedback_count: 2, response_count: 1 },
  { id: 'DR-B', state: 'open', raised: '2026-09-01', title: 'Beta gadget',
    how_to_test: '', feedback_count: 0 },
];

async function openBubble() {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Zulu widget')).toBeTruthy());
  return screen;
}

beforeEach(() => {
  markdownProps.length = 0;
});

// --- the header empties into a menu that starts closed ----------------------------------------

test('filter, sort and dispatch are absent from the header until the ⋮ is opened', async () => {
  const screen = await openBubble();
  // Nothing collapsible is open on arrival — his "everything collapsible should be collapsed by
  // default", applied to the thing that was costing the most room.
  expect(screen.queryByTestId('devtest-options-menu')).toBeNull();
  expect(screen.queryByTestId('devtest-filter-toolbar')).toBeNull();
  expect(screen.queryByTestId('devtest-sort-toolbar')).toBeNull();
  expect(screen.queryByTestId('devtest-dispatch-all')).toBeNull();

  fireEvent.press(screen.getByTestId('devtest-options-toggle'));

  expect(screen.getByTestId('devtest-options-menu')).toBeTruthy();
  expect(screen.getByTestId('devtest-filter-toolbar')).toBeTruthy();
  expect(screen.getByTestId('devtest-sort-toolbar')).toBeTruthy();
  expect(screen.getByTestId('devtest-dispatch-all')).toBeTruthy();
  expect(screen.getByLabelText('Not reviewed')).toBeTruthy();
  expect(screen.getByLabelText('Last activity')).toBeTruthy();
});

test('the ⋮ closes again on a second tap', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByTestId('devtest-options-toggle'));
  fireEvent.press(screen.getByTestId('devtest-options-toggle'));
  expect(screen.queryByTestId('devtest-options-menu')).toBeNull();
});

// The one thing putting the chips behind a menu could plausibly break. DR-116 was filed because a
// filter restored from a previous session was narrowing the list with nothing on screen saying so;
// hiding the chips is exactly the move that could bring that back, so the ⋮ itself has to carry
// the fact — and the count caption stays OUT of the menu for the same reason.
test('a narrowing is announced without opening the menu', async () => {
  const screen = await openBubble();
  expect(screen.getByLabelText('Options — filter, sort and dispatch')).toBeTruthy();
  expect(screen.queryByTestId('devtest-match-row')).toBeNull();

  fireEvent.changeText(screen.getByPlaceholderText('Search by id or title'), 'zulu');

  await waitFor(() => expect(screen.getByTestId('devtest-match-row')).toBeTruthy());
  expect(screen.getByText(/narrowed by search “zulu”/)).toBeTruthy();
  expect(screen.getByLabelText(/A filter or search is narrowing the list/)).toBeTruthy();
});

// The harder half of the same guarantee, and the one that nearly shipped broken. Sort narrows
// NOTHING, so it raises no count caption by design — which meant that once the chips went behind
// a menu, a persisted "Recently reviewed" was the only toolbar choice with no trace on screen at
// all. DR-118's own ledger row predicted exactly this: "nothing on screen would have explained
// the order." The ⋮ therefore announces a non-default sort as well as a narrowing, while the
// caption still keys on narrowing alone (Opus review, PR #479).
test('a non-default sort is announced by the ⋮, without raising a "narrowed by" caption', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByTestId('devtest-options-toggle'));
  fireEvent.press(screen.getByLabelText('Recently reviewed'));

  await waitFor(() => expect(
    screen.getByLabelText(/Sorted by Recently reviewed\./)).toBeTruthy());
  // …and it is still not a narrowing: nothing is hidden, so nothing claims anything is.
  expect(screen.queryByTestId('devtest-match-row')).toBeNull();
});

test('the ⋮ says nothing while every option is at its default', async () => {
  const screen = await openBubble();
  expect(screen.getByLabelText('Options — filter, sort and dispatch')).toBeTruthy();
});

test('optionsNote covers narrowing, hidden items, sorting, and defaults', () => {
  expect(optionsNote([], 'default')).toBe('');
  expect(optionsNote([], 'default', 1)).toBe('1 item is parked in Hidden.');
  expect(optionsNote([], 'default', 2)).toBe('2 items are parked in Hidden.');
  expect(optionsNote([], 'az')).toBe('Sorted by A–Z.');
  expect(optionsNote(['filter “Failed”'], 'default'))
    .toBe('A filter or search is narrowing the list.');
  expect(optionsNote(['filter “Failed”'], 'activity'))
    .toBe('A filter or search is narrowing the list. Sorted by Last activity.');
});

test('Dispatch all still works from inside the menu, and closes it', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByTestId('devtest-options-toggle'));
  fireEvent.press(screen.getByText('Dispatch all'));
  await waitFor(() => expect(api.dispatchToClaude)
    .toHaveBeenCalledWith('sonnet', undefined, false));
  await waitFor(() => expect(screen.queryByTestId('devtest-options-menu')).toBeNull());
});

// --- smaller controls, same touch target -------------------------------------------------------

// `control.minTouch` is the floor the density tokens state outright ("Density may tighten rhythm,
// but it must never make an interactive control harder to hit"), and shrinking a 50px pill to 32
// is precisely the change that would cross it.
//
// This asserts the LAID-OUT box, not a hitSlop. The first version of this change used slop and
// this test asserted `height + 2 * slop >= minTouch` — arithmetic on two props, true whatever the
// app renders. It was also wrong: RN clips a touch area to the parent's bounds, and every row
// these pills sit in hugs its children's height, so the slop bought nothing (Opus review, PR
// #479). The target is now a real element, so the test can measure a real element: the pressable
// is at least the floor tall, and the pill inside it is genuinely smaller.
function flatten(node: { props: { style?: unknown } }) {
  const style = node.props.style;
  return StyleSheet.flatten(
    typeof style === 'function' ? (style as (s: object) => unknown)({ pressed: false }) : style,
  ) as { height?: number; minHeight?: number };
}

test('the compact buttons keep a full-size touch target', async () => {
  const screen = render(
    <ItemCard item={ITEMS[0]} shot={null} route="/" startExpanded dispatchModel="sonnet" />);
  for (const label of ['Pass', 'Fail', 'Comment']) {
    const pressable = await screen.findByRole('button', { name: label });
    const target = flatten(pressable);
    expect(target.minHeight ?? target.height).toBeGreaterThanOrEqual(control.minTouch);
    // …and it is a real box rather than a hitSlop, which RN would clip to the row above it.
    expect(pressable.props.hitSlop).toBeUndefined();

    // The visible pill really did shrink — otherwise "the buttons are too big" is unaddressed
    // and this test would be satisfied by simply not changing anything.
    const pill = flatten(pressable.children[0] as { props: { style?: unknown } });
    expect(pill.minHeight ?? pill.height).toBeLessThan(control.minTouch);
  }
});

test('the header icons are full-size targets too, and are spaced apart', async () => {
  const screen = await openBubble();
  for (const label of ['New issue', 'Close']) {
    const box = flatten(screen.getByLabelText(label));
    expect(box.height).toBeGreaterThanOrEqual(control.minTouch);
  }
  const box = flatten(screen.getByTestId('devtest-options-toggle'));
  expect(box.height).toBeGreaterThanOrEqual(control.minTouch);
  // Edge to edge, IconButton's own hitSlop regions overlap inside the row, and RN hands an
  // overlap to the LATER sibling — which is Close, which also drops the DR-063 "Just added" pin.
  // A near-miss on ⋮ would have dismissed the sheet and discarded a just-filed item.
  const actions = flatten(screen.getByTestId('devtest-header-actions')) as { gap?: number };
  expect(actions.gap).toBeGreaterThan(0);
});

test('the description and the replies are rendered below their normal reading size', async () => {
  const screen = render(<ItemCard item={ITEMS[0]} shot={null} route="/" startExpanded />);
  fireEvent.press(screen.getByTestId('devtest-item-details'));
  await waitFor(() => expect(markdownProps.length).toBeGreaterThan(0));
  const description = markdownProps.find((p) => p.text === 'Open **the** bubble');
  expect(description).toBeTruthy();
  expect(description!.textScale).toBeLessThan(1);
});

// --- the card head is one line of words --------------------------------------------------------

test('shortState abbreviates the ledger states and passes an unknown one through', () => {
  expect(shortState('implemented — verify')).toBe('Verify');
  expect(shortState('new — untriaged')).toBe('New');
  expect(shortState('open')).toBe('Open');
  // The ledger may grow a state; showing it verbatim is the honest failure, not mangling it.
  expect(shortState('escalated — pending Kamil')).toBe('escalated — pending Kamil');
});

test('cardMeta states only what is true, and leads with the verdict', () => {
  expect(cardMeta(ITEMS[1], undefined)).toBe('Open');
  expect(cardMeta(ITEMS[0], undefined)).toBe('Verify · 2 from you · 1 reply');
  expect(cardMeta({ ...ITEMS[0], response_count: 2 }, undefined))
    .toBe('Verify · 2 from you · 2 replies');
  // The verdict FIRST, because the line is bounded and whatever is last is what an OS font scale
  // truncates — and the verdict is the token DR-075 exists to keep visible.
  expect(cardMeta(ITEMS[0], 'fail')).toBe('Failed · Verify · 2 from you · 1 reply');
  expect(cardMeta(ITEMS[1], 'pass')).toBe('Passed · Open');
});

test('the full state still reaches a screen reader, short as it reads on screen', () => {
  const screen = render(<ItemCard item={ITEMS[0]} shot={null} route="/" />);
  expect(screen.getByText(/^Verify · /)).toBeTruthy();
  expect(screen.queryByText(/implemented — verify/)).toBeNull();
  expect(screen.getByLabelText(/DR-A: Zulu widget\. implemented — verify\./)).toBeTruthy();
});

// --- one vocabulary ----------------------------------------------------------------------------

// "Note" was the word doing two jobs: the chip counted only HIS entries, the agent's answers were
// counted separately as replies, and the button labelled "Show earlier notes" opened both. The
// word is gone rather than redefined — a third definition of an ambiguous word is not clarity.
test('the sheet never says "note", "remark" or "agent" to him', async () => {
  const screen = render(
    <ItemCard item={ITEMS[0]} shot={null} route="/" startExpanded dispatchModel="sonnet" />);
  await screen.findByText('Show conversation');
  const rendered = JSON.stringify(screen.toJSON());
  for (const banned of ['note', 'Note', 'remark', 'Remark', 'Agent']) {
    expect(rendered).not.toContain(banned);
  }
  expect(screen.getByText('Comment')).toBeTruthy();
});
