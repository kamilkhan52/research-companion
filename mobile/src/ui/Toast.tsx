// A single, app-wide ephemeral confirmation toast (R.8). One brief line — "Added to library",
// "Settings saved" — that fades in near the bottom, holds, and fades out on its own. It exists
// so quick actions (add paper, save settings) get lightweight positive feedback without a
// modal or a persistent status line.
//
// Two ways to fire it:
//   • useToast().toast(msg)   — from components
//   • showToast(msg)          — imperatively, from non-component code (e.g. a react-query
//                               mutation's onSuccess in queries.ts, which can't call a hook)
// The imperative bridge is registered by the mounted <ToastProvider>; if none is mounted the
// call is a harmless no-op. Theme-aware via the design tokens, so it survives Phase C theming.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

/** How long the message holds at full opacity before it fades out. */
const HOLD_MS = 2200;
const FADE_IN_MS = 180;
const FADE_OUT_MS = 220;

type ToastFn = (message: string) => void;

// Imperative bridge: the mounted provider registers its dispatcher here so non-component code
// can fire a toast. Module-level, single-provider (matches the single-root app shell).
let dispatch: ToastFn | null = null;
export function showToast(message: string) {
  dispatch?.(message);
}

const ToastContext = createContext<{ toast: ToastFn }>({ toast: showToast });

/** Fire a toast from a component. Stable across renders. */
export function useToast(): { toast: ToastFn } {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback<ToastFn>((msg) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // Setting to null first guarantees the effect re-runs (restarts the animation) even when
    // the same message fires twice in a row.
    setMessage(null);
    setMessage(msg);
  }, []);

  // Register/unregister the imperative bridge for this provider's lifetime.
  useEffect(() => {
    dispatch = toast;
    return () => {
      if (dispatch === toast) dispatch = null;
    };
  }, [toast]);

  // Drive the fade-in → hold → fade-out cycle whenever a new message arrives.
  useEffect(() => {
    if (message == null) return;
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: FADE_IN_MS, useNativeDriver: true }).start();
    hideTimer.current = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: FADE_OUT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMessage(null);
      });
    }, HOLD_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [message, anim]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {message != null ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.wrap,
            {
              bottom: insets.bottom + space.xxl,
              opacity: anim,
              transform: [
                { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
              ],
            },
          ]}>
          <View style={styles.pill}>
            <Animated.Text style={styles.label} numberOfLines={1}>
              {message}
            </Animated.Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

// Reference implementation of the R.2 migration shape: a module-level themed factory read
// through useThemedStyles (one StyleSheet per palette, ever), replacing the module-level
// StyleSheet.create that snapshotted `colors` at import.
const makeStyles = (t: ThemePalette) => StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  pill: {
    maxWidth: '86%',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
  },
  label: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13.5,
    color: t.text,
    letterSpacing: 0.2,
  },
});
