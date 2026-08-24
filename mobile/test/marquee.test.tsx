import { fireEvent, renderAsync, screen } from '@testing-library/react-native';
import Reanimated from 'react-native-reanimated';

import { Marquee } from '@/ui/Marquee';

// R.3/R7.1 — an overflowing title glides ONCE (then resets to its head — no looping); a
// fitting title never animates.
//
// DR-103 — the glide runs on Reanimated's UI thread, not RN Animated. The return to the head
// used to be a JS callback, so a busy JS thread left the title resting mid-scroll; withSequence
// makes the return the animation's own last step. The jest mock settles animations instantly,
// so the observable facts are WHICH primitives were scheduled and that no repeat was asked for.

jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return {
    __esModule: true,
    ...actual,
    default: actual.default,
    withTiming: jest.fn(actual.withTiming),
    withSequence: jest.fn(actual.withSequence),
    withRepeat: jest.fn(actual.withRepeat),
  };
});

const reanimated = jest.requireMock('react-native-reanimated') as {
  withTiming: jest.Mock; withSequence: jest.Mock; withRepeat: jest.Mock;
};

beforeEach(() => {
  reanimated.withTiming.mockClear();
  reanimated.withSequence.mockClear();
  reanimated.withRepeat.mockClear();
});

const LONG = 'AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration';

function layout(node: unknown, width: number) {
  fireEvent(node as never, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } } });
}

test('a title wider than its container glides once, and returns home inside the animation', async () => {
  await renderAsync(<Marquee text={LONG} textStyle={{ fontSize: 16 }} />);

  layout(screen.getByLabelText(LONG), 120); // narrow container
  layout(screen.getByText(LONG), 640); // wide intrinsic text

  expect(reanimated.withRepeat).not.toHaveBeenCalled(); // scroll-once, not a loop
  expect(reanimated.withSequence).toHaveBeenCalled();   // glide THEN return, as one animation
  // The last timing in the sequence goes back to 0: the head is where the line rests (R7.1),
  // and it gets there on the UI thread rather than via a callback JS may never run in time.
  const targets = reanimated.withTiming.mock.calls.map((c) => c[0]);
  expect(targets[0]).toBeLessThan(0);
  expect(targets[targets.length - 1]).toBe(0);
});

test('a title that fits never animates', async () => {
  await renderAsync(<Marquee text="Map" textStyle={{ fontSize: 16 }} />);

  layout(screen.getByLabelText('Map'), 300); // roomy container
  layout(screen.getByText('Map'), 60); // narrow text

  expect(reanimated.withTiming).not.toHaveBeenCalled();
});

// Usage-note fix (R12.5): the first painted frame must already sit at the final anchor.
// The strip stays transparent until the CURRENT text's measurement lands, and a text change
// (placeholder → real title) can never paint the new text at the old text's anchor.

function stripOpacity() {
  const strip = screen.getByTestId('marquee-strip');
  const style = Array.isArray(strip.props.style)
    ? Object.assign({}, ...strip.props.style)
    : strip.props.style;
  return style.opacity;
}

test('text is hidden until both container and its own width are measured', async () => {
  await renderAsync(<Marquee text={LONG} textStyle={{ fontSize: 16 }} />);
  expect(stripOpacity()).toBe(0);

  layout(screen.getByLabelText(LONG), 120);
  expect(stripOpacity()).toBe(0); // container measured, text not yet

  layout(screen.getByText(LONG), 640);
  expect(stripOpacity()).toBe(1); // both measured — painted at the rolling start
});

test('changing text hides the strip again until the new text is measured', async () => {
  const view = await renderAsync(<Marquee text="Map" textStyle={{ fontSize: 16 }} />);
  layout(screen.getByLabelText('Map'), 300);
  layout(screen.getByText('Map'), 60);
  expect(stripOpacity()).toBe(1);

  await view.rerenderAsync(<Marquee text={LONG} textStyle={{ fontSize: 16 }} />);
  expect(stripOpacity()).toBe(0); // stale 60px width must not position the new title

  layout(screen.getByText(LONG), 640);
  expect(stripOpacity()).toBe(1);
});
