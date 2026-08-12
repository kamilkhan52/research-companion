// DR-068 — Kamil: "using a font size... plus and minus signs besides current font size, and
// instant apply." The stepper row lives inside the paper screen's three-dot OverflowMenu, via
// OptionsSheet's new `render` slot (a compound row two Pressables can't express as one
// SheetOption). This exercises the row itself: label reflects the live scale, +/- adjust it,
// and bounds disable the buttons rather than wrapping/going negative.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';

jest.mock('@kesha-antonov/react-native-chat', () => ({
  Bubble: () => null, Chat: () => null, InputToolbar: () => null, MessageText: () => null,
}));

import { OverflowMenu } from '@/app/paper/[slug]';
import { ThemeProvider } from '@/theme/ThemeProvider';

const BASE_PROPS = {
  listeningMode: false,
  onToggleListening: jest.fn(),
  hasNotes: false,
  onViewNotes: jest.fn(),
  onRelatedWorks: jest.fn(),
  onGraph: jest.fn(),
  paperUrl: null,
  showFinishReading: false,
  showUpdateNotes: false,
  updateNotesDisabled: false,
  onUpdateNotes: jest.fn(),
  finishReadingDisabled: false,
  onFinishReading: jest.fn(),
  showContinue: false,
  onContinue: jest.fn(),
  modelLabel: 'DeepSeek v4',
  onPickModel: jest.fn(),
  showReadingMode: false,
  readingModeLabel: '',
  onPickReadingMode: jest.fn(),
  onRename: jest.fn(),
  onDelete: jest.fn(),
  showThreads: false,
  threadCount: 0,
  onThreads: jest.fn(),
};

async function openMenu() {
  await renderAsync(
    <ThemeProvider>
      <OverflowMenu {...BASE_PROPS} />
    </ThemeProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('More actions'));
}

test('the text-size row shows the default 100% and resolved size', async () => {
  await openMenu();
  expect(screen.getByText('100% · 17')).toBeTruthy();
});

test('pressing increase steps the scale up, applies instantly, and the sheet stays open', async () => {
  await openMenu();
  // Opus review, PR #385: each button's label now carries the CURRENT value too, so a screen
  // reader focusing it after a step announces the new percentage without swiping back to the
  // value text — assert against that live-updating label, not a bare action name.
  await fireEventAsync.press(screen.getByLabelText('Increase Discussion text size, currently 100 percent'));
  expect(screen.getByText('110% · 18.7')).toBeTruthy();
  expect(screen.getByLabelText('Increase Discussion text size, currently 110 percent')).toBeTruthy();
  // Still open: "More actions" trigger is a sibling, not visible while the sheet covers it,
  // but an unrelated row (e.g. Model) is still reachable without reopening.
  expect(screen.getByText('Model')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 350)); // outlast AsyncStorage's write
  expect(await AsyncStorage.getItem('rc.discussionTextScale')).toBe('1.1');
});

test('the decrease button disables at the minimum instead of going negative', async () => {
  await AsyncStorage.setItem('rc.discussionTextScale', '0.9');
  await openMenu();
  const decrease = screen.getByLabelText('Decrease Discussion text size, currently 90 percent');
  expect(decrease.props.accessibilityState.disabled).toBe(true);
  await fireEventAsync.press(decrease);
  expect(screen.getByText('90% · 15.3')).toBeTruthy();
});

test('the increase button disables at the maximum', async () => {
  await AsyncStorage.setItem('rc.discussionTextScale', '1.4');
  await openMenu();
  const increase = screen.getByLabelText('Increase Discussion text size, currently 140 percent');
  expect(increase.props.accessibilityState.disabled).toBe(true);
});

test('the text-size row has a leading badge and a "Discussion text" scope subtitle', async () => {
  await openMenu();
  expect(screen.getByText('Aa')).toBeTruthy();
  expect(screen.getByText('Discussion text')).toBeTruthy();
});

// Opus review round 2, PR #385: minus/value/plus left-to-right is the defining property of the
// round-1 layout fix (Kamil: "plus and minus signs BESIDES current font size") — swapping the
// two Pressables (plus/value/minus) left every other test in this file green, since none of
// them assert order. Walks the segmented control's own children rather than the two buttons'
// labels in isolation, so a reorder is the one thing this test can't miss.
test('the segmented control reads minus, value, plus — left to right', async () => {
  await openMenu();
  // Document order in the serialized tree is rendering order — a cheap, robust way to check
  // relative position without depending on exactly how many host-view layers sit between the
  // three elements (Pressable wraps its own View internally).
  const json = JSON.stringify(screen.toJSON());
  const decreaseAt = json.indexOf('Decrease Discussion text size, currently 100 percent');
  const valueAt = json.indexOf('100% · 17');
  const increaseAt = json.indexOf('Increase Discussion text size, currently 100 percent');
  expect(decreaseAt).toBeGreaterThan(-1);
  expect(valueAt).toBeGreaterThan(-1);
  expect(increaseAt).toBeGreaterThan(-1);
  expect(decreaseAt).toBeLessThan(valueAt);
  expect(valueAt).toBeLessThan(increaseAt);
});
