// App top bar: a sticky header with an optional back affordance, a centered display-font title,
// and an optional right-side action. Mirrors the web client's topbar.

import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

export function IconButton({ glyph, onPress, accessibilityLabel, active = false }: {
  glyph: string;
  onPress: () => void;
  accessibilityLabel: string;
  active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.iconBtn, active && styles.iconBtnActive, pressed && styles.iconBtnPressed]}>
      <Text style={[styles.glyph, active && styles.glyphActive]}>{glyph}</Text>
    </Pressable>
  );
}

export function TopBar({
  title,
  onBack,
  right,
  subtitle,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
  subtitle?: string;
}) {
  return (
    <View style={styles.bar}>
      <View style={styles.side}>
        {onBack ? <IconButton glyph="‹" onPress={onBack} accessibilityLabel="Back" /> : null}
      </View>
      <View style={styles.center}>
        <Text variant="title" numberOfLines={1} color={colors.cyan}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" numberOfLines={1} style={{ marginTop: 1 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={[styles.side, styles.sideRight]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    paddingTop: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: space.sm,
  },
  side: { minWidth: 44, flexDirection: 'row', gap: space.xs, justifyContent: 'center' },
  sideRight: { justifyContent: 'flex-end' },
  center: { flex: 1, alignItems: 'center' },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnPressed: { backgroundColor: colors.panelActive },
  iconBtnActive: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  glyph: { fontSize: 24, color: colors.text, lineHeight: 28 },
  glyphActive: { color: colors.cyanInk },
});
