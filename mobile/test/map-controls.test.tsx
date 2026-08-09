import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import {
  GRAPH_PAGE_SIZE,
  FilterBar,
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

test('Map filters start as one active-chip row and expand inline', async () => {
  const onFilterChange = jest.fn();
  await renderAsync(
    <FilterBar
      query=""
      onQueryChange={jest.fn()}
      showSearch={false}
      filters={[
        { key: 'project', label: 'In project' },
        { key: 'external', label: 'External' },
        { key: 'significant', label: 'Significant' },
      ]}
      filter="significant"
      onFilterChange={onFilterChange}
      visibleCount={23}
    />,
  );

  expect(screen.getByText('Significant')).toBeTruthy();
  expect(screen.getByText('23 nodes visible')).toBeTruthy();
  expect(screen.queryByText('External')).toBeNull();

  await fireEventAsync.press(screen.getByLabelText(/Show map filters/));
  expect(screen.getByText('External')).toBeTruthy();
  await fireEventAsync.press(screen.getByText('External'));
  expect(onFilterChange).toHaveBeenCalledWith('external');
});
