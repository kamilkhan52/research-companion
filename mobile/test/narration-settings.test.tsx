// DR-135 — Kamil: "Reduce narration text font size… It generally just seems out of place, the
// whole view. I don't know why. Maybe the font too? Actually give me a settings menu for
// narration: font, font size and other relevant things", then: "Where we currently show
// narration speed, we can have a button that opens a menu of options."
//
// What was actually out of step: the transcript was Manrope SemiBold 21/32 — the `title`
// variant's exact metrics, a section-HEADING size at a heading WEIGHT, in the UI face, on the
// one screen whose whole job is reading prose, directly under a Newsreader header. These pin
// the three halves of the fix: a smaller default in the reading face, a menu that reaches it,
// and preferences that survive a relaunch.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEventAsync, renderAsync, screen } from '@testing-library/react-native';
import { StyleSheet, Text as RNText } from 'react-native';

import { RollingTranscript } from '@/components/NarrationTranscript';
import { NarrationSettingsButton } from '@/components/player/NarrationSettingsButton';
import {
  ListeningProvider,
  NARRATION_FACES,
  clampNarrationScale,
  narrationTextStyle,
} from '@/store/listening';
import { makeTextStyles } from '@/ui';
import { themes, fonts } from '@/theme/tokens';

afterEach(() => AsyncStorage.clear());

async function openMenu() {
  await renderAsync(
    <ListeningProvider>
      <NarrationSettingsButton />
    </ListeningProvider>,
  );
  await fireEventAsync.press(screen.getByLabelText('Narration settings. Speed 1 times.'));
}

const comfortable = makeTextStyles(themes.dim, 'comfortable');

test('the default transcript type is the READING face, not the interface face', () => {
  const style = narrationTextStyle('serif', 1);
  expect(style.fontFamily).toBe(fonts.serif);
  // The same family the app uses for every other run of prose (Claude's replies, notes).
  expect(style.fontFamily).toBe(comfortable.serifBody.fontFamily);
  // …and NOT the semibold UI face the roll used to be set in.
  expect(style.fontFamily).not.toBe(fonts.bodySemiBold);
});

test('the default transcript is smaller than the heading metrics it used to borrow', () => {
  const style = narrationTextStyle('serif', 1);
  // The old literal was 21/32, which is `title` (a section heading) to the pixel.
  expect(comfortable.title.fontSize).toBe(21);
  expect(style.fontSize!).toBeLessThan(21);
  expect(style.lineHeight!).toBeLessThan(32);
  // Still deliberately LARGER than body prose: this is read at arm's length, in motion.
  expect(style.fontSize!).toBeGreaterThan(comfortable.body.fontSize!);
});

test('the two faces are optically matched, so switching is a face change and not a size jump', () => {
  // Newsreader has the smaller x-height, so it carries the larger point size for the same
  // apparent size. A future edit that makes the sans the bigger number is the regression.
  expect(NARRATION_FACES.serif.fontSize).toBeGreaterThan(NARRATION_FACES.sans.fontSize);
  expect(NARRATION_FACES.sans.family).toBe(fonts.body);
});

test('scale clamps to its bounds, rounds to one decimal, and rejects junk', () => {
  expect(clampNarrationScale(5)).toBe(1.5);
  expect(clampNarrationScale(0.1)).toBe(0.8);
  // 0.1 has no exact binary representation: naive stepping yields 1.2000000000000002, which
  // would be persisted verbatim and then fail every `=== 1.2` downstream.
  expect(clampNarrationScale(1.1 + 0.1)).toBe(1.2);
  expect(clampNarrationScale(Number.NaN)).toBe(1);
});

test('the trigger opens a narration menu carrying speed, text size and both faces', async () => {
  await openMenu();
  expect(screen.getByText('Narration')).toBeTruthy();
  expect(screen.getByText('Speed')).toBeTruthy();
  expect(screen.getByText('Text size')).toBeTruthy();
  expect(screen.getByText('Serif')).toBeTruthy();
  expect(screen.getByText('Sans')).toBeTruthy();
  // The preview is what makes the sheet usable at all — it covers the transcript, so without
  // it every step would mean closing the menu, looking, and reopening it.
  expect(screen.getByTestId('narration-settings-preview')).toBeTruthy();
});

