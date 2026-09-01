// DR-115 — the rail itself. Kamil asked for arrows "to go up and down to these landmarks",
// transparency over the text, and an auto-hide that reveals again.
//
// The jest mock settles Reanimated animations instantly (see marquee.test.tsx), so what is
// observable is WHICH opacity each transition was scheduled towards.

import { createRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

import {
  ChatNavRail,
  RAIL_IDLE_MS,
  RAIL_RESTING_OPACITY,
  type ChatNavRailHandle,
} from '@/components/chat/ChatNavRail';

jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return {
    __esModule: true,
    ...actual,
    default: actual.default,
    withTiming: jest.fn(actual.withTiming),
  };
});

const reanimated = jest.requireMock('react-native-reanimated') as { withTiming: jest.Mock };

function setup() {
  const handlers = {
    onOldest: jest.fn(),
    onUp: jest.fn(),
    onDown: jest.fn(),
    onLive: jest.fn(),
  };
  const ref = createRef<ChatNavRailHandle>();
  const screen = render(
    <ChatNavRail ref={ref} {...handlers} topInset={80} bottomInset={120} />,
  );
  return { screen, handlers, ref };
}

/** Opacity values the rail has been animated towards, oldest first. */
function targets(): number[] {
  return reanimated.withTiming.mock.calls.map(([to]) => to as number);
}

beforeEach(() => {
  jest.useFakeTimers();
  reanimated.withTiming.mockClear();
});
afterEach(() => jest.useRealTimers());

test('offers the two extremes and one step in each direction, each labelled for screen readers', () => {
  const { screen, handlers } = setup();

  fireEvent.press(screen.getByLabelText('Jump to the start of the thread'));
  fireEvent.press(screen.getByLabelText('Previous message'));
  fireEvent.press(screen.getByLabelText('Next message'));
  fireEvent.press(screen.getByLabelText('Jump to the latest message'));

  expect(handlers.onOldest).toHaveBeenCalledTimes(1);
  expect(handlers.onUp).toHaveBeenCalledTimes(1);
  expect(handlers.onDown).toHaveBeenCalledTimes(1);
  expect(handlers.onLive).toHaveBeenCalledTimes(1);
});

test('lets touches through everywhere except the controls, so the transcript stays scrollable', () => {
  const { screen } = setup();
  expect(screen.getByTestId('chat-nav-rail-area').props.pointerEvents).toBe('box-none');
  expect(screen.getByTestId('chat-nav-rail')).toBeTruthy();
});

test('settles back to a see-through resting state after a quiet moment', () => {
  const { screen } = setup();
  expect(targets()).toEqual([]); // nothing scheduled while it is still fully present
  act(() => void jest.advanceTimersByTime(RAIL_IDLE_MS + 1));
  expect(targets()).toEqual([RAIL_RESTING_OPACITY]);
  expect(screen.getByTestId('chat-nav-rail')).toBeTruthy(); // dimmed, never unmounted
});

test('the resting state is see-through, not invisible', () => {
  // Vanishing entirely would only be recallable by scrolling — and not scrolling is the whole
  // point of this rail.
  expect(RAIL_RESTING_OPACITY).toBeGreaterThan(0);
  expect(RAIL_RESTING_OPACITY).toBeLessThan(1);
});

test('waking brings it back to full strength and restarts the countdown', () => {
  const { ref } = setup();
  act(() => void jest.advanceTimersByTime(RAIL_IDLE_MS + 1));
  act(() => ref.current?.wake());
  expect(targets()).toEqual([RAIL_RESTING_OPACITY, 1]);
  act(() => void jest.advanceTimersByTime(RAIL_IDLE_MS + 1));
  expect(targets()).toEqual([RAIL_RESTING_OPACITY, 1, RAIL_RESTING_OPACITY]);
});

test('waking an already-visible rail only defers the fade — it does not re-animate', () => {
  const { ref } = setup();
  act(() => ref.current?.wake());
  act(() => ref.current?.wake());
  expect(targets()).toEqual([]);
  act(() => void jest.advanceTimersByTime(RAIL_IDLE_MS + 1));
  expect(targets()).toEqual([RAIL_RESTING_OPACITY]);
});

test('pressing a control also wakes the rail', () => {
  const { screen } = setup();
  act(() => void jest.advanceTimersByTime(RAIL_IDLE_MS + 1));
  fireEvent.press(screen.getByLabelText('Previous message'));
  expect(targets()).toEqual([RAIL_RESTING_OPACITY, 1]);
});
