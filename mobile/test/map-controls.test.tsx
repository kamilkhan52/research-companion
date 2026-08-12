import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

import {
  GRAPH_PAGE_SIZE,
  MapControlRail,
  GraphPagerOverlay,
} from '@/app/(tabs)/graph';
import { DISCOVER_PLACEHOLDER } from '@/app/(tabs)/discover';
import { ProgressSteps } from '@/components/ProgressSteps';

const FILTERS = [
  { key: 'project' as const, label: 'In project' },
  { key: 'external' as const, label: 'External' },
  { key: 'significant' as const, label: 'Significant' },
];

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

// DR-069 — the compact rail replacing the old full-size MAP BUILD banner + FILTER card. Each
// segment now opens a bottom sheet instead of expanding in place.

test('with no build running, the rail shows only the compact filter pill', async () => {
  await renderAsync(
    <MapControlRail
      building={false}
      progress={null}
      query=""
      onQueryChange={jest.fn()}
      showSearch={false}
      filters={FILTERS}
      filter="significant"
      onFilterChange={jest.fn()}
      visibleCount={23}
    />,
  );

  expect(screen.getByText('Significant')).toBeTruthy();
  expect(screen.getByText('23')).toBeTruthy();
  expect(screen.queryByText('Building…')).toBeNull();
});

test('tapping the filter segment opens a sheet, and picking a filter closes it', async () => {
  const onFilterChange = jest.fn();
  await renderAsync(
    <MapControlRail
      building={false}
      progress={null}
      query=""
      onQueryChange={jest.fn()}
      showSearch={false}
      filters={FILTERS}
      filter="significant"
      onFilterChange={onFilterChange}
      visibleCount={23}
    />,
  );

  expect(screen.queryByText('External')).toBeNull();
  await fireEventAsync.press(screen.getByLabelText(/Map filter: Significant/));
  expect(screen.getByText('External')).toBeTruthy();

  await fireEventAsync.press(screen.getByText('External'));
  expect(onFilterChange).toHaveBeenCalledWith('external');
  expect(screen.queryByText('External')).toBeNull();
});

test('a running build adds a segment that opens its own progress sheet', async () => {
  await renderAsync(
    <MapControlRail
      building
      progress={{
        phase: 'extraction',
        graphStage: 'enriched',
        total: 10,
        ready: 10,
        done: 4,
        currentTitle: 'Attention Is All You Need',
        perPaper: {},
        retrievalCandidates: {},
      }}
      query=""
      onQueryChange={jest.fn()}
      showSearch={false}
      filters={FILTERS}
      filter="significant"
      onFilterChange={jest.fn()}
      visibleCount={23}
    />,
  );

  expect(screen.getByText('Building…')).toBeTruthy();
  expect(screen.queryByText('MAP BUILD')).toBeNull();
  await fireEventAsync.press(screen.getByLabelText(/Map build in progress/));
  expect(screen.getByText('MAP BUILD')).toBeTruthy();
  expect(screen.getByText('4 analyzed')).toBeTruthy();
});

test('the build sheet closes itself once the build finishes', async () => {
  const progress = {
    phase: 'extraction' as const, graphStage: 'enriched' as const,
    total: 10, ready: 10, done: 4, currentTitle: null,
    perPaper: {}, retrievalCandidates: {},
  };
  const { rerenderAsync } = await renderAsync(
    <MapControlRail
      building
      progress={progress}
      query=""
      onQueryChange={jest.fn()}
      showSearch={false}
      filters={FILTERS}
      filter="significant"
      onFilterChange={jest.fn()}
      visibleCount={23}
    />,
  );
  await fireEventAsync.press(screen.getByLabelText(/Map build in progress/));
  expect(screen.getByText('MAP BUILD')).toBeTruthy();

  await rerenderAsync(
    <MapControlRail
      building={false}
      progress={{ ...progress, done: 10 }}
      query=""
      onQueryChange={jest.fn()}
      showSearch={false}
      filters={FILTERS}
      filter="significant"
      onFilterChange={jest.fn()}
      visibleCount={23}
    />,
  );
  expect(screen.queryByText('MAP BUILD')).toBeNull();
});

// Opus review, PR #382: the hint state (including the one-time "skeleton ready" announcement)
// used to live inside the details view itself, which unmounts every time the build sheet closes
// — resetting the "announced once" guard and re-firing the hint on every reopen. It now lives in
// MapControlRail, which stays mounted across the sheet's own open/close cycle.
test('the skeleton-ready hint announces once and does not return on a sheet reopen', async () => {
  const progress = {
    phase: 'extraction' as const, graphStage: 'skeleton' as const,
    total: 10, ready: 10, done: 4, currentTitle: null,
    perPaper: {}, retrievalCandidates: {},
  };
  await renderAsync(
    <MapControlRail
      building
      progress={progress}
      query=""
      onQueryChange={jest.fn()}
      showSearch={false}
      filters={FILTERS}
      filter="significant"
      onFilterChange={jest.fn()}
      visibleCount={23}
    />,
  );

  await fireEventAsync.press(screen.getByLabelText(/Map build in progress/));
  const hintText = 'Fast map ready — explore it now; enrichment keeps improving it in the background.';
  expect(screen.getByText(hintText)).toBeTruthy();
  await fireEventAsync.press(screen.getByLabelText('Dismiss hint'));
  expect(screen.queryByText(hintText)).toBeNull();

  // Close the sheet (unmounts the details view), then reopen it.
  await fireEventAsync.press(screen.getByLabelText('Dismiss test bottom sheet'));
  await fireEventAsync.press(screen.getByLabelText(/Map build in progress/));
  expect(screen.queryByText(hintText)).toBeNull();
});
