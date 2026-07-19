import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { space, type ThemePalette } from '@/theme/tokens';

export type ProgressStepState = 'done' | 'active' | 'pending';

export interface ProgressStepItem {
  key: string;
  label: string;
  state: ProgressStepState;
  onPress?: () => void;
  accessibilityLabel?: string;
}

/**
 * A horizontal progress timeline whose connectors always render in one background layer.
 *
 * Keeping every segment behind every dot fixes the Android sibling-painting failure where a
 * connector owned by the next step crossed the completed circle and its checkmark.
 */
export function ProgressSteps({
  steps,
  dotSize = 24,
  style,
}: {
  steps: ProgressStepItem[];
  dotSize?: number;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const checkSize = Math.max(11, Math.round(dotSize * 0.45));

  return (
    <View style={[styles.row, style]}>
      <View
        pointerEvents="none"
        style={[styles.lineLayer, { top: dotSize / 2 - 1 }]}
      >
        <View style={styles.lineGutter} />
        {steps.slice(1).map((step) => (
          <View
            key={step.key}
            style={[
              styles.line,
              step.state !== 'pending' && styles.lineDone,
            ]}
          />
        ))}
        <View style={styles.lineGutter} />
      </View>

      {steps.map((step) => {
        const content = (
          <>
            <View
              style={[
                styles.dot,
                { width: dotSize, height: dotSize, borderRadius: dotSize / 2 },
                step.state === 'done' && styles.dotDone,
              ]}
            >
              {step.state === 'done' ? (
                <Icon name="check" size={checkSize} color={t.mintInk} />
              ) : step.state === 'active' ? (
                <ActivityIndicator size="small" color={t.mint} />
              ) : null}
            </View>
            <Text
              variant="caption"
              color={step.state === 'pending' ? t.muted : t.text}
            >
              {step.label}
            </Text>
          </>
        );
        return step.onPress ? (
          <Pressable
            key={step.key}
            style={styles.step}
            onPress={step.onPress}
            accessibilityRole="button"
            accessibilityLabel={step.accessibilityLabel ?? step.label}
          >
            {content}
          </Pressable>
        ) : (
          <View key={step.key} style={styles.step}>
            {content}
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  lineLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    height: 2,
  },
  lineGutter: { flex: 0.5 },
  line: {
    flex: 1,
    height: 2,
    backgroundColor: t.line,
  },
  lineDone: { backgroundColor: t.mint },
  step: {
    flex: 1,
    alignItems: 'center',
    gap: space.xs,
  },
  dot: {
    borderWidth: 2,
    borderColor: t.line,
    backgroundColor: t.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotDone: {
    backgroundColor: t.mint,
    borderColor: t.mint,
  },
});
