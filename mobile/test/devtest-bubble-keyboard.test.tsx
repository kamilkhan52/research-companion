// DR-072 — the trigger bubble is positioned off the bottom safe-area inset alone, so a keyboard
// open on whatever screen it floats over (e.g. mid-comment) covers it — mildly self-defeating,
// since this bubble is how Kamil files feedback about exactly that kind of bug. Same fix as
// DR-055/DR-072's Toast fix: read the global keyboard-controller state.

import { fireEventAsync, renderAsync, screen, waitFor } from '@testing-library/react-native';
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

// DR-076 — the sheet's own ScrollView had no `keyboardShouldPersistTaps`, so at the RN default
// ("never") the first tap on Pass/Fail with the keyboard open was consumed dismissing the
// keyboard instead of registering — needed a second tap to actually submit a verdict.
test('the open sheet lets a tap register on the same gesture that dismisses the keyboard', async () => {
  mockKeyboard({ isVisible: false, height: 0 });
  await renderAsync(<DevTestBubble />);
  await fireEventAsync.press(screen.getByLabelText('Open device-test companion'));
  await waitFor(() => expect(screen.getByTestId('devtest-scroll')).toBeTruthy());
  expect(screen.getByTestId('devtest-scroll').props.keyboardShouldPersistTaps).toBe('handled');
});

// Opus review, PR #384: `keyboardShouldPersistTaps` alone doesn't prove the ScrollView is
// actually wrapped in the KeyboardAvoidingView — a structural check that walks the render tree
// is what actually guards the headline fix. Proven to catch a regression: swapping the real
// KeyboardAvoidingView for a plain View (i.e. reverting the fix) leaves the other tests in this
// file green, but this one goes red.
test('the sheet ScrollView is genuinely wrapped in a KeyboardAvoidingView, not just floating in the Modal', async () => {
  mockKeyboard({ isVisible: false, height: 0 });
  await renderAsync(<DevTestBubble />);
  await fireEventAsync.press(screen.getByLabelText('Open device-test companion'));
  const scroll = await screen.findByTestId('devtest-scroll');
  let node: ReactTestInstance | null = scroll.parent;
  let foundKeyboardAvoidingView = false;
  while (node) {
    if (node.props?.behavior === 'padding') {
      foundKeyboardAvoidingView = true;
      break;
    }
    node = node.parent;
  }
  expect(foundKeyboardAvoidingView).toBe(true);
});
