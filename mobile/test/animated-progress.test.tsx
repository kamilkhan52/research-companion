import { act, renderAsync, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';

import { AnimatedProgressBar } from '@/ui';

afterEach(() => jest.restoreAllMocks());

test('progress paints its first value and only animates later changes', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const start = jest.fn();
  const stop = jest.fn();
  const timing = jest.spyOn(Animated, 'timing').mockReturnValue({ start, stop } as never);
  const view = await renderAsync(<AnimatedProgressBar value={0.82} testID="meter" />);

  expect(timing).not.toHaveBeenCalled();
  expect(view.getByTestId('meter', { includeHiddenElements: true }).props.accessibilityValue.now).toBe(82);

  await view.rerenderAsync(<AnimatedProgressBar value={0.61} testID="meter" />);
  expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    toValue: 0.61,
    duration: 250,
    useNativeDriver: false,
  }));
  expect(start).toHaveBeenCalled();
});

test('reduce motion turns a changed meter into an immediate state change', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const timing = jest.spyOn(Animated, 'timing');
  const view = await renderAsync(<AnimatedProgressBar value={0.82} />);
  await waitFor(() => expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalled());

  await act(async () => {
    await view.rerenderAsync(<AnimatedProgressBar value={0.61} />);
  });
  expect(timing).not.toHaveBeenCalled();
});
