// Kamil, 2026-09-02: "when I collapse the issue, I have to scroll up… The scroll should be smart
// or the expand and collapse should just be implemented differently so that I end up where I was
// when I expanded the issue."
//
// Expanding a card adds screens of content BELOW the header, so the reading position drifts far
// down the list; collapsing takes that content away again and leaves him scrolled past where he
// started. The list records the offset each card was opened at and returns there when it closes.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

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

const ITEMS: DevTestItem[] = [
  { id: 'DR-A', state: 'open', raised: '2026-08-12', title: 'Alpha thing',
    how_to_test: 'a description long enough to matter', feedback_count: 0 },
  { id: 'DR-B', state: 'open', raised: '2026-08-12', title: 'Beta gadget',
    how_to_test: 'another description', feedback_count: 0 },
];

async function openBubble() {
  jest.mocked(api.getDevTestItems).mockResolvedValue({ items: ITEMS });
  const screen = render(<DevTestBubble />);
  fireEvent.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByText('Alpha thing')).toBeTruthy());
  return screen;
}

/** Pretend the list has been scrolled to `y`. */
function scrollList(screen: ReturnType<typeof render>, y: number) {
  fireEvent.scroll(screen.getByTestId('devtest-scroll'), {
    nativeEvent: { contentOffset: { y }, contentSize: { height: 4000, width: 400 },
                   layoutMeasurement: { height: 800, width: 400 } },
  });
}

beforeEach(() => jest.clearAllMocks());

test('collapsing returns the list to the offset the card was opened at', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();

  scrollList(screen, 1200);                                   // he reads his way down
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to leave a pass/i));
  scrollList(screen, 2600);                                   // the open card pushes him further
  scrollTo.mockClear();
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to collapse/i));

  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 1200, animated: true }));
  scrollTo.mockRestore();
});

test('it never yanks him FORWARD if he has since scrolled above the anchor', async () => {
  // The same complaint pointed the other way: he closed the card from further up the list
  // deliberately, and dragging him back down to where he opened it would be its own bug.
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();

  scrollList(screen, 1200);
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to leave a pass/i));
  scrollList(screen, 300);                                    // he scrolled back up himself
  scrollTo.mockClear();
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to collapse/i));

  await waitFor(() => expect(screen.getByLabelText(/DR-A.*Tap to leave a pass/i)).toBeTruthy());
  expect(scrollTo).not.toHaveBeenCalled();
  scrollTo.mockRestore();
});

test('a second card does not overwrite the first card’s anchor', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const screen = await openBubble();

  scrollList(screen, 500);
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to leave a pass/i));   // anchor A = 500
  scrollList(screen, 1500);
  fireEvent.press(screen.getByLabelText(/DR-B.*Tap to leave a pass/i));   // anchor B = 1500
  scrollList(screen, 2400);

  scrollTo.mockClear();
  fireEvent.press(screen.getByLabelText(/DR-B.*Tap to collapse/i));
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 1500, animated: true }));

  scrollTo.mockClear();
  fireEvent.press(screen.getByLabelText(/DR-A.*Tap to collapse/i));
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 500, animated: true }));
  scrollTo.mockRestore();
});
