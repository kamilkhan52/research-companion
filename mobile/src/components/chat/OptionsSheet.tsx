// Styled options menu (Figma `08b · Model + thinking picker` and `08c · Actions menu`): a
// violet-bordered card over a dim backdrop, rows of icon + title (+ optional subtitle), a
// check on the selected row, and optional section dividers. The ONLY menu idiom in the app
// (polish plan F.5) — per-message long-press and retry menus included; never use the native
// action sheet.

import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon, Text, type IconName } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

export interface SheetOption {
  key: string;
  title: string;
  subtitle?: string;
  icon: IconName;
  /** Tint for the icon badge + title; defaults to quiet text. */
  accent?: string;
  selected?: boolean;
  disabled?: boolean;
  /** Draw a divider above this row (section break). */
  section?: boolean;
  onPress: () => void;
}

export function OptionsSheet({
  visible,
  onClose,
  title,
  subtitle,
  options,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** Longer editorial line under the overline title (e.g. a paper's full title). */
  subtitle?: string;
  options: SheetOption[];
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <ScrollView bounces={false} style={{ flexGrow: 0 }}>
            {title ? (
              <Text variant="overline" color={colors.violet} style={styles.title}>
                {title}
              </Text>
            ) : null}
            {subtitle ? (
              <Text variant="serifTitle" style={styles.subtitle} numberOfLines={4}>
                {subtitle}
              </Text>
            ) : null}
            {options.map((opt) => (
              <View key={opt.key}>
                {opt.section ? <View style={styles.divider} /> : null}
                <Pressable
                  onPress={() => {
                    onClose();
                    opt.onPress();
                  }}
                  disabled={opt.disabled}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: !!opt.selected, disabled: !!opt.disabled }}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: colors.elevated },
                    opt.disabled && { opacity: 0.45 },
                  ]}>
                  <View style={[styles.badge, opt.selected && styles.badgeSelected]}>
                    <Icon
                      name={opt.selected ? 'check' : opt.icon}
                      size={16}
                      color={opt.selected ? colors.mint : (opt.accent ?? colors.muted)}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      variant="heading"
                      numberOfLines={1}
                      color={opt.accent ?? colors.text}>
                      {opt.title}
                    </Text>
                    {opt.subtitle ? (
                      <Text variant="caption" numberOfLines={1}>
                        {opt.subtitle}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.violet,
    paddingVertical: space.sm,
    maxHeight: '75%',
  },
  title: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  subtitle: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: space.sm, marginHorizontal: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  badge: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: { backgroundColor: 'rgba(101, 214, 180, 0.14)' },
});
