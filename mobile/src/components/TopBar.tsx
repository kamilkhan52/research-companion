// App headers. Two shapes from the Figma proposal:
//   TabHeader — big left-aligned display title with a right-side icon cluster; used by the
//               four tab screens (Library, Discover, Notes, Map).
//   TopBar    — stack/modal header: circular back button, centered mint title (+ subtitle),
//               optional right actions; used by screens pushed over the tabs.

import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { IconButton as UIIconButton, Text, type IconName } from '@/ui';
import { Marquee } from '@/ui/Marquee';
import {
  useTheme,
  useThemedStyles,
  type DensityMode,
} from '@/theme/ThemeProvider';
import { fonts, space, type ThemePalette } from '@/theme/tokens';

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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
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
                color={t.muted}
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
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.bar}>
      <View style={styles.side}>
        {onBack ? (
          <UIIconButton name="chevron-left" size={20} onPress={onBack} accessibilityLabel="Back" />
        ) : null}
      </View>
      <View style={styles.center}>
        {/* Long paper titles auto-scroll instead of clipping (U.21); short ones stay
            static and centered. The stretch wrapper gives the marquee the full row width
            (styles.center centers its children, which would shrink-wrap it). */}
        <View style={{ alignSelf: 'stretch' }}>
          <Marquee text={title} align="center" textStyle={styles.titleText} />
        </View>
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

const makeStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  return StyleSheet.create({
  tabHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: tight ? space.md : space.lg,
    paddingTop: tight ? space.sm : space.md,
    paddingBottom: tight ? space.sm : space.md,
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
    backgroundColor: t.amber,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingBottom: tight ? space.sm : space.md,
    paddingTop: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: t.line,
    gap: space.sm,
  },
  side: { minWidth: 44, flexDirection: 'row', gap: space.xs, justifyContent: 'center' },
  sideRight: { justifyContent: 'flex-end' },
  center: { flex: 1, minWidth: 0, alignItems: 'center' },
  titleText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: tight ? 14.5 : 15.5,
    lineHeight: tight ? 20 : 21,
    color: t.mint,
  },
  });
};
