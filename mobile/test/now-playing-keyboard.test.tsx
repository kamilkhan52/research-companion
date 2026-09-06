// DR-055 — Kamil: "Opening the keyboard hides the mini player (observed with comment mode
// enabled)." Root cause: the STACK copy of NowPlaying is rendered as a sibling of the Stack at
// the root layout, outside any screen's own KeyboardAvoidingView (e.g. the paper screen's
// composer wraps only its own content). The window itself isn't resized when the keyboard opens
// (that's why screens use `behavior="padding"` rather than relying on OS resize), so a component
// outside that scope just sits where it was — behind the keyboard, not above it. This pushes the
// stack copy up by the keyboard's own height, using the same global keyboard-controller state
// the composer's KeyboardAvoidingView already relies on.
//
// Opus review (round 1) caught that applying the same fix to the TAB-BAR copy overshoots: that
// card sits above an in-flow tab row that does not move when the keyboard opens, so pushing it
// up by the full keyboard height leaves a gap the size of the tab row between the card and the
// keyboard. No tab screen has a bottom-anchored text input today, so the fix is scoped to the
// stack copy only — the tab-bar copy must never gain extra margin.

import { renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { space } from '@/theme/tokens';

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

jest.mock('@/store/listening', () => ({
  useListeningMode: () => ({ followNarrationInDiscussion: false }),
}));

function marginBottom(node: ReactTestInstance): number | string | undefined {
  return (StyleSheet.flatten(node.props.style) as { marginBottom?: number | string }).marginBottom;
}

// Routes through the component's own selector — `(s) => (s.isVisible ? s.height : 0)` — rather
// than short-circuiting the hook's return value, so a bug in that guard (e.g. dropping the
// isVisible check) is something these tests can actually catch.
function mockKeyboard(state: { isVisible: boolean; height: number }) {
  jest.mocked(useKeyboardState).mockImplementation((selector) =>
    (selector ? selector(state as never) : state) as never,
  );
}

afterEach(() => {
  jest.mocked(useKeyboardState).mockReset();
});

test('keyboard closed: a stack-hosted player uses the ordinary safe-area margin', async () => {
  mockKeyboard({ isVisible: false, height: 0 });
  await renderAsync(<NowPlaying inset={true} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBe(space.sm);
});

test('keyboard open: a stack-hosted player is pushed up by the full keyboard height', async () => {
  mockKeyboard({ isVisible: true, height: 280 });
  await renderAsync(<NowPlaying inset={true} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBe(280);
});

// iOS reports keyboardWillHide with the OUTGOING keyboard's non-zero height, and this hook only
// subscribes to keyboardWillShow/keyboardDidHide — so `isVisible` is the one thing standing
// between "hidden" and "still lifted by a stale height reading". Selector-bypassing mocks (a
// bare mockReturnValue on the hook) cannot exercise this at all.
test('a stale height reading after dismissal does not keep the player lifted', async () => {
  mockKeyboard({ isVisible: false, height: 280 });
  await renderAsync(<NowPlaying inset={true} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBe(space.sm);
});

test('keyboard open: the tab-bar player (inset=false) is NOT pushed up — it would overshoot the tab row', async () => {
  mockKeyboard({ isVisible: true, height: 280 });
  await renderAsync(<NowPlaying inset={false} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBeUndefined();
});

test('keyboard closed: the tab-bar player carries no extra margin either', async () => {
  mockKeyboard({ isVisible: false, height: 0 });
  await renderAsync(<NowPlaying inset={false} />);
  const wrap = screen.getByTestId('now-playing-wrap');
  expect(marginBottom(wrap)).toBeUndefined();
});
