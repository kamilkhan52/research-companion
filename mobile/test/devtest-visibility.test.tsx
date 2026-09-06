/** DR-132 — parking an item is shared server state, immediately reflected in the queue, and
 * recoverable from the filter menu. These tests cross the API/card/list boundary; a predicate-only
 * test would stay green if the button never sent the event or the list never consumed it. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { DevTestBubble } from '@/components/DevTestBubble';
import type { DevTestItem } from '@/api/endpoints';

jest.mock('expo-router', () => ({ usePathname: () => '/' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn(),
  setDevTestItemVisibility: jest.fn().mockResolvedValue({ entry: {} }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn().mockResolvedValue({ entries: [] }),
  getDispatchStatus: jest.fn().mockResolvedValue({ dispatch: null }),
  getDeployState: jest.fn().mockRejectedValue(new Error('not relevant')),
  createDevTestItem: jest.fn(),
}));

import * as api from '@/api/endpoints';

const ITEMS: DevTestItem[] = [
  {
    id: 'DR-VISIBLE', state: 'implemented — verify', raised: '2026-09-06',
    title: 'Visible item', how_to_test: '', feedback_count: 0, hidden: false,
  },
  {
    id: 'DR-HIDDEN', state: 'implemented — verify', raised: '2026-09-06',
    title: 'Parked item', how_to_test: '', feedback_count: 0, hidden: true,
  },
];

async function openBubble() {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Visible item')).toBeTruthy());
  return screen;
}

beforeEach(() => jest.clearAllMocks());
afterEach(async () => AsyncStorage.clear());

test('the default queue says what it omitted and offers a direct route to Hidden', async () => {
  const screen = await openBubble();

  expect(screen.getByText('1 of 2 shown · 1 hidden')).toBeTruthy();
  expect(screen.getByLabelText('Options — filter, sort and dispatch. 1 item is parked in Hidden.'))
    .toBeTruthy();

  fireEvent.press(screen.getByText('Show hidden 1'));
  await waitFor(() => expect(screen.getByText('Parked item')).toBeTruthy());
  expect(screen.queryByText('Visible item')).toBeNull();
});

test('Hide for now appends shared state and removes the card from the visible queue', async () => {
  const screen = await openBubble();
  expect(screen.queryByText('Parked item')).toBeNull();

  fireEvent.press(screen.getByText('Visible item'));
  fireEvent.press(screen.getByText('Hide for now'));

  await waitFor(() => expect(api.setDevTestItemVisibility).toHaveBeenCalledWith('DR-VISIBLE', true));
  await waitFor(() => expect(screen.queryByText('Visible item')).toBeNull());
});

test('Hidden filter is the recovery path and Restore returns the item to Visible', async () => {
  const screen = await openBubble();
  fireEvent.press(screen.getByTestId('devtest-options-toggle'));
  fireEvent.press(screen.getByLabelText('Hidden'));
  await waitFor(() => expect(screen.getByText('Parked item')).toBeTruthy());
  expect(screen.queryByText('Visible item')).toBeNull();

  fireEvent.press(screen.getByText('Parked item'));
  fireEvent.press(screen.getByText('Restore'));
  await waitFor(() => expect(api.setDevTestItemVisibility).toHaveBeenCalledWith('DR-HIDDEN', false));
  await waitFor(() => expect(screen.queryByText('Parked item')).toBeNull());

  fireEvent.press(screen.getByLabelText('Visible'));
  expect(await screen.findByText('Parked item')).toBeTruthy();
});
