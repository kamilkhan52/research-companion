// Themed UI primitives built on the Scholar-dark tokens (Figma `01 · Design System`).
// Small, composable, and the single source for typography/surfaces so screens stay
// declarative and consistent. Manrope for UI text; Newsreader variants ('editorial',
// 'serifTitle', 'serifBody', 'serifItalic') for headings and long-form reading moments.

import { Feather } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
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
import {
  control,
  fonts,
  motion,
  radius,
  space,
  type ThemePalette,
} from '@/theme/tokens';

export type TextVariant =
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

// Exported for Markdown.tsx's DR-068 text-scale multiplier, which needs the EXACT resolved
// base fontSize/lineHeight per (palette, density) to multiply against — duplicating these
// numbers locally would drift the moment this file's density scale changes.
export const makeTextStyles = (t: ThemePalette, density: DensityMode) => {
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

export type SurfaceTone = 'neutral' | 'mint' | 'violet' | 'amber' | 'danger';

function toneFor(t: ThemePalette, tone: SurfaceTone) {
  if (tone === 'mint') return { ink: t.mint, fill: t.mintWash, line: t.mint };
  if (tone === 'violet') return { ink: t.violet, fill: t.violetWash, line: t.violet };
  if (tone === 'amber') return { ink: t.amber, fill: t.amberWash, line: t.amberLine };
  if (tone === 'danger') return { ink: t.danger, fill: t.dangerWash, line: t.danger };
  return { ink: t.muted, fill: t.elevated, line: t.line2 };
}

/** A semantic tinted surface for status and interruption UI. The tone always travels with text or
 *  an icon at call sites; it is never the only state signal. */
export function ToneSurface({
  tone = 'neutral',
  style,
  children,
  ...rest
}: ViewProps & { tone?: SurfaceTone }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const colors = toneFor(t, tone);
  return (
    <View
      style={[styles.toneSurface, { backgroundColor: colors.fill, borderColor: colors.line }, style]}
      {...rest}
    >
      {children}
    </View>
  );
}

/** Icon treatment paired with ToneSurface. Keeping the geometry here stops each status card from
 *  inventing a slightly different halo. */
export function ToneIcon({
  name,
  tone = 'neutral',
  compact = false,
}: {
  name: IconName;
  tone?: SurfaceTone;
  compact?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const colors = toneFor(t, tone);
  return (
    <View style={[styles.toneIcon, compact && styles.toneIconCompact, { borderColor: colors.line }]}>
      <Icon name={name} size={compact ? 16 : 20} color={colors.ink} />
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

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let current = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (current) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}

/** Progress that eases between server snapshots without replaying from zero on focus. The initial
 *  value is painted immediately; later changes animate unless the OS asks for reduced motion. */
export function AnimatedProgressBar({
  value,
  color,
  height = control.progress,
  testID,
}: {
  value: number;
  color?: string;
  height?: number;
  testID?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const progress = useRef(new Animated.Value(pct)).current;
  const reduceMotion = useReduceMotion();
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current || reduceMotion) {
      progress.setValue(pct);
      mounted.current = true;
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: pct,
      duration: motion.standard,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [pct, progress, reduceMotion]);

  return (
    <View
      testID={testID}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // Kept on the hidden visual node so regression tests can prove the fill receives the same
      // value as the spoken parent progressbar. It is not a second accessibility announcement.
      accessibilityValue={{ min: 0, max: 100, now: pct * 100 }}
      style={[styles.progressTrack, { height, borderRadius: height / 2 }]}
    >
      <Animated.View
        style={{
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
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
  iconSize = 17,
  style,
  ...rest
}: PressableProps & {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: IconName;
  iconSize?: number;
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
          {icon ? <Feather name={icon} size={iconSize} color={fg} /> : null}
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
    // The 42px visible halo keeps existing top bars stable; IconButton's 8px hitSlop makes the
    // effective target 58px without changing those layouts.
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
  toneSurface: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: tight ? space.md : space.lg,
  },
  toneIcon: {
    width: control.iconHalo,
    height: control.iconHalo,
    borderRadius: radius.pill,
    borderWidth: 1,
    backgroundColor: t.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toneIconCompact: {
    width: control.iconHaloCompact,
    height: control.iconHaloCompact,
  },
  btn: {
    minHeight: control.minTouch,
    height: tight ? control.minTouch : control.standard,
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
