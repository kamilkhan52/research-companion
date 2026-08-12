// DR-072 — the trigger bubble is positioned off the bottom safe-area inset alone, so a keyboard
// open on whatever screen it floats over (e.g. mid-comment) covers it — mildly self-defeating,
// since this bubble is how Kamil files feedback about exactly that kind of bug. Same fix as
// DR-055/DR-072's Toast fix: read the global keyboard-controller state.

import { renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { DevTestBubble } from '@/components/DevTestBubble';
import { space } from '@/theme/tokens';

jest.mock('expo-router', () => ({ usePathname: () => '/discover' }));
jest.mock('@/api/endpoints', () => ({
  getDevTestItems: jest.fn().mockResolvedValue({ items: [] }),
  recordDevTestFeedback: jest.fn().mockResolvedValue({ entry: {} }),
  getDevTestFeedback: jest.fn(),
  createDevTestItem: jest.fn(),
}));

function bottom(node: ReactTestInstance): number | string | undefined {
  return (StyleSheet.flatten(node.props.style) as { bottom?: number | string }).bottom;
}

function mockKeyboard(state: { isVisible: boolean; height: number }) {
  jest.mocked(useKeyboardState).mockImplementation((selector) =>
    (selector ? selector(state as never) : state) as never,
  );
}

afterEach(() => {
  jest.mocked(useKeyboardState).mockReset();
});

test('keyboard closed: the trigger bubble sits at its ordinary safe-area position', async () => {
  mockKeyboard({ isVisible: false, height: 0 });
  await renderAsync(<DevTestBubble />);
  const trigger = screen.getByLabelText('Open device-test companion');
  expect(bottom(trigger)).toBe(96);
});

test('keyboard open: the trigger bubble lifts above it instead of rendering behind it', async () => {
  mockKeyboard({ isVisible: true, height: 280 });
  await renderAsync(<DevTestBubble />);
  const trigger = screen.getByLabelText('Open device-test companion');
  expect(bottom(trigger)).toBe(280 + space.md);
});

test('a stale height reading after dismissal does not keep the bubble lifted', async () => {
  mockKeyboard({ isVisible: false, height: 280 });
  await renderAsync(<DevTestBubble />);
  const trigger = screen.getByLabelText('Open device-test companion');
  expect(bottom(trigger)).toBe(96);
});
