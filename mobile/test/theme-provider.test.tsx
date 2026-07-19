// R.2 theming runtime: mode resolution (system → dim/light, Black opt-in only), persistence
// round-trip, the Dim default staying byte-identical to the legacy flat tokens, and the
// stable-identity + per-palette style caching every makeStyles migration depends on.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, renderAsync, screen } from '@testing-library/react-native';
import { Pressable, StyleSheet, Text } from 'react-native';

import {
  resolveThemeName,
  ThemeProvider,
  useThemedStyles,
  useThemeMode,
} from '@/theme/ThemeProvider';
import { themes, type ThemePalette } from '@/theme/tokens';

const makeProbeStyles = (t: ThemePalette) => StyleSheet.create({
  pill: { backgroundColor: t.bg },
});

const seenStyles: unknown[] = [];

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)]
    .sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function Probe() {
  const { mode, themeName, theme, setMode } = useThemeMode();
  const styles = useThemedStyles(makeProbeStyles);
  seenStyles.push(styles);
  return (
    <Pressable accessibilityLabel="cycle" onPress={() => setMode('black')}>
      <Text>{`mode:${mode} name:${themeName} bg:${theme.bg}`}</Text>
      <Text>{`stylebg:${StyleSheet.flatten(styles.pill).backgroundColor}`}</Text>
    </Pressable>
  );
}

afterEach(() => {
  seenStyles.length = 0;
});

test('system mode maps OS dark to Dim — Black is opt-in only', () => {
  expect(resolveThemeName('system', 'dark')).toBe('dim');
  expect(resolveThemeName('system', 'light')).toBe('light');
  expect(resolveThemeName('system', null)).toBe('dim');
  expect(resolveThemeName('black', 'light')).toBe('black');
  expect(resolveThemeName('light', 'dark')).toBe('light');
});

test('the Dim palette values are frozen (default stays a visual no-op)', () => {
  // The legacy flat export is gone (T.5 guard); pin the load-bearing Dim values instead.
  expect(themes.dim.bg).toBe('#0B0D12');
  expect(themes.dim.text).toBe('#F3F0E8');
  expect(themes.dim.mint).toBe('#65D6B4');
});

test('Light accent inks remain AA on the warm canvas', () => {
  expect(themes.light.mint).toBe('#15795F');
  expect(themes.light.amber).toBe('#8F6411');
  for (const accent of [
    themes.light.mint,
    themes.light.violet,
    themes.light.amber,
    themes.light.danger,
  ]) {
    expect(contrastRatio(accent, themes.light.bg)).toBeGreaterThanOrEqual(4.5);
  }
});

test('restores a persisted mode and persists changes', async () => {
  await AsyncStorage.setItem('rc.themeMode', 'light');
  await renderAsync(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

  expect(screen.getByText(`mode:light name:light bg:${themes.light.bg}`)).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByLabelText('cycle'));
  });
  expect(screen.getByText(`mode:black name:black bg:${themes.black.bg}`)).toBeTruthy();
  expect(await AsyncStorage.getItem('rc.themeMode')).toBe('black');
});

test('junk persisted mode falls back to system (following the OS scheme)', async () => {
  await AsyncStorage.setItem('rc.themeMode', 'banana');
  await renderAsync(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

  // Jest's RN preset reports an OS scheme of 'light', so system resolves to Light here.
  expect(screen.getByText(`mode:system name:light bg:${themes.light.bg}`)).toBeTruthy();
});

test('useThemedStyles caches one StyleSheet per palette and rebuilds on theme change', async () => {
  await AsyncStorage.setItem('rc.themeMode', 'dim');
  await renderAsync(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

  expect(screen.getByText(`stylebg:${themes.dim.bg}`)).toBeTruthy();
  const before = seenStyles[seenStyles.length - 1];

  await act(async () => {
    fireEvent.press(screen.getByLabelText('cycle')); // → black
  });
  expect(screen.getByText(`stylebg:${themes.black.bg}`)).toBeTruthy();
  const after = seenStyles[seenStyles.length - 1];
  expect(after).not.toBe(before); // new palette → new styles

  // Same palette across re-renders → the exact same StyleSheet object (the cache).
  const dimRenders = seenStyles.filter((s) => {
    const pill = (s as ReturnType<typeof makeProbeStyles>).pill;
    return StyleSheet.flatten(pill).backgroundColor === themes.dim.bg;
  });
  expect(new Set(dimRenders).size).toBe(1);
});

test('without a provider, components render Dim (migration-period default)', async () => {
  await renderAsync(<Probe />);
  expect(screen.getByText(`mode:system name:dim bg:${themes.dim.bg}`)).toBeTruthy();
});
