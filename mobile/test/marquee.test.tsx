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
