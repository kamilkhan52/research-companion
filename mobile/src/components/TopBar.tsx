// App headers. Two shapes from the Figma proposal:
//   TabHeader — big left-aligned display title with a right-side icon cluster; used by the
//               four tab screens (Library, Discover, Notes, Map).
//   TopBar    — stack/modal header: circular back button, centered mint title (+ subtitle),
//               optional right actions; used by screens pushed over the tabs.

import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { IconButton as UIIconButton, Text, type IconName } from '@/ui';
import { colors, space } from '@/theme/tokens';

export function TabHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  /** Right-side Feather icon buttons, rendered borderless per the proposal's tab headers.
   * `badge` overlays a small amber dot (e.g. "the graph is stale") on the icon. */
  actions?: { name: IconName; onPress: () => void; accessibilityLabel: string; badge?: boolean }[];
}) {
  return (
    <View style={styles.tabHeader}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="display" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" numberOfLines={1} style={{ marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actions?.length ? (
        <View style={styles.tabActions}>
          {actions.map((a) => (
            <View key={a.accessibilityLabel}>
              <UIIconButton
                name={a.name}
                size={21}
                color={colors.muted}
                filled={false}
                onPress={a.onPress}
                accessibilityLabel={a.accessibilityLabel}
              />
              {a.badge ? <View style={styles.badge} /> : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
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
        {onBack ? (
          <UIIconButton name="chevron-left" size={20} onPress={onBack} accessibilityLabel="Back" />
        ) : null}
      </View>
      <View style={styles.center}>
        <Text variant="heading" style={{ fontSize: 18 }} numberOfLines={1} color={colors.mint}>
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
  tabHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    gap: space.sm,
  },
  tabActions: { flexDirection: 'row', gap: 2, marginTop: 4 },
  badge: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.amber,
  },
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
});
