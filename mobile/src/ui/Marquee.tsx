// A single-line text strip that slowly auto-scrolls when (and only when) its content is wider
// than its container, so long titles are readable instead of truncated (U.6). Static text
// stays static — no motion for content that fits. The scroll is a gentle linear glide to the
// end, a pause, then a quick return; native-driver transforms only.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';

/** Pixels per second of glide — slow enough to read along. */
const DEFAULT_SPEED = 24;
/** Hold before the glide starts / after it ends, so the head and tail are both readable. */
const HOLD_MS = 1400;

export function Marquee({
  text,
  textStyle,
  speed = DEFAULT_SPEED,
  accessibilityLabel,
}: {
  text: string;
  textStyle?: StyleProp<TextStyle>;
  speed?: number;
  accessibilityLabel?: string;
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
    if (!overflows) {
      offset.setValue(0);
      return;
    }
    const glide = Animated.loop(
      Animated.sequence([
        Animated.delay(HOLD_MS),
        Animated.timing(offset, {
          toValue: -distance,
          duration: (distance / speed) * 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.delay(HOLD_MS),
        Animated.timing(offset, {
          toValue: 0,
          duration: 350,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
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
      {/* Absolute + left-anchored so the text measures at its intrinsic width (Yoga sizes an
          absolutely positioned child to its content), letting onLayout report the true width
          even when it exceeds the clipped container. */}
      <Animated.Text
        numberOfLines={1}
        ellipsizeMode="clip"
        style={[textStyle, { position: 'absolute', left: 0, transform: [{ translateX: offset }] }]}
        onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
      >
        {text}
      </Animated.Text>
    </View>
  );
}
