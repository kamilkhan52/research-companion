import { renderAsync } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';

import {
  DiscoverLoadingSkeleton,
  LibraryLoadingSkeleton,
  NotesLoadingSkeleton,
  PaperSessionLoadingSkeleton,
  SettingsLoadingSkeleton,
  UsageLoadingSkeleton,
} from '@/components/LoadingSkeletons';
import { Skeleton, SkeletonGroup } from '@/components/Skeleton';
import { ThemeProvider } from '@/theme/ThemeProvider';

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});

afterEach(() => jest.restoreAllMocks());

test('one skeleton group owns one native-driver pulse and one accessible loading state', async () => {
  const start = jest.fn();
  const stop = jest.fn();
  const loop = jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop } as never);
  const timing = jest.spyOn(Animated, 'timing');

  const view = await renderAsync(
    <ThemeProvider>
      <SkeletonGroup label="Loading test content">
        <Skeleton height={12} testID="decorative-block-one" />
        <Skeleton height={12} testID="decorative-block-two" />
      </SkeletonGroup>
    </ThemeProvider>,
  );

  expect(view.getByRole('progressbar').props.accessibilityLabel).toBe('Loading test content');
  expect(view.getByRole('progressbar').props.accessibilityState).toEqual({ busy: true });
  expect(view.getByTestId('decorative-block-one', { includeHiddenElements: true }).props.accessible)
    .toBe(false);
  expect(loop).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
  expect(timing).toHaveBeenCalledTimes(2);
  for (const [, config] of timing.mock.calls) {
    expect(config).toEqual(expect.objectContaining({ useNativeDriver: true }));
  }

  await view.unmountAsync();
  expect(stop).toHaveBeenCalledTimes(1);
});

test('group layout styles apply to the animated container that directly owns the blocks', async () => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const view = await renderAsync(
    <ThemeProvider>
      <SkeletonGroup label="Loading spaced content" style={{ gap: 13 }} testID="skeleton-group">
        <Skeleton height={12} />
        <Skeleton height={12} />
      </SkeletonGroup>
    </ThemeProvider>,
  );

  const group = view.getByTestId('skeleton-group');
  expect(group.children).toHaveLength(2);
  expect(StyleSheet.flatten(group.props.style)).toEqual(expect.objectContaining({ gap: 13 }));
});

test('reduced motion keeps the skeleton static', async () => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const loop = jest.spyOn(Animated, 'loop');

  await renderAsync(
    <ThemeProvider>
      <SkeletonGroup label="Loading static content">
        <Skeleton height={12} />
      </SkeletonGroup>
    </ThemeProvider>,
  );

  expect(loop).not.toHaveBeenCalled();
});

test.each([
  ['Loading your library', LibraryLoadingSkeleton],
  ['Loading discovery', DiscoverLoadingSkeleton],
  ['Loading notes', NotesLoadingSkeleton],
  ['Loading settings', SettingsLoadingSkeleton],
  ['Loading usage', UsageLoadingSkeleton],
  ['Loading discussion', PaperSessionLoadingSkeleton],
] as const)('%s exposes one loading announcement for its whole geometry', async (label, Component) => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const view = await renderAsync(
    <ThemeProvider>
      <Component />
    </ThemeProvider>,
  );

  expect(view.getAllByRole('progressbar')).toHaveLength(1);
  expect(view.getByRole('progressbar').props.accessibilityLabel).toBe(label);
});
