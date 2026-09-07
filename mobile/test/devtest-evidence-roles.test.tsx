// DR-131 — Kamil, 2026-09-03: "Dev test items (descriptions, replies) are sometimes too verbose
// and may be redundant… Keep them concise so I can actually read very briefly the issue, the fix,
// and how to verify." His rule: the description describes the ISSUE; the replies describe what was
// DONE. The evidence cell carries all three at once — median 1008 characters, longest 6581 — so
// the instruction he opens a card FOR was arriving last, behind the diagnosis.
//
// The card now puts "what to test" on its own, above the diagnosis and outside the details
// toggle, and stops repeating it inside the details.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { DevTestBubble } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  createDevTestItem: jest.fn(),
}));

import * as api from '@/api/endpoints';

const BACKGROUND =
  'Provisional id `NEW-1788518578`, route `/paper/flint`.\n\n'
  + '**Built in [#502](https://github.com/kamilkhan52/research-companion/pull/502):** the pass '
  + 'now leaves only a small status icon beside the paper actions.';
const VERIFY = 'start a pass from the offer, then confirm Stop still works.';

function itemWith(extra: Partial<DevTestItem>): DevTestItem {
  return {
    id: 'DR-A', state: 'implemented — verify', raised: '2026-09-06', title: 'Alpha thing',
    how_to_test: `${BACKGROUND} **Verify:** ${VERIFY}`, feedback_count: 0, ...extra,
  };
}

beforeEach(() => jest.clearAllMocks());

async function openCard(item: DevTestItem) {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: [item] });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to leave a pass/i));
  return screen;
}

test('what to test stands on its own, without expanding the details', async () => {
  const screen = await openCard(itemWith({ background: BACKGROUND, verify: VERIFY }));
  // The instruction is on screen BEFORE anything is expanded — that is the whole point, so
  // assert it against the collapsed card rather than after opening details.
  expect(screen.queryByTestId('devtest-item-details-body')).toBeNull();
  const block = screen.getByTestId('devtest-item-verify');
  expect(block).toBeTruthy();
  screen.getByText('WHAT TO TEST');
  screen.getByText(/confirm Stop still works/);
});

test('the details carry the diagnosis and stop repeating the instruction', async () => {
  const screen = await openCard(itemWith({ background: BACKGROUND, verify: VERIFY }));
  fireEvent.press(screen.getByTestId('devtest-item-details'));
  const body = screen.getByTestId('devtest-item-details-body');
  // The diagnosis is here...
  expect(body).toBeTruthy();
  screen.getByText(/leaves only a small status icon/);
  // ...and the verify text appears exactly once on the whole card, in its own block. The
  // redundancy Kamil named is what this asserts against: rendering the raw cell in the details
  // would put the same sentence on screen twice.
  expect(screen.getAllByText(/confirm Stop still works/)).toHaveLength(1);
});

test('a row with no verify section shows no empty instruction block', async () => {
  // Most older rows predate the convention. Inventing an instruction for them would be worse
  // than admitting there is not one.
  const screen = await openCard(itemWith({
    how_to_test: BACKGROUND, background: BACKGROUND, verify: null,
  }));
  expect(screen.queryByTestId('devtest-item-verify')).toBeNull();
  expect(screen.queryByText('WHAT TO TEST')).toBeNull();
});

test('an older dev backend without the split still renders the whole cell', async () => {
  // `background`/`verify` are absent from a server that predates this change. The card must
  // behave exactly as it did before rather than rendering an empty details body.
  const raw = itemWith({});
  delete (raw as Partial<DevTestItem>).background;
  delete (raw as Partial<DevTestItem>).verify;
  const screen = await openCard(raw);
  expect(screen.queryByTestId('devtest-item-verify')).toBeNull();
  fireEvent.press(screen.getByTestId('devtest-item-details'));
  expect(screen.getByTestId('devtest-item-details-body')).toBeTruthy();
  screen.getByText(/leaves only a small status icon/);
  // The instruction is not lost — it is still in the cell being rendered.
  screen.getByText(/confirm Stop still works/);
});
