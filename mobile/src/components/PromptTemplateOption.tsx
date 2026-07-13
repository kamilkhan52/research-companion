import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, Text, type IconName } from '@/ui';
import { colors, radius, space } from '@/theme/tokens';

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
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.root, selected && styles.selected, pressed && { opacity: 0.84 }]}
    >
      <View style={[styles.badge, selected && styles.badgeSelected]}>
        <Icon name={selected ? 'check' : icon} size={16} color={selected ? colors.mint : colors.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="heading" color={selected ? colors.mint : colors.text}>{title}</Text>
        <Text variant="caption" style={{ marginTop: 2 }}>{description}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  selected: { borderColor: colors.mint, backgroundColor: 'rgba(101, 214, 180, 0.08)' },
  badge: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: { backgroundColor: 'rgba(101, 214, 180, 0.14)' },
});
