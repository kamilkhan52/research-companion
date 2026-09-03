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

import { ItemCard, cardMeta, shortState } from '@/components/DevTestBubble';
import { DevTestBubble } from '@/components/DevTestBubble';
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

test('Dispatch all still works from inside the menu, and closes it', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByTestId('devtest-options-toggle'));
  fireEvent.press(screen.getByText('Dispatch all'));
  await waitFor(() => expect(api.dispatchToClaude)
    .toHaveBeenCalledWith('sonnet', undefined, false));
  await waitFor(() => expect(screen.queryByTestId('devtest-options-menu')).toBeNull());
});

// --- smaller controls, same touch target -------------------------------------------------------

// `control.minTouch` is the floor the density tokens state outright ("it must never make an
// interactive control harder to hit"), and shrinking a 50px pill to 32 is precisely the change
// that would cross it. The hitSlop is derived from that constant rather than eyeballed, so this
// asserts the property — visible pill + slop on both sides ≥ the floor — not the two numbers.
test('the compact buttons keep a full-size touch target', async () => {
  const screen = render(
    <ItemCard item={ITEMS[0]} shot={null} route="/" startExpanded dispatchModel="sonnet" />);
  for (const label of ['Pass', 'Fail', 'Comment']) {
    const pressable = await screen.findByRole('button', { name: label });
    const style = StyleSheet.flatten(
      typeof pressable.props.style === 'function'
        ? pressable.props.style({ pressed: false })
        : pressable.props.style,
    ) as { height?: number };
    const slop = pressable.props.hitSlop as number;
    expect(style.height).toBeLessThan(control.minTouch);          // it really did shrink
    expect(style.height! + 2 * slop).toBeGreaterThanOrEqual(control.minTouch);
  }
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

test('cardMeta states only what is true, in one line', () => {
  expect(cardMeta(ITEMS[1], undefined)).toBe('Open');
  expect(cardMeta(ITEMS[0], undefined)).toBe('Verify · 2 from you · 1 reply');
  expect(cardMeta(ITEMS[0], 'fail')).toBe('Verify · 2 from you · 1 reply · Failed');
  expect(cardMeta({ ...ITEMS[0], response_count: 2 }, undefined))
    .toBe('Verify · 2 from you · 2 replies');
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
