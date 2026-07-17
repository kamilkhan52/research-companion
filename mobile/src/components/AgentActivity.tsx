import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';

import { Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

export function AgentActivity({
  status,
  detail,
  emphasis = 'inline',
  testID,
}: {
  status: string;
  detail?: string;
  emphasis?: 'inline' | 'panel';
  testID?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const dots = useMemo(() => [new Animated.Value(0.35), new Animated.Value(0.35), new Animated.Value(0.35)], []);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      dots.forEach((dot, index) => dot.setValue(1 - index * 0.25));
      return;
    }
    const pulse = Animated.loop(
      Animated.stagger(
        160,
        dots.map((dot) =>
          Animated.sequence([
            Animated.timing(dot, { toValue: 1, duration: 280, useNativeDriver: true }),
            Animated.timing(dot, { toValue: 0.35, duration: 420, useNativeDriver: true }),
          ]),
        ),
      ),
    );
    pulse.start();
    return () => pulse.stop();
  }, [dots, reduceMotion]);

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLiveRegion="polite"
      accessibilityLabel={[status, detail].filter(Boolean).join('. ')}
      style={[styles.root, emphasis === 'panel' && styles.panel]}
    >
      <View style={styles.dots} accessible={false}>
        {dots.map((opacity, index) => (
          <Animated.View key={index} style={[styles.dot, { opacity }]} />
        ))}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="label" color={t.text}>{status}</Text>
        {detail ? <Text variant="caption" numberOfLines={2}>{detail}</Text> : null}
      </View>
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  panel: {
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: t.line2,
    backgroundColor: t.surface,
  },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 5, width: 35 },
  dot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: t.mint },
});
