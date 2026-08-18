import { renderAsync, screen } from '@testing-library/react-native';
import { Stop } from 'react-native-svg';

import {
  DiscussionEdgeFade,
  DISCUSSION_BOTTOM_FADE_EDGE_OPACITY,
  DISCUSSION_BOTTOM_FADE_SOFT_OPACITY,
} from '@/components/chat/DiscussionEdgeFade';

test('renders non-interactive edge scrims at both transcript boundaries', async () => {
  await renderAsync(
    <>
      <DiscussionEdgeFade edge="top" height={144} />
      <DiscussionEdgeFade edge="bottom" height={120} />
    </>,
  );

  const top = screen.getByTestId(
    'discussion-top-edge-fade',
    { includeHiddenElements: true },
  );
  const bottom = screen.getByTestId(
    'discussion-bottom-edge-fade',
    { includeHiddenElements: true },
  );

  expect(top.props).toMatchObject({
    height: 144,
    pointerEvents: 'none',
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });
  expect(bottom.props).toMatchObject({
    height: 120,
    pointerEvents: 'none',
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  });

  const stops = screen.UNSAFE_getAllByType(Stop);
  expect(stops.slice(-4).map((stop) => stop.props.stopOpacity)).toEqual([
    0,
    0,
    DISCUSSION_BOTTOM_FADE_SOFT_OPACITY,
    DISCUSSION_BOTTOM_FADE_EDGE_OPACITY,
  ]);
});
