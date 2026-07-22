import { Animated } from 'react-native';
import { fireEvent, renderAsync, screen } from '@testing-library/react-native';

import { Marquee } from '@/ui/Marquee';

// R.3/R7.1 — an overflowing title glides ONCE (then resets to its head — no looping); a
// fitting title never animates.

const LONG = 'AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration';

function layout(node: unknown, width: number) {
  fireEvent(node as never, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } } });
}

test('a title wider than its container glides once and never loops', async () => {
  const loopSpy = jest.spyOn(Animated, 'loop');
  const timingSpy = jest.spyOn(Animated, 'timing');
  await renderAsync(<Marquee text={LONG} textStyle={{ fontSize: 16 }} />);

  layout(screen.getByLabelText(LONG), 120); // narrow container
  layout(screen.getByText(LONG), 640); // wide intrinsic text

  expect(loopSpy).not.toHaveBeenCalled(); // scroll-once, not a loop
  expect(timingSpy).toHaveBeenCalled(); // a glide was scheduled
  loopSpy.mockRestore();
  timingSpy.mockRestore();
});

test('a title that fits never animates', async () => {
  const timingSpy = jest.spyOn(Animated, 'timing');
  await renderAsync(<Marquee text="Map" textStyle={{ fontSize: 16 }} />);

  layout(screen.getByLabelText('Map'), 300); // roomy container
  layout(screen.getByText('Map'), 60); // narrow text

  expect(timingSpy).not.toHaveBeenCalled();
  timingSpy.mockRestore();
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
