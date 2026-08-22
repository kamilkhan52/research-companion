import { useEffect, type ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useReduceMotion } from '@/hooks/useReduceMotion';
import { useTheme } from '@/theme/ThemeProvider';
import { radius } from '@/theme/tokens';

const SKELETON_MIN_OPACITY = 0.52;
const SKELETON_MAX_OPACITY = 0.86;
const SKELETON_STATIC_OPACITY = 0.72;
const SKELETON_HALF_CYCLE_MS = 520;

export function SkeletonGroup({
  label,
  children,
  style,
  testID,
}: {
  label: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const opacity = useSharedValue(SKELETON_STATIC_OPACITY);
  // Stay static until the OS setting is known (the module cache in useReduceMotion makes it
  // known synchronously after the app's first resolve); this prevents even a brief pulse for
  // readers who have requested reduced motion.
  const reduceMotion = useReduceMotion(true);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(opacity);
      opacity.value = SKELETON_STATIC_OPACITY;
      return;
    }
    // DR-101 — Reanimated, not RN Animated, and the choice is load-bearing: this pulse's whole
    // job is to run while the JS thread is BLOCKED mounting the surface it covers. RN
    // Animated's loop/sequence restarts round-trip through JS (and its pulse measured frozen
    // on device even mid-cycle); withRepeat(withTiming) lives entirely on the UI thread.
    opacity.value = SKELETON_MIN_OPACITY;
    opacity.value = withRepeat(
      withTiming(SKELETON_MAX_OPACITY, {
        duration: SKELETON_HALF_CYCLE_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(opacity);
    };
  }, [opacity, reduceMotion]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy: true }}
      style={[style, pulseStyle]}
    >
      {children}
    </Animated.View>
  );
}

export function Skeleton({
  width = '100%',
  height,
  radius: cornerRadius = radius.sm,
  style,
  testID,
}: {
  width?: DimensionValue;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.block,
        { width, height, borderRadius: cornerRadius, backgroundColor: t.skeleton },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  block: { overflow: 'hidden' },
});
