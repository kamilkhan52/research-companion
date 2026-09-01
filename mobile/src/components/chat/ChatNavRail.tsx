// DR-115 — the discussion transcript's landmark rail.
//
// Kamil: "a vertical kinda of bar that has arrows like icons to go up and down to these
// landmarks… It should have some transparency if laid on top of text, and maybe some option
// to auto hide and then reveal, maybe like the iPhone thing."
//
// Four controls, because a thread has exactly two extremes and one repeatable step in each
// direction: oldest message · one landmark older · one landmark newer · live edge. What a
// landmark IS lives in `@/lib/chatNavigation`.
//
// The iPhone behaviour it echoes is the scroll indicator: present while you are moving, out
// of the way while you are reading. It DIMS rather than disappearing — a control that vanishes
// completely can only be recalled by scrolling, and not scrolling is the entire point of this
// feature. At rest it is a faint outline over the prose; touching it or moving the thread
// brings it back to full strength.
//
// `elevatedGlass` (not `elevated`) is the fill: this pill sits permanently over running text,
// so the transcript stays visible through it in every palette.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useReduceMotion } from '@/hooks/useReduceMotion';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';
import { Icon } from '@/ui';

/** Resting strength: legible enough to aim at, faint enough to read through. */
export const RAIL_RESTING_OPACITY = 0.3;
/** Quiet time before the rail settles back. Long enough to survive a pause between two
 *  presses, short enough that it is not sitting at full strength over a page of prose. */
export const RAIL_IDLE_MS = 2400;
const RAIL_WAKE_MS = 110;
const RAIL_DIM_MS = 380;

export interface ChatNavRailHandle {
  /** Bring the rail back to full strength and restart the idle countdown. Called for scroll
   *  events too, so the rail behaves like the scroll indicator it echoes. */
  wake(): void;
}

export const ChatNavRail = forwardRef<ChatNavRailHandle, {
  onOldest: () => void;
  onUp: () => void;
  onDown: () => void;
  onLive: () => void;
  /** Keeps the rail clear of the floating composer and the scroll-to-latest button. */
  bottomInset: number;
  /** Keeps the rail clear of the overlay header. */
  topInset: number;
}>(function ChatNavRail({ onOldest, onUp, onDown, onLive, bottomInset, topInset }, ref) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const reduceMotion = useReduceMotion();
  const opacity = useSharedValue(1);
  const dimmed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read through a ref rather than a dependency: `wake` is called from the list's scroll
  // handler at every frame and is the imperative handle, so it must keep one identity for the
  // life of the rail. As a dependency, the OS preference resolving a moment after mount would
  // rebuild it, re-run the mount effect and start a second idle countdown.
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const wake = useCallback(() => {
    const instant = reduceMotionRef.current;
    if (dimmed.current) {
      dimmed.current = false;
      opacity.value = withTiming(1, { duration: instant ? 0 : RAIL_WAKE_MS });
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      dimmed.current = true;
      opacity.value = withTiming(RAIL_RESTING_OPACITY, {
        duration: reduceMotionRef.current ? 0 : RAIL_DIM_MS,
      });
    }, RAIL_IDLE_MS);
  }, [opacity]);

  useImperativeHandle(ref, () => ({ wake }), [wake]);

  // Start the countdown on mount: the rail introduces itself, then gets out of the way.
  useEffect(() => {
    wake();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [wake]);

  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const press = useCallback(
    (action: () => void) => () => {
      wake();
      action();
    },
    [wake],
  );

  return (
    // box-none: the full-height wrapper only exists to centre the pill; touches pass through
    // everywhere except the buttons themselves, so the transcript underneath stays scrollable.
    <View
      style={[styles.wrapper, { paddingTop: topInset, paddingBottom: bottomInset }]}
      pointerEvents="box-none"
      testID="chat-nav-rail-area">
      <Animated.View style={[styles.rail, fade]} testID="chat-nav-rail">
        <RailButton
          name="chevrons-up"
          label="Jump to the start of the thread"
          onPress={press(onOldest)}
          testID="chat-nav-oldest"
          color={theme.text}
          styles={styles}
        />
        <RailButton
          name="chevron-up"
          label="Previous message"
          onPress={press(onUp)}
          testID="chat-nav-up"
          color={theme.text}
          styles={styles}
        />
        <View style={styles.divider} />
        <RailButton
          name="chevron-down"
          label="Next message"
          onPress={press(onDown)}
          testID="chat-nav-down"
          color={theme.text}
          styles={styles}
        />
        <RailButton
          name="chevrons-down"
          label="Jump to the latest message"
          onPress={press(onLive)}
          testID="chat-nav-live"
          color={theme.text}
          styles={styles}
        />
      </Animated.View>
    </View>
  );
});

/** Declared at module scope on purpose: a component defined inside the render body gets a new
 *  identity every commit, which remounts each Pressable and drops its press state mid-tap. */
function RailButton({
  name,
  label,
  onPress,
  testID,
  color,
  styles,
}: {
  name: 'chevrons-up' | 'chevron-up' | 'chevron-down' | 'chevrons-down';
  label: string;
  onPress: () => void;
  testID: string;
  color: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={6}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <Icon name={name} size={18} color={color} />
    </Pressable>
  );
}

const makeStyles = (t: ThemePalette) =>
  StyleSheet.create({
    wrapper: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'center',
      alignItems: 'flex-end',
      // Above the transcript, below the composer overlay (zIndex 10) and the header.
      zIndex: 5,
    },
    rail: {
      marginRight: space.sm,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: t.line2,
      backgroundColor: t.elevatedGlass,
    },
    button: {
      width: 40,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: { opacity: 0.55 },
    divider: {
      height: 1,
      marginVertical: space.xs / 2,
      marginHorizontal: space.sm,
      backgroundColor: t.line,
    },
  });
