import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, Text, type IconName } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

export function PromptTemplateOption({
  title,
  description,
  icon,
  selected,
  onPress,
}: {
  title: string;
  description: string;
  icon: IconName;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.root, selected && styles.selected, pressed && { opacity: 0.84 }]}
    >
      <View style={[styles.badge, selected && styles.badgeSelected]}>
        <Icon name={selected ? 'check' : icon} size={16} color={selected ? t.mint : t.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="heading" color={selected ? t.mint : t.text}>{title}</Text>
        <Text variant="caption" style={{ marginTop: 2 }}>{description}</Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: t.line,
    borderRadius: radius.md,
    backgroundColor: t.surface,
  },
  selected: { borderColor: t.mint, backgroundColor: t.mintWash },
  badge: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: t.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: { backgroundColor: t.mintWashStrong },
});
