// DR-072 — the app-wide toast is rendered by a provider mounted at the app root, so it sits
// outside any screen's own keyboard-avoiding scope, same root cause as DR-055's mini player. A
// toast fired while the keyboard is open (saving notes, adding a paper from the composer) used
// to render behind it. Fixed the same way: read the global keyboard-controller state rather than
// depending on being inside a particular composer's KeyboardAvoidingView.

import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { Pressable, Text } from 'react-native';

import { ToastProvider, useToast } from '@/ui/Toast';
import { space } from '@/theme/tokens';

function bottom(node: ReactTestInstance): number | string | undefined {
  return (StyleSheet.flatten(node.props.style) as { bottom?: number | string }).bottom;
}

// Routes through the component's own selector, same reasoning as now-playing-keyboard.test.tsx:
// a bug that drops the `isVisible` check is something this can actually catch.
function mockKeyboard(state: { isVisible: boolean; height: number }) {
  jest.mocked(useKeyboardState).mockImplementation((selector) =>
    (selector ? selector(state as never) : state) as never,
  );
}

afterEach(() => {
  jest.mocked(useKeyboardState).mockReset();
});

function Fire({ message }: { message: string }) {
  const { toast } = useToast();
  return (
    <Pressable onPress={() => toast(message)}>
      <Text>fire</Text>
    </Pressable>
  );
}

test('keyboard closed: the toast sits at its ordinary safe-area position', async () => {
  mockKeyboard({ isVisible: false, height: 0 });
  const { unmountAsync } = await renderAsync(
    <ToastProvider>
      <Fire message="Saved" />
    </ToastProvider>,
  );
  await fireEventAsync.press(screen.getByText('fire'));
  expect(bottom(screen.getByTestId('toast-wrap'))).toBe(space.xxl);
  await unmountAsync();
});

test('keyboard open: the toast lifts above it instead of rendering behind it', async () => {
  mockKeyboard({ isVisible: true, height: 280 });
  const { unmountAsync } = await renderAsync(
    <ToastProvider>
      <Fire message="Saved" />
    </ToastProvider>,
  );
  await fireEventAsync.press(screen.getByText('fire'));
  expect(bottom(screen.getByTestId('toast-wrap'))).toBe(280 + space.sm);
  await unmountAsync();
});

// Same stale-height guard as DR-055's NowPlaying test: iOS reports keyboardWillHide with the
// outgoing keyboard's non-zero height, so `isVisible` is what stops that from keeping the toast
// lifted after the keyboard is actually gone.
test('a stale height reading after dismissal does not keep the toast lifted', async () => {
  mockKeyboard({ isVisible: false, height: 280 });
  const { unmountAsync } = await renderAsync(
    <ToastProvider>
      <Fire message="Saved" />
    </ToastProvider>,
  );
  await fireEventAsync.press(screen.getByText('fire'));
  expect(bottom(screen.getByTestId('toast-wrap'))).toBe(space.xxl);
  await unmountAsync();
});
