// Themed UI primitives built on the Neon tokens. Small, composable, and the single source for
// typography/surfaces so screens stay declarative and consistent.

import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  ScrollView,
  StyleSheet,
  Text as RNText,
  type TextProps,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { colors, fonts, radius, space } from '@/theme/tokens';

type TextVariant = 'display' | 'title' | 'heading' | 'body' | 'label' | 'mono' | 'caption';

const TEXT_STYLES: Record<TextVariant, object> = {
  display: { fontFamily: fonts.displayBold, fontSize: 26, color: colors.text, letterSpacing: 0.3 },
  title: { fontFamily: fonts.display, fontSize: 19, color: colors.text, letterSpacing: 0.2 },
  heading: { fontFamily: fonts.bodySemiBold, fontSize: 16, color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 15.5, color: colors.text, lineHeight: 24 },
  label: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.muted, letterSpacing: 0.2 },
  caption: { fontFamily: fonts.body, fontSize: 12.5, color: colors.muted },
  mono: { fontFamily: fonts.mono, fontSize: 13, color: colors.muted },
};

export function Text({
  variant = 'body',
  color,
  style,
  ...rest
}: TextProps & { variant?: TextVariant; color?: string }) {
  return <RNText style={[TEXT_STYLES[variant], color ? { color } : null, style]} {...rest} />;
}

export function Screen({
  children,
  edges = ['top', 'bottom'],
  style,
}: {
  children: ReactNode;
  edges?: Edge[];
  style?: ViewProps['style'];
}) {
  return (
    <SafeAreaView style={[styles.screen, style]} edges={edges}>
      {children}
    </SafeAreaView>
  );
}

export function Card({ style, children, ...rest }: ViewProps) {
  return (
    <View style={[styles.card, style]} {...rest}>
      {children}
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Chip({ label, color = colors.muted }: { label: string; color?: string }) {
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text variant="caption" color={color} style={{ fontFamily: fonts.bodyMedium }}>
        {label}
      </Text>
    </View>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  style,
  ...rest
}: PressableProps & {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        variant === 'primary' && styles.btnPrimary,
        variant === 'ghost' && styles.btnGhost,
        variant === 'danger' && styles.btnDanger,
        pressed && !isDisabled && styles.btnPressed,
        isDisabled && styles.btnDisabled,
        style as object,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.cyanInk : colors.cyan} />
      ) : (
        <Text
          variant="heading"
          color={variant === 'primary' ? colors.cyanInk : variant === 'danger' ? colors.danger : colors.text}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export { ScrollView };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: space.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  btn: {
    height: 50,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: space.lg,
  },
  btnPrimary: { backgroundColor: colors.cyan },
  btnGhost: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line2 },
  btnDanger: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.danger },
  btnPressed: { opacity: 0.82 },
  btnDisabled: { opacity: 0.45 },
});
