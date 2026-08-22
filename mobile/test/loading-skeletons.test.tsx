import { renderAsync } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  DiscussionLoadingSkeleton,
  DiscoverLoadingSkeleton,
  LibraryLoadingSkeleton,
  NotesLoadingSkeleton,
  PaperSetupLoadingSkeleton,
  SettingsLoadingSkeleton,
  UsageLoadingSkeleton,
} from '@/components/LoadingSkeletons';
import { Skeleton, SkeletonGroup } from '@/components/Skeleton';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { radius } from '@/theme/tokens';

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
  ['Loading discussion', DiscussionLoadingSkeleton],
  ['Loading paper setup', PaperSetupLoadingSkeleton],
] as const)('%s exposes one loading announcement for its whole geometry', async (label, Component) => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const view = await renderAsync(
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 24, right: 0, bottom: 20, left: 0 } }}>
      <ThemeProvider>
        <Component />
      </ThemeProvider>
    </SafeAreaProvider>,
  );

  expect(view.getAllByRole('progressbar')).toHaveLength(1);
  expect(view.getByRole('progressbar').props.accessibilityLabel).toBe(label);
});

test('discussion skeleton is one continuous transcript canvas with matching floating composer', async () => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const view = await renderAsync(
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 24, right: 0, bottom: 20, left: 0 } }}>
      <ThemeProvider>
        <DiscussionLoadingSkeleton />
      </ThemeProvider>
    </SafeAreaProvider>,
  );

  expect(view.getAllByTestId('discussion-assistant-turn-skeleton')).toHaveLength(4);
  expect(view.getAllByTestId('discussion-reader-turn-skeleton')).toHaveLength(2);
  expect(view.getByTestId(
    'discussion-composer-skeleton',
    { includeHiddenElements: true },
  )).toBeTruthy();
  expect(view.getByTestId(
    'discussion-bottom-edge-fade',
    { includeHiddenElements: true },
  )).toBeTruthy();
  expect(view.getAllByRole('progressbar')).toHaveLength(1);
  expect(view.getByTestId('discussion-composer-skeleton', { includeHiddenElements: true }).props)
    .toEqual(expect.objectContaining({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    }));
});

test.each([
  ['notes_drafted', 'discussion-review-skeleton'],
  ['committed', 'discussion-committed-skeleton'],
] as const)('discussion skeleton matches the %s bottom state', async (state, expectedTestId) => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const view = await renderAsync(
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 24, right: 0, bottom: 20, left: 0 } }}>
      <ThemeProvider>
        <DiscussionLoadingSkeleton state={state} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );

  expect(view.getByTestId(expectedTestId, { includeHiddenElements: true }).props)
    .toEqual(expect.objectContaining({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    }));
  expect(view.queryByTestId(
    'discussion-composer-skeleton',
    { includeHiddenElements: true },
  )).toBeNull();
});

test('paper setup skeleton mirrors ComposeFirst instead of pretending to be a transcript', async () => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const view = await renderAsync(
    <ThemeProvider>
      <PaperSetupLoadingSkeleton />
    </ThemeProvider>,
  );

  expect(view.getByTestId('paper-setup-hero-skeleton')).toBeTruthy();
  expect(view.getByTestId('paper-setup-modes-skeleton').children).toHaveLength(7);
  expect(view.getByTestId('paper-setup-source-skeleton')).toBeTruthy();
  expect(view.getByTestId(
    'paper-setup-footer-skeleton',
    { includeHiddenElements: true },
  )).toBeTruthy();
  expect(view.getByTestId('paper-setup-footer-skeleton', { includeHiddenElements: true }).props)
    .toEqual(expect.objectContaining({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    }));
  expect(view.queryByTestId('discussion-reader-turn-skeleton')).toBeNull();
});

test('library skeleton mirrors the loaded library hierarchy and card geometry', async () => {
  jest.restoreAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const view = await renderAsync(
    <ThemeProvider>
      <LibraryLoadingSkeleton />
    </ThemeProvider>,
  );

  expect(view.getByTestId('library-continue-card-skeleton')).toBeTruthy();
  expect(view.getByTestId('library-progress-card-skeleton')).toBeTruthy();
  expect(view.getByTestId('library-filter-skeleton').children).toHaveLength(4);
  expect(view.getAllByTestId('library-paper-card-skeleton')).toHaveLength(4);

  const cover = view.getByTestId('library-cover-skeleton', { includeHiddenElements: true });
  expect(StyleSheet.flatten(cover.props.style)).toEqual(expect.objectContaining({
    width: 84,
    height: 104,
  }));

  const firstPaper = view.getAllByTestId('library-paper-card-skeleton')[0];
  expect(firstPaper.children).toHaveLength(2);
  expect(StyleSheet.flatten(firstPaper.props.style)).toEqual(expect.objectContaining({
    borderWidth: 1,
    borderRadius: radius.lg,
  }));
});
