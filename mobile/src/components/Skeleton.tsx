import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
  const opacity = useRef(new Animated.Value(SKELETON_STATIC_OPACITY)).current;
  // Stay static until the asynchronous OS setting resolves; this prevents even a brief pulse for
  // readers who have requested reduced motion.
  const reduceMotion = useReduceMotion(true);

  useEffect(() => {
    if (reduceMotion) {
      opacity.stopAnimation();
      opacity.setValue(SKELETON_STATIC_OPACITY);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: SKELETON_MAX_OPACITY,
          duration: SKELETON_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: SKELETON_MIN_OPACITY,
          duration: SKELETON_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity, reduceMotion]);

  return (
    <Animated.View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy: true }}
      style={[style, { opacity }]}
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
