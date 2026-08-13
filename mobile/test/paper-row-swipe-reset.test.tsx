// FlashList recycles cells: a PaperRow instance can receive a different paper's props without
// unmounting, and ReanimatedSwipeable's open/closed translation is instance-local — so a row
// swiped open and scrolled away could come back as ANOTHER paper already exposing the
// destructive Remove affordance (Opus review of #393, P1). Pins the reset: a paper change
// closes the swipeable; a re-render with the same paper (poll refetch) leaves it alone.

import { renderAsync } from '@testing-library/react-native';

import type { Paper } from '@/api/types';
import { PaperRow } from '@/app/(tabs)/index';

const mockClose = jest.fn();

jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  // Required lazily inside the factory: jest hoists this above the imports.
  const React = require('react');
  const { View } = require('react-native');
  const MockSwipeable = React.forwardRef(function MockSwipeable(
    { children }: { children: unknown },
    ref: unknown,
  ) {
    React.useImperativeHandle(ref, () => ({ close: mockClose }));
    return React.createElement(View, null, children);
  });
  return { __esModule: true, default: MockSwipeable };
});

const paper = (slug: string): Paper =>
  ({
    slug,
    title: slug,
    group: null,
    arxiv_id: null,
    year: 2024,
    status: 'unread',
    has_notes: false,
    affiliations: [],
  } as unknown as Paper);

const noop = () => undefined;

function row(p: Paper) {
  return (
    <PaperRow
      paper={p}
      onPress={noop}
      onLongPress={noop}
      onRemove={noop}
      selectMode={false}
      selected={false}
    />
  );
}

test('a recycled row closes its swipeable; a same-paper re-render does not', async () => {
  const screen = await renderAsync(row(paper('paper-a')));
  const callsAfterMount = mockClose.mock.calls.length;

  // Same paper again (poll refetch, parent re-render): a deliberately opened row stays open.
  await screen.rerenderAsync(row(paper('paper-a')));
  expect(mockClose.mock.calls.length).toBe(callsAfterMount);

  // Recycle: different paper into the same instance — the swipe state must reset.
  await screen.rerenderAsync(row(paper('paper-b')));
  expect(mockClose.mock.calls.length).toBe(callsAfterMount + 1);
});
