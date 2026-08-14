// Styled options menu (Figma `08b · Model + thinking picker` and `08c · Actions menu`): a
// violet-bordered card over a dim backdrop, rows of icon + title (+ optional subtitle), a
// check on the selected row, and optional section dividers. The ONLY menu idiom in the app
// (polish plan F.5) — per-message long-press and retry menus included; never use the native
// action sheet.

import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { DevTestModalTrigger } from '@/components/DevTestModalTrigger';
import { Icon, Text, type IconName } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

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
  /** Keep the menu open after this row, for a nested choice revealed in-place. */
  closeOnPress?: boolean;
  /** Visually nest a child choice under its parent row. */
  level?: number;
  onPress: () => void;
  /** DR-068 — replace the standard icon+title+subtitle Pressable row with custom content (e.g.
   *  a +/- stepper) for this one entry. `icon`/`onPress`/`disabled`/`closeOnPress` are ignored
   *  when set; the row never closes the sheet on its own (the custom content owns its own taps).
   *  `title`/`icon` are still required on the type so ordinary options stay simple to author,
   *  but a `render` row's own values there are unused. */
  render?: () => ReactNode;
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* Dismiss layer behind the card as a sibling, not an ancestor Pressable wrapping it —
           see RelatedWorksSheet.tsx for the on-device confirmation of why an ancestor Pressable
           blocks the ScrollView's drag-to-scroll below. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {/* DR-078: this menu lives in its own OS window, so the base-layer devtest bubble
            can't float over it — dev builds re-render the trigger here instead. */}
        <DevTestModalTrigger />
        <View style={styles.card}>
          <ScrollView bounces={false} style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}>
            {title ? (
              <Text variant="overline" color={t.violet} style={styles.title}>
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
                {opt.render ? (
                  opt.render()
                ) : (
                  <Pressable
                    onPress={() => {
                      if (opt.closeOnPress !== false) onClose();
                      opt.onPress();
                    }}
                    disabled={opt.disabled}
                    accessibilityRole="menuitem"
                    accessibilityState={{
                      selected: !!opt.selected,
                      disabled: !!opt.disabled,
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      opt.level ? styles.nestedRow : null,
                      pressed && { backgroundColor: t.elevated },
                      opt.disabled && { opacity: 0.45 },
                    ]}
                  >
                    <View style={[styles.badge, opt.selected && styles.badgeSelected]}>
                      <Icon
                        name={opt.selected ? 'check' : opt.icon}
                        size={16}
                        color={opt.selected ? t.mint : (opt.accent ?? t.muted)}
                      />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text variant="heading" numberOfLines={1} color={opt.accent ?? t.text}>
                        {opt.title}
                      </Text>
                      {opt.subtitle ? (
                        <Text variant="caption" numberOfLines={1}>
                          {opt.subtitle}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: t.scrim,
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    backgroundColor: t.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: t.violet,
    paddingVertical: space.sm,
    maxHeight: '75%',
  },
  title: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  subtitle: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  divider: {
    height: 1,
    backgroundColor: t.line,
    marginVertical: space.sm,
    marginHorizontal: space.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  nestedRow: {
    paddingLeft: space.xl * 2,
    backgroundColor: t.bg,
  },
  badge: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: { backgroundColor: t.mintWashStrong },
});
