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
import { useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { impactTap } from '@/lib/haptics';
import {
  useTheme,
  useThemedStyles,
  type DensityMode,
} from '@/theme/ThemeProvider';
import { fonts, radius, space, type ThemePalette } from '@/theme/tokens';

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
  | 'serifItalic';

const makeTextStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  return StyleSheet.create({
  // Manrope — UI scale (DS: Display/32, Section heading/22, body, METADATA·13/MEDIUM)
  display: {
    fontFamily: fonts.bodySemiBold,
    fontSize: tight ? 27 : 30,
    lineHeight: tight ? 34 : 38,
    color: t.text,
  },
  title: {
    fontFamily: fonts.bodySemiBold,
    fontSize: tight ? 19 : 21,
    lineHeight: tight ? 25 : 28,
    color: t.text,
  },
  heading: {
    fontFamily: fonts.bodySemiBold,
    fontSize: tight ? 15 : 16,
    lineHeight: tight ? 20 : 22,
    color: t.text,
  },
  body: {
    fontFamily: fonts.body,
    fontSize: tight ? 14 : 15.5,
    lineHeight: tight ? 21 : 24,
    color: t.text,
  },
  label: {
    fontFamily: fonts.bodyMedium,
    fontSize: tight ? 12.5 : 13,
    color: t.muted,
    letterSpacing: 0.2,
  },
  overline: {
    fontFamily: fonts.bodyMedium,
    fontSize: tight ? 11.5 : 12.5,
    color: t.muted,
    letterSpacing: 1.1,
    textTransform: 'uppercase' as const,
  },
  caption: {
    fontFamily: fonts.body,
    fontSize: tight ? 12 : 12.5,
    lineHeight: tight ? 16 : 17,
    color: t.muted,
  },
  // Newsreader — editorial scale
  editorial: {
    fontFamily: fonts.serifMedium,
    fontSize: tight ? 23 : 26,
    lineHeight: tight ? 29 : 32,
    color: t.text,
  },
  serifTitle: {
    fontFamily: fonts.serifMedium,
    fontSize: tight ? 18 : 20,
    lineHeight: tight ? 23 : 26,
    color: t.text,
  },
  serifBody: {
    fontFamily: fonts.serif,
    fontSize: tight ? 15.5 : 17,
    lineHeight: tight ? 23 : 26,
    color: t.text,
  },
  serifItalic: {
    fontFamily: fonts.serifItalic,
    fontSize: tight ? 15.5 : 17,
    lineHeight: tight ? 23 : 26,
    color: t.text,
  },
  });
};

export function Text({
  variant = 'body',
  color,
  style,
  ...rest
}: TextProps & { variant?: TextVariant; color?: string }) {
  const textStyles = useThemedStyles(makeTextStyles);
  return <RNText style={[textStyles[variant], color ? { color } : null, style]} {...rest} />;
}

export type IconName = ComponentProps<typeof Feather>['name'];

export function Icon({
  name,
  size = 18,
  color,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: ComponentProps<typeof Feather>['style'];
}) {
  const t = useTheme();
  return <Feather name={name} size={size} color={color ?? t.muted} style={style} />;
}

/** Circular tap target (back chevrons, kebab menus, header actions). */
export function IconButton({
  name,
  onPress,
  size = 18,
  color,
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
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
      <Feather name={name} size={size} color={color ?? t.text} />
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
  // Inset padding comes from the hook, NOT the library's native SafeAreaView: on Android that
  // view can attach with zero insets inside a freshly pushed react-native-screens screen and
  // only corrects itself on a later layout pass — on the discussion screen the title sat
  // behind the status bar until the loaded messages forced a relayout (U.16). The provider
  // already knows the insets, so the hook lays out the first frame correctly.
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const pad = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };
  return <View style={[styles.screen, pad, style]}>{children}</View>;
}

export function Card({ style, children, ...rest }: ViewProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.card, style]} {...rest}>
      {children}
    </View>
  );
}

export function Divider() {
  const styles = useThemedStyles(makeStyles);
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const showDot = dot ?? color != null;
  const accent = selected ? t.mint : (color ?? t.muted);
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
      ? { borderColor: t.mint, backgroundColor: t.mintWash }
      : { borderColor: color ?? t.line2, backgroundColor: t.surface },
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
  color,
  height = 6,
  testID,
}: {
  /** 0..1 */
  value: number;
  color?: string;
  height?: number;
  /** Applied to the FILL, not the track, so a test can assert the width actually rendered rather
   *  than a number printed beside it. A bar and its caption drifting apart is not hypothetical:
   *  see `test/plan-usage.test.tsx`. */
  testID?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={[styles.progressTrack, { height, borderRadius: height / 2 }]}>
      <View
        testID={testID}
        style={{
          width: `${pct * 100}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: color ?? t.mint,
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
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const isDisabled = disabled || loading;
  const fg =
    variant === 'primary' ? t.mintInk : variant === 'danger' ? t.danger : t.text;
  return (
    <Pressable
      onPress={(e) => {
        if (variant === 'primary') impactTap();
        onPress?.(e);
      }}
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
        <ActivityIndicator color={variant === 'primary' ? t.mintInk : t.mint} />
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

const makeStyles = (t: ThemePalette, density: DensityMode) => {
  const tight = density === 'tight';
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },
  card: {
    backgroundColor: t.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: t.line,
    padding: tight ? space.md : space.lg,
  },
  divider: {
    height: 1,
    backgroundColor: t.line,
    marginVertical: tight ? space.sm : space.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: tight ? 12 : 14,
    paddingVertical: tight ? 6 : 7,
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
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line,
  },
  progressTrack: {
    backgroundColor: t.elevated,
    overflow: 'hidden',
    flexGrow: 1,
  },
  btn: {
    height: tight ? 48 : 50,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: space.xl,
  },
  btnPrimary: { backgroundColor: t.mint },
  btnGhost: { backgroundColor: t.elevated, borderWidth: 1, borderColor: t.line2 },
  btnDanger: { backgroundColor: t.elevated, borderWidth: 1, borderColor: t.danger },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.45 },
  });
};
