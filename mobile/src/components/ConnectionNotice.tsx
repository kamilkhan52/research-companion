import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { space, type ThemePalette } from '@/theme/tokens';
import { Text, ToneIcon, ToneSurface } from '@/ui';

/** Quiet poll status for a response that is still safe server-side. It has no dismissal action:
 *  the owner removes it on the first successful snapshot, so it can never outlive the condition. */
export function ConnectionNotice({ message, style }: { message: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <ToneSurface
      tone="neutral"
      style={[styles.root, style]}
      accessibilityLabel={message}
      accessibilityLiveRegion="polite"
    >
      <ToneIcon name="wifi-off" compact />
      <Text variant="caption" color={t.muted} style={styles.text}>{message}</Text>
    </ToneSurface>
  );
}

const makeStyles = (_t: ThemePalette) => StyleSheet.create({
  root: {
    padding: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  text: { flex: 1, minWidth: 0 },
});
