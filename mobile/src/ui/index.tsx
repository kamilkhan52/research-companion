// Themed UI primitives built on the Scholar-dark tokens (Figma `01 · Design System`).
// Small, composable, and the single source for typography/surfaces so screens stay
// declarative and consistent. Manrope for UI text; Newsreader variants ('editorial',
// 'serifTitle', 'serifBody', 'serifItalic') for headings and long-form reading moments.

import { Feather } from '@expo/vector-icons';
import { type ComponentProps, type ReactNode } from 'react';
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

type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'label'
  | 'overline'
  | 'caption'
  | 'editorial'
  | 'serifTitle'
  | 'serifBody'
  | 'serifItalic'
  | 'mono'; // compat alias; maps to Manrope meta text, removed in the final revamp PR

const TEXT_STYLES: Record<TextVariant, object> = {
  // Manrope — UI scale (DS: Display/32, Section heading/22, body, METADATA·13/MEDIUM)
  display: { fontFamily: fonts.bodySemiBold, fontSize: 30, lineHeight: 38, color: colors.text },
  title: { fontFamily: fonts.bodySemiBold, fontSize: 21, lineHeight: 28, color: colors.text },
  heading: { fontFamily: fonts.bodySemiBold, fontSize: 16, lineHeight: 22, color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 15.5, lineHeight: 24, color: colors.text },
  label: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.muted, letterSpacing: 0.2 },
  overline: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12.5,
    color: colors.muted,
    letterSpacing: 1.1,
    textTransform: 'uppercase' as const,
  },
  caption: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17, color: colors.muted },
  // Newsreader — editorial scale
  editorial: { fontFamily: fonts.serifMedium, fontSize: 26, lineHeight: 32, color: colors.text },
  serifTitle: { fontFamily: fonts.serifMedium, fontSize: 20, lineHeight: 26, color: colors.text },
  serifBody: { fontFamily: fonts.serif, fontSize: 17, lineHeight: 26, color: colors.text },
  serifItalic: {
    fontFamily: fonts.serifItalic,
    fontSize: 17,
    lineHeight: 26,
    color: colors.text,
  },
  mono: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.muted },
};

export function Text({
  variant = 'body',
  color,
  style,
  ...rest
}: TextProps & { variant?: TextVariant; color?: string }) {
  return <RNText style={[TEXT_STYLES[variant], color ? { color } : null, style]} {...rest} />;
}

export type IconName = ComponentProps<typeof Feather>['name'];

export function Icon({
  name,
  size = 18,
  color = colors.muted,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <Feather name={name} size={size} color={color} />;
}

/** Circular tap target (back chevrons, kebab menus, header actions). */
export function IconButton({
  name,
  onPress,
  size = 18,
  color = colors.text,
  filled = true,
  disabled,
  style,
  ...rest
}: PressableProps & {
  name: IconName;
  size?: number;
  color?: string;
  /** false renders the bare icon without the elevated circle. */
  filled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [
        styles.iconBtn,
        filled && styles.iconBtnFilled,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style as object,
      ]}
      {...rest}>
      <Feather name={name} size={size} color={color} />
    </Pressable>
  );
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

export function Chip({
  label,
  color,
  selected = false,
  dot,
  onPress,
}: {
  label: string;
  color?: string;
  selected?: boolean;
  /** Show the small status dot (defaults on when a color is given, matching old call sites). */
  dot?: boolean;
  onPress?: () => void;
}) {
  const showDot = dot ?? color != null;
  const accent = selected ? colors.mint : (color ?? colors.muted);
  const inner = (
    <>
      {showDot ? <View style={[styles.chipDot, { backgroundColor: accent }]} /> : null}
      <Text variant="label" color={accent} style={selected ? { fontFamily: fonts.bodySemiBold } : null}>
        {label}
      </Text>
    </>
  );
  const chipStyle = [
    styles.chip,
    selected
      ? { borderColor: colors.mint, backgroundColor: 'rgba(101, 214, 180, 0.10)' }
      : { borderColor: color ?? colors.line2, backgroundColor: colors.surface },
  ];
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [chipStyle, pressed && styles.pressed]}>
        {inner}
      </Pressable>
    );
  }
  return <View style={chipStyle}>{inner}</View>;
}

export function ProgressBar({
  value,
  color = colors.mint,
  height = 6,
}: {
  /** 0..1 */
  value: number;
  color?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={[styles.progressTrack, { height, borderRadius: height / 2 }]}>
      <View
        style={{
          width: `${pct * 100}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: color,
        }}
      />
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
  icon,
  style,
  ...rest
}: PressableProps & {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: IconName;
}) {
  const isDisabled = disabled || loading;
  const fg =
    variant === 'primary' ? colors.mintInk : variant === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        variant === 'primary' && styles.btnPrimary,
        variant === 'ghost' && styles.btnGhost,
        variant === 'danger' && styles.btnDanger,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style as object,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.mintInk : colors.mint} />
      ) : (
        <>
          {icon ? <Feather name={icon} size={17} color={fg} /> : null}
          <Text variant="heading" color={fg}>
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export { ScrollView };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
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
    paddingHorizontal: 14,
    paddingVertical: 7,
    alignSelf: 'flex-start',
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnFilled: {
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.line,
  },
  progressTrack: {
    backgroundColor: colors.elevated,
    overflow: 'hidden',
    flexGrow: 1,
  },
  btn: {
    height: 50,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: space.xl,
  },
  btnPrimary: { backgroundColor: colors.mint },
  btnGhost: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.line2 },
  btnDanger: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.danger },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.45 },
});
