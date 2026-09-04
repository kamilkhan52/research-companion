import { renderAsync, screen } from '@testing-library/react-native';
import { LinearGradient, Stop } from 'react-native-svg';

import {
  EdgeFade,
  BOTTOM_EDGE_FADE_OPACITY,
  BOTTOM_EDGE_FADE_SOFT_OPACITY,
} from '@/components/EdgeFade';

test('shared edge fades preserve all four orientations and their opacity curves', async () => {
  await renderAsync(
    <>
      <EdgeFade edge="top" size={144} testID="top-fade" />
      <EdgeFade edge="bottom" size={120} transparentInset={12} testID="bottom-fade" />
      <EdgeFade edge="left" size={24} testID="left-fade" />
      <EdgeFade edge="right" size={28} testID="right-fade" />
    </>,
  );

  const top = screen.getByTestId('top-fade', { includeHiddenElements: true });
  const bottom = screen.getByTestId('bottom-fade', { includeHiddenElements: true });
  const left = screen.getByTestId('left-fade', { includeHiddenElements: true });
  const right = screen.getByTestId('right-fade', { includeHiddenElements: true });

  expect(top.props).toMatchObject({
    height: 144,
    width: '100%',
    pointerEvents: 'none',
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });
  expect(bottom.props).toMatchObject({
    height: 120,
    width: '100%',
    pointerEvents: 'none',
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });
  expect(left.props).toMatchObject({ width: 24, height: '100%' });
  expect(right.props).toMatchObject({ width: 28, height: '100%' });

  const stops = screen.UNSAFE_getAllByType(Stop);
  expect(stops.map((stop) => stop.props.stopOpacity)).toEqual([
    1, 0.9, 0,
    0, 0, BOTTOM_EDGE_FADE_SOFT_OPACITY, BOTTOM_EDGE_FADE_OPACITY,
    1, 0,
    0, 1,
  ]);
  // The bottom inset remains a real fraction of the rendered size (12 / 120), preserving the
  // discussion composer's transparent breathing room rather than merely adding another stop.
  expect(stops[4].props.offset).toBe(0.1);

  const gradients = screen.UNSAFE_getAllByType(LinearGradient);
  expect(gradients.map(({ props }) => [props.x2, props.y2])).toEqual([
    ['0', '1'], ['0', '1'], ['1', '0'], ['1', '0'],
  ]);
});

test('a shared fade can resolve into a caller-owned surface fill', async () => {
  await renderAsync(
    <EdgeFade edge="right" size={28} fill="#123456" testID="surface-fade" />,
  );

  const stops = screen.UNSAFE_getAllByType(Stop);
  expect(stops.map((stop) => stop.props.stopColor)).toEqual(['#123456', '#123456']);
  expect(stops.map((stop) => stop.props.stopOpacity)).toEqual([0, 1]);
});
