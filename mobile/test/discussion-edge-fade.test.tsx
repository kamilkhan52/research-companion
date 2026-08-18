import { renderAsync, screen } from '@testing-library/react-native';

import { DiscussionEdgeFade } from '@/components/chat/DiscussionEdgeFade';

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
});
