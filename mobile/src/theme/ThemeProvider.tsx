// The theme runtime (R.2, per docs/theming-design.md): resolves the persisted Settings mode
// (`system | dim | black | light`) plus the OS scheme into the active palette, and hands it
// out via useTheme()/useThemedStyles().
//
// Invariants the migration depends on:
//  • useTheme() returns the SAME object identity per resolved theme (the static maps in
//    tokens.ts, never rebuilt) — every useThemedStyles memo keys off that identity.
//  • The persisted mode is read BEFORE first paint (the ListeningProvider ready-gate idiom;
//    the splash covers the gap) so cold boot never flashes the wrong theme.
//  • `system` maps OS dark → Dim and OS light → Light; Black is opt-in only.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, useColorScheme } from 'react-native';

import { themes, type ThemeMode, type ThemeName, type ThemePalette } from './tokens';

/** What useColorScheme can actually hand us across platforms/RN versions. */
type OsScheme = 'light' | 'dark' | 'unspecified' | null | undefined;

const MODE_KEY = 'rc.themeMode';

export const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dim', label: 'Dim' },
  { mode: 'black', label: 'Black' },
  { mode: 'light', label: 'Light' },
];

export function resolveThemeName(mode: ThemeMode, osScheme: OsScheme): ThemeName {
  if (mode === 'system') return osScheme === 'light' ? 'light' : 'dim';
  return mode;
}

interface ThemeContextValue {
  /** The persisted Settings choice (what the user picked, not the computed result). */
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** The resolved palette name (mode + OS scheme). */
  themeName: ThemeName;
  /** The active palette — stable identity per themeName. */
  theme: ThemePalette;
}

// Default (no provider mounted): Dim, mode-setting a no-op. This keeps isolated component
// tests and any not-yet-wrapped tree rendering exactly like the pre-theming app; the real
// provider is wired at the app root in _layout.tsx.
const DEFAULT_VALUE: ThemeContextValue = {
  mode: 'system',
  setMode: () => {},
  themeName: 'dim',
  theme: themes.dim,
};

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_VALUE);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [ready, setReady] = useState(false);
  const osScheme = useColorScheme();

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY)
      .then((value) => {
        if (value === 'system' || value === 'dim' || value === 'black' || value === 'light') {
          setModeState(value);
        }
      })
      .finally(() => setReady(true));
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const themeName = resolveThemeName(mode, osScheme);
    return {
      mode,
      themeName,
      theme: themes[themeName],
      setMode: (next) => {
        setModeState(next);
        AsyncStorage.setItem(MODE_KEY, next);
      },
    };
  }, [mode, osScheme]);

  if (!ready) return null; // pre-paint gate: never flash the wrong theme on cold boot
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeMode(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** The active palette. The common read for migrated components. */
export function useTheme(): ThemePalette {
  return useThemeMode().theme;
}

// One StyleSheet per (factory, palette) pair, ever — palettes are static singletons, and
// factories must be module-level constants for this cache (and the identity contract above)
// to hold.
const styleCache = new WeakMap<object, Map<ThemePalette, unknown>>();

/** Replace a module-level `StyleSheet.create` with a themed factory:
 *    const makeStyles = (t: ThemePalette) => StyleSheet.create({ ... });
 *    …inside the component: const styles = useThemedStyles(makeStyles);
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (t: ThemePalette) => T,
): T {
  const theme = useTheme();
  let byTheme = styleCache.get(factory);
  if (!byTheme) {
    byTheme = new Map();
    styleCache.set(factory, byTheme);
  }
  let styles = byTheme.get(theme);
  if (!styles) {
    styles = factory(theme);
    byTheme.set(theme, styles);
  }
  return styles as T;
}
