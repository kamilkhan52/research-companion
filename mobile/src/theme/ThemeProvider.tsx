// The appearance runtime (R.2/R10.25): resolves the persisted color mode and layout density,
// then hands both to useTheme()/useThemedStyles().
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
const DENSITY_KEY = 'rc.layoutDensity';

export type DensityMode = 'comfortable' | 'tight';

export const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dim', label: 'Dim' },
  { mode: 'black', label: 'Black' },
  { mode: 'light', label: 'Light' },
];

export const DENSITY_MODES: { mode: DensityMode; label: string }[] = [
  { mode: 'comfortable', label: 'Comfortable' },
  { mode: 'tight', label: 'Tight' },
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
  /** Device-local reading/list rhythm. Comfortable is the unchanged default. */
  density: DensityMode;
  setDensity: (density: DensityMode) => void;
}

// Default (no provider mounted): Dim, mode-setting a no-op. This keeps isolated component
// tests and any not-yet-wrapped tree rendering exactly like the pre-theming app; the real
// provider is wired at the app root in _layout.tsx.
const DEFAULT_VALUE: ThemeContextValue = {
  mode: 'system',
  setMode: () => {},
  themeName: 'dim',
  theme: themes.dim,
  density: 'comfortable',
  setDensity: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_VALUE);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [density, setDensityState] = useState<DensityMode>('comfortable');
  const [ready, setReady] = useState(false);
  const osScheme = useColorScheme();

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(MODE_KEY), AsyncStorage.getItem(DENSITY_KEY)])
      .then(([storedMode, storedDensity]) => {
        if (
          storedMode === 'system' ||
          storedMode === 'dim' ||
          storedMode === 'black' ||
          storedMode === 'light'
        ) {
          setModeState(storedMode);
        }
        if (storedDensity === 'comfortable' || storedDensity === 'tight') {
          setDensityState(storedDensity);
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
      density,
      setMode: (next) => {
        setModeState(next);
        AsyncStorage.setItem(MODE_KEY, next);
      },
      setDensity: (next) => {
        setDensityState(next);
        AsyncStorage.setItem(DENSITY_KEY, next);
      },
    };
  }, [density, mode, osScheme]);

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

export function useDensity(): DensityMode {
  return useThemeMode().density;
}

// One StyleSheet per (factory, palette, density) tuple, ever — palettes are static singletons,
// and factories must be module-level constants for this cache to hold.
const styleCache = new WeakMap<object, Map<ThemePalette, Map<DensityMode, unknown>>>();

/** Replace a module-level `StyleSheet.create` with a themed factory:
 *    const makeStyles = (t: ThemePalette) => StyleSheet.create({ ... });
 *    …inside the component: const styles = useThemedStyles(makeStyles);
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (t: ThemePalette, density: DensityMode) => T,
): T {
  const { theme, density } = useThemeMode();
  let byTheme = styleCache.get(factory);
  if (!byTheme) {
    byTheme = new Map();
    styleCache.set(factory, byTheme);
  }
  let byDensity = byTheme.get(theme);
  if (!byDensity) {
    byDensity = new Map();
    byTheme.set(theme, byDensity);
  }
  let styles = byDensity.get(density);
  if (!styles) {
    styles = factory(theme, density);
    byDensity.set(density, styles);
  }
  return styles as T;
}
