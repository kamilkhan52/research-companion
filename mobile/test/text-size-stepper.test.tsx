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
  await fireEventAsync.press(screen.getByLabelText('Increase Discussion text size'));
  expect(screen.getByText('110% · 18.7')).toBeTruthy();
  // Still open: "More actions" trigger is a sibling, not visible while the sheet covers it,
  // but an unrelated row (e.g. Model) is still reachable without reopening.
  expect(screen.getByText('Model')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 350)); // outlast AsyncStorage's write
  expect(await AsyncStorage.getItem('rc.discussionTextScale')).toBe('1.1');
});

test('the decrease button disables at the minimum instead of going negative', async () => {
  await AsyncStorage.setItem('rc.discussionTextScale', '0.9');
  await openMenu();
  const decrease = screen.getByLabelText('Decrease Discussion text size');
  expect(decrease.props.accessibilityState.disabled).toBe(true);
  await fireEventAsync.press(decrease);
  expect(screen.getByText('90% · 15.3')).toBeTruthy();
});

test('the increase button disables at the maximum', async () => {
  await AsyncStorage.setItem('rc.discussionTextScale', '1.4');
  await openMenu();
  const increase = screen.getByLabelText('Increase Discussion text size');
  expect(increase.props.accessibilityState.disabled).toBe(true);
});