test('stepping the text size applies live, persists, and leaves the menu open', async () => {
  await openMenu();
  await fireEventAsync.press(
    screen.getByLabelText('Increase narration text size, currently 100 percent'),
  );
  expect(screen.getByText('110%')).toBeTruthy();
  // Still open: an unrelated row is reachable without reopening.
  expect(screen.getByText('Speed')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 350)); // outlast AsyncStorage's write
  expect(await AsyncStorage.getItem('rc.narration.textScale')).toBe('1.1');
});

test('the preview re-renders in the size that was just chosen', async () => {
  await openMenu();
  // StyleSheet.flatten, not a hand-rolled spread: Text's own variant style wraps the style
  // prop in a nested array, and a shallow merge silently returns the VARIANT's size (15.5)
  // for every scale, which would make this test pass with the preview completely unwired.
  const previewSize = () => {
    const text = screen.getByTestId('narration-settings-preview').findByType(RNText);
    return (StyleSheet.flatten(text.props.style) as { fontSize?: number }).fontSize;
  };
  const before = previewSize()!;
  expect(before).toBe(narrationTextStyle('serif', 1).fontSize); // wired to the real setting
  await fireEventAsync.press(
    screen.getByLabelText('Decrease narration text size, currently 100 percent'),
  );
  expect(previewSize()!).toBeLessThan(before);
});

test('choosing a face applies it and persists it', async () => {
  await openMenu();
  await fireEventAsync.press(screen.getByText('Sans'));
  await new Promise((r) => setTimeout(r, 350));
  expect(await AsyncStorage.getItem('rc.narration.face')).toBe('sans');
});

// The wiring that actually matters: a setting nobody reads is not a setting. The sheet's own
// preview is a separate component, so it passing proves nothing about the roll itself.
test('the rolling transcript renders in the persisted face and size, not a hardcoded one', async () => {
  await AsyncStorage.multiSet([
    ['rc.narration.face', 'sans'],
    ['rc.narration.textScale', '1.2'],
  ]);
  await renderAsync(
    <ListeningProvider>
      <RollingTranscript narration="One sentence. Another sentence." />
    </ListeningProvider>,
  );

  const expected = narrationTextStyle('sans', 1.2);
  const line = StyleSheet.flatten(
    screen.getByText('One sentence.').props.style,
  ) as { fontFamily?: string; fontSize?: number; lineHeight?: number };
  expect(line.fontFamily).toBe(expected.fontFamily);
  expect(line.fontSize).toBe(expected.fontSize);
  expect(line.lineHeight).toBe(expected.lineHeight);
});

test('the speed stepper walks the rate ladder and stops at its ends', async () => {
  await AsyncStorage.setItem('rc.playbackRate', '1');
  await openMenu();
  const decrease = screen.getByLabelText('Decrease narration speed, currently 1 times');
  expect(decrease.props.accessibilityState.disabled).toBe(true); // 1× is the floor, no wrap
  await fireEventAsync.press(
    screen.getByLabelText('Increase narration speed, currently 1 times'),
  );
  // The trigger pill also reads the speed, so match the stepper by its own label.
  expect(screen.getByLabelText('Increase narration speed, currently 1.25 times')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 350));
  expect(await AsyncStorage.getItem('rc.playbackRate')).toBe('1.25');
});

test('persisted narration preferences are restored, and junk falls back to the default', async () => {
  await AsyncStorage.multiSet([
    ['rc.narration.face', 'banana'],
    ['rc.narration.textScale', 'banana'],
  ]);
  await openMenu();
  expect(screen.getByText('100%')).toBeTruthy();          // junk scale → default, not the min
  expect(
    screen.getByLabelText('Increase narration text size, currently 100 percent'),
  ).toBeTruthy();

  // A real pair round-trips.
  AsyncStorage.clear();
  await AsyncStorage.multiSet([
    ['rc.narration.face', 'sans'],
    ['rc.narration.textScale', '1.3'],
  ]);
  await screen.unmountAsync();
  await openMenu();
  expect(screen.getByText('130%')).toBeTruthy();
});
