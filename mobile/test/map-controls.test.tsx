import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import {
  GRAPH_PAGE_SIZE,
  GraphPagerOverlay,
} from '@/app/(tabs)/graph';
import { DISCOVER_PLACEHOLDER } from '@/app/(tabs)/discover';
import { ProgressSteps } from '@/components/ProgressSteps';

test('Map reveals papers in batches of 50 and keeps paging controls in one overlay', async () => {
  const onIncrease = jest.fn();
  const onDecrease = jest.fn();
  expect(GRAPH_PAGE_SIZE).toBe(50);

  await renderAsync(
    <GraphPagerOverlay
      shown={50}
      total={125}
      canIncrease
      canDecrease
      onIncrease={onIncrease}
      onDecrease={onDecrease}
    />,
  );

  expect(screen.getByText('Showing 50 of 125')).toBeTruthy();
  await fireEventAsync.press(screen.getByLabelText('Show more papers'));
  await fireEventAsync.press(screen.getByLabelText('Show fewer papers'));
  expect(onIncrease).toHaveBeenCalledTimes(1);
  expect(onDecrease).toHaveBeenCalledTimes(1);
});

test('Discover uses a brief generic search placeholder', () => {
  expect(DISCOVER_PLACEHOLDER).toBe('Type a topic or question');
});

test('shared progress steps render completed checks for both Map and Discover timelines', async () => {
  await renderAsync(
    <ProgressSteps
      steps={[
        { key: 'planned', label: 'Planned', state: 'done' },
        { key: 'searched', label: 'Searched', state: 'active' },
        { key: 'ranked', label: 'Ranked', state: 'pending' },
      ]}
    />,
  );

  expect(screen.getByText('Planned')).toBeTruthy();
  expect(screen.getByText('Searched')).toBeTruthy();
  expect(screen.getByText('Ranked')).toBeTruthy();
});
