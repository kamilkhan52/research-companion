// Bottom tab navigation — the redesign's four top-level destinations (Figma DS
// `Bottom Navigation`): Library · Discover · Notes · Map. A custom tab bar hosts the
// NowPlaying mini-player directly above the tab row, so audio stays visible on every tab
// without covering content; stack screens get the same card from the root layout instead.

import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { type ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NowPlaying } from '@/components/NowPlaying';
import { selectionTap } from '@/lib/haptics';
import { Text, type IconName } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { fonts, space, type ThemePalette } from '@/theme/tokens';

const TAB_META: Record<string, { label: string; icon: IconName }> = {
  index: { label: 'Library', icon: 'book-open' },
  discover: { label: 'Discover', icon: 'search' },
  notes: { label: 'Notes', icon: 'edit-3' },
  graph: { label: 'Map', icon: 'share-2' },
};

// The tab-bar renderer props type isn't re-exported by expo-router 56, so derive it.
type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

function TabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <NowPlaying inset={false} />
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        {state.routes.map((route, index) => {
          const meta = TAB_META[route.name];
          if (!meta) return null;
          const active = state.index === index;
          const tint = active ? t.mint : t.muted;
          return (
            <Pressable
              key={route.key}
              onPress={() => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!active && !event.defaultPrevented) {
                  selectionTap();
                  navigation.navigate(route.name);
                }
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={meta.label}
              style={styles.item}>
              <Feather name={meta.icon} size={20} color={tint} />
              <Text
                variant="caption"
                color={tint}
                style={active ? { fontFamily: fonts.bodySemiBold } : null}>
                {meta.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: t.bg },
      }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="discover" />
      <Tabs.Screen name="notes" />
      <Tabs.Screen name="graph" />
    </Tabs>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: t.line,
    backgroundColor: t.bg,
    paddingTop: space.sm,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: space.xs,
  },
});
