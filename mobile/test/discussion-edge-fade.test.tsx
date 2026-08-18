import { renderAsync, screen } from '@testing-library/react-native';

import { DiscussionEdgeFade } from '@/components/chat/DiscussionEdgeFade';

test('renders non-interactive edge scrims at both transcript boundaries', async () => {
  await renderAsync(
    <>
      <DiscussionEdgeFade edge="top" height={144} />
      <DiscussionEdgeFade edge="bottom" height={120} />
    </>,
  );

  expect(screen.getByTestId(
    'discussion-top-edge-fade',
    { includeHiddenElements: true },
  ).props.height).toBe(144);
  expect(screen.getByTestId(
    'discussion-bottom-edge-fade',
    { includeHiddenElements: true },
  ).props.height).toBe(120);
});
