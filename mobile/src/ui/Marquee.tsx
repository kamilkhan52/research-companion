// A single-line text strip that scrolls ONCE when (and only when) its content is wider than
// its container, so long titles are readable instead of truncated (U.6/U.21). Static text
// stays static — no motion for content that fits. Overflowing text glides to its end, holds
// so the tail is readable, then resets to the start and stays — one pass, no loop (R.3/R7.1:
// the head is the line's identity, so that's where it should rest). Native-driver transforms.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

/** Pixels per second of glide — brisk but still readable along the way. */
const DEFAULT_SPEED = 36;
/** Hold before the single glide starts, so the head is readable first. */
const HOLD_MS = 1400;
/** Hold at the tail before resetting, so the end of the line can actually be read. */
const TAIL_HOLD_MS = 1200;
/** Width of the measuring strip the text lays out inside. Yoga measures absolutely-positioned
 *  children with the PARENT's width as an at-most constraint, so text placed directly in the
 *  clipping container wraps (or clips) at the container width and reports that width — never
 *  its intrinsic width, and the overflow is never detected (the R.3/R6.1 frozen-title bug).
 *  Laying the text out inside an explicit, much-wider strip lifts the constraint so onLayout
 *  reports the real single-line width. */
const MEASURE_WIDTH = 4096;

export function Marquee({
  text,
  textStyle,
  speed = DEFAULT_SPEED,
  accessibilityLabel,
  align = 'left',
}: {
  text: string;
  textStyle?: StyleProp<TextStyle>;
  speed?: number;
  accessibilityLabel?: string;
  /** How STATIC (fitting) text sits in the container; overflowing text always glides from
   *  the left. 'center' suits centered chrome like the TopBar title. */
  align?: 'left' | 'center';
}) {
  const offset = useRef(new Animated.Value(0)).current;
  const [containerWidth, setContainerWidth] = useState(0);
  // The measurement is keyed to the text it belongs to: when the text changes (a loading
  // placeholder giving way to the real title, or a track switch), the stale width must not
  // position the new text — that painted the first frames at the OLD text's anchor (often
  // center) and then visibly snapped to the rolling start once the new onLayout arrived.
  const [measured, setMeasured] = useState<{ text: string; width: number } | null>(null);
  // Resolve the line height up front so the absolutely-positioned text (which leaves layout
  // flow to escape the container's width constraint) still reserves vertical space.
  const flat = StyleSheet.flatten(textStyle) ?? {};
  const lineHeight = flat.lineHeight ?? (typeof flat.fontSize === 'number' ? flat.fontSize * 1.4 : 20);

  const textWidth = measured?.text === text ? measured.width : 0;
  // Painted only once BOTH the container and the current text are measured, so the first
  // visible frame already sits at its final anchor — no mid-screen start, no snap.
  const ready = containerWidth > 0 && measured?.text === text;
  const distance = Math.max(0, textWidth - containerWidth);
  const overflows = ready && distance > 1;

  useEffect(() => {
    offset.setValue(0);
    if (!overflows) return;
    // Scroll once, hold at the tail, then snap back to the start and stay — no loop (R7.1).
    const glide = Animated.sequence([
      Animated.delay(HOLD_MS),
      Animated.timing(offset, {
        toValue: -distance,
        duration: (distance / speed) * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      Animated.delay(TAIL_HOLD_MS),
    ]);
    glide.start(({ finished }) => {
      if (finished) offset.setValue(0);
    });
    return () => glide.stop();
  }, [overflows, distance, speed, offset, text]);

  return (
    <View
      style={{ overflow: 'hidden', height: lineHeight }}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityLabel={accessibilityLabel ?? text}
    >
      {/* The text lays out inside an absolutely-positioned strip with an explicit width far
          wider than any container, so its onLayout reports the intrinsic single-line width
          (see MEASURE_WIDTH). The container's overflow:'hidden' does the visual clipping and
          the strip carries the glide transform. The strip stays transparent until the current
          text's own measurement lands (`ready`), so the first painted frame is already at the
          left rolling start (overflow) or the true center (fitting) — never a stale anchor.
          Keying the Text by its content forces a fresh mount per text, guaranteeing onLayout
          re-fires even when the new text happens to measure identically. */}
      <Animated.View
        testID="marquee-strip"
        style={{
          position: 'absolute',
          top: 0,
          width: MEASURE_WIDTH,
          flexDirection: 'row',
          justifyContent: 'flex-start',
          opacity: ready ? 1 : 0,
          left: align === 'center' && !overflows && ready
            ? Math.max(0, (containerWidth - textWidth) / 2)
            : 0,
          transform: [{ translateX: offset }],
        }}
      >
        <Text
          key={text}
          numberOfLines={1}
          style={textStyle}
          onLayout={(e) => setMeasured({ text, width: e.nativeEvent.layout.width })}
        >
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}
