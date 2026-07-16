// A single-line text strip that scrolls ONCE when (and only when) its content is wider than
// its container, so long titles are readable instead of truncated (U.6/U.21). Static text
// stays static — no motion for content that fits. Overflowing text glides gently to its end
// and rests there (tail visible), rather than looping, so the reader's focus returns to the
// content below (R.3). Native-driver transforms only.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

/** Pixels per second of glide — slow enough to read along. */
const DEFAULT_SPEED = 24;
/** Hold before the single glide starts, so the head is readable first. */
const HOLD_MS = 1400;
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
  const [textWidth, setTextWidth] = useState(0);
  // Resolve the line height up front so the absolutely-positioned text (which leaves layout
  // flow to escape the container's width constraint) still reserves vertical space.
  const flat = StyleSheet.flatten(textStyle) ?? {};
  const lineHeight = flat.lineHeight ?? (typeof flat.fontSize === 'number' ? flat.fontSize * 1.4 : 20);

  const distance = Math.max(0, textWidth - containerWidth);
  const overflows = containerWidth > 0 && distance > 1;

  useEffect(() => {
    offset.setValue(0);
    if (!overflows) return;
    // Scroll once and rest at the tail — no loop, no return-to-start leg (R.3).
    const glide = Animated.sequence([
      Animated.delay(HOLD_MS),
      Animated.timing(offset, {
        toValue: -distance,
        duration: (distance / speed) * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ]);
    glide.start();
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
          the strip carries the glide transform. Static centered text keeps the same anchor and
          just offsets by the slack, so no re-layout jump when overflow flips. */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          width: MEASURE_WIDTH,
          flexDirection: 'row',
          justifyContent: 'flex-start',
          left: align === 'center' && !overflows && textWidth > 0
            ? Math.max(0, (containerWidth - textWidth) / 2)
            : 0,
          transform: [{ translateX: offset }],
        }}
      >
        <Text
          numberOfLines={1}
          style={textStyle}
          onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
        >
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}
