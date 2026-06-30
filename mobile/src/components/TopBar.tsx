// App top bar: a sticky header with an optional back affordance, a centered display-font title,
// and an optional right-side action. Mirrors the web client's topbar.

import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

export function IconButton({ glyph, onPress, accessibilityLabel }: {
  glyph: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}>
      <Text style={styles.glyph}>{glyph}</Text>
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
  side: { width: 44, justifyContent: 'center' },
  sideRight: { alignItems: 'flex-end' },
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
  glyph: { fontSize: 24, color: colors.text, lineHeight: 28 },
});
