// DR-055 — Kamil: "Opening the keyboard hides the mini player (observed with comment mode
// enabled)." Root cause: NowPlaying is rendered as a sibling of the Stack/tab bar at the root
// layout, outside any screen's own KeyboardAvoidingView (e.g. the paper screen's composer wraps
// only its own content). The window itself isn't resized when the keyboard opens (that's why
// screens use `behavior="padding"` rather than relying on OS resize), so a component outside
// that scope just sits where it was — behind the keyboard, not above it. This pushes it up by
// the keyboard's own height, using the same global keyboard-controller state the composer's
// KeyboardAvoidingView already relies on.

import { renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { NowPlaying } from '@/components/NowPlaying';

jest.mock('expo-router', () => ({
  router: { navigate: jest.fn() },
  usePathname: () => '/paper/awq',
}));

jest.mock('@/audio/AudioProvider', () => ({
  useAudio: () => ({
    prep: { id: 'p1', title: 'A Narration', stage: 'narrating', done: 0, total: 0 },
    cancelPrep: jest.fn(),
    dismiss: jest.fn(async () => undefined),
  }),
}));

function marginBottom(node: ReactTestInstance): number | string | undefined {
  return (StyleSheet.flatten(node.props.style) as { marginBottom?: number | string }).marginBottom;
}

afterEach(() => {
  jest.mocked(useKeyboardState).mockReset();
});

test('keyboard closed: a stack-hosted player uses the ordinary safe-area margin', async () => {
  jest.mocked(useKeyboardState).mockReturnValue(0);
  await renderAsync(<NowPlaying inset={true} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  // No keyboard: falls back to the safe-area/space.sm floor, never 0 and never a keyboard height.
  expect(marginBottom(wrap)).not.toBe(0);
});

test('keyboard open: a stack-hosted player is pushed up by the full keyboard height', async () => {
  jest.mocked(useKeyboardState).mockReturnValue(280);
  await renderAsync(<NowPlaying inset={true} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBe(280);
});

test('keyboard open: the tab-bar player (inset=false) also gets pushed up', async () => {
  jest.mocked(useKeyboardState).mockReturnValue(280);
  await renderAsync(<NowPlaying inset={false} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBe(280);
});

test('keyboard closed: the tab-bar player carries no extra margin, unlike the stack copy', async () => {
  jest.mocked(useKeyboardState).mockReturnValue(0);
  await renderAsync(<NowPlaying inset={false} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBeUndefined();
});
