// A minus / live-value / plus row for an OptionsSheet `render` slot (DR-068's layout, Kamil:
// "plus and minus signs besides current font size, and instant apply").
//
// Extracted from paper/[slug].tsx for DR-135, which needs the same control twice more in the
// narration settings sheet. The geometry is the contract: a 38px leading badge so the row's
// glyph lines up with every ordinary sheet row's icon badge, two full 48px targets, and the
// readout BETWEEN them — a review round on PR #385 caught that swapping the two buttons left
// every test green, so order is asserted explicitly by the tests that use this.

import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, Text, type IconName } from '@/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { control, radius, space } from '@/theme/tokens';

export function SettingsStepperRow({
  badge,
  badgeIcon,
  title,
  subtitle,
  value,
  valueLabel,
  /** What the two buttons adjust, in the reader's words — each button's accessibility label
   *  carries the CURRENT value too, so a screen reader focusing it after a step announces the
   *  new value without swiping back to the readout (PR #385 review). */
  scopeLabel,
  atMin,
  atMax,
  onDecrease,
  onIncrease,
}: {
  /** Two-letter type specimen ("Aa"), when the row is about type. */
  badge?: string;
  /** Feather glyph, when it is not. Exactly one of `badge`/`badgeIcon` should be given. */
  badgeIcon?: IconName;
  title: string;
  subtitle?: string;
  value: string;
  /** Spoken form of `value`, when the on-screen form is glyphy ("100%" → "100 percent"). */
  valueLabel?: string;
  scopeLabel: string;
  atMin: boolean;
  atMax: boolean;
  onDecrease: () => void;
  onIncrease: () => void;
}) {
  const t = useTheme();
  const spoken = valueLabel ?? value;
  return (
    <View style={styles.row}>
      <View style={[styles.badge, { backgroundColor: t.elevated }]}>
        {badgeIcon ? (
          <Icon name={badgeIcon} size={16} color={t.muted} />
        ) : (
          <Text variant="heading" color={t.muted}>{badge}</Text>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="heading" numberOfLines={1}>{title}</Text>
        {subtitle ? (
          <Text variant="caption" color={t.muted} numberOfLines={1}>{subtitle}</Text>
        ) : null}
      </View>
      <View style={[styles.segmented, { borderColor: t.line2 }]}>
        <Pressable
          onPress={onDecrease}
          disabled={atMin}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${scopeLabel}, currently ${spoken}`}
          style={[styles.segBtn, atMin && { opacity: 0.4 }]}>
          <Icon name="minus" size={16} color={t.text} />
        </Pressable>
        <Text variant="caption" color={t.muted} style={styles.segValue} numberOfLines={1}>
          {value}
        </Text>
        <Pressable
          onPress={onIncrease}
          disabled={atMax}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${scopeLabel}, currently ${spoken}`}
          style={[styles.segBtn, atMax && { opacity: 0.4 }]}>
          <Icon name="plus" size={16} color={t.text} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  // Matches OptionsSheet's own badge (38px, elevated fill) so this row's leading glyph lines
  // up with every ordinary row's icon badge rather than starting flush against the sheet edge.
  badge: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  segBtn: {
    width: control.minTouch,
    height: control.minTouch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segValue: { minWidth: 62, textAlign: 'center' },
});
