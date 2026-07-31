// A short window onto a longer list, scrolling slowly upward — the "we are reading through
// things" signal for a search that takes minutes.
//
// Why a moving window rather than a static list: a discovery run spends most of its time in
// stages that produce no visible change, and a fixed list of five titles reads as *finished*
// after a few seconds. Two rows drifting past reads as *ongoing*, which is what is actually
// true, and it costs less vertical space than the list it replaces.
//
// The motion is one looping translateY on the native driver over the content rendered TWICE, so
// the seam is invisible and the JS thread stays free for the poll cycle. The fades are SVG
// gradients from the panel's own background colour to transparent: there is no gradient or
// masked-view package in this app, and stacking translucent Views banded visibly on the device's
// warm background.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/** Seconds each row takes to cross the window. Slow enough to read a title, fast enough to
 *  register as motion at a glance. */
const SECONDS_PER_ROW = 2.6;
/** Height of the fade at each edge. Tall enough to soften the cut, short enough to leave two
 *  rows legible in a compact window. */
const FADE_H = 18;

export function ScanningList({
  children,
  rowHeight,
  rows = 2,
  fadeColor,
  paused = false,
}: {
  /** One node per row, all the same height. Pass more than `rows` or nothing will move. */
  children: React.ReactNode[];
  rowHeight: number;
  rows?: number;
  /** The background the fades blend into — the panel's own colour, not the page's. */
  fadeColor: string;
  paused?: boolean;
}) {
  const count = children.length;
  const viewportH = rowHeight * rows;
  const contentH = rowHeight * count;
  const offset = useRef(new Animated.Value(0)).current;
  // The SVG fades need a pixel width; percentage widths are unreliable across RN SVG backends.
  const [width, setWidth] = useState(0);

  // Restart whenever the reel length changes: the run replaces its finds as the funnel narrows,
  // and an animation still travelling to the OLD content height would drift out of alignment
  // and show blank rows at the seam.
  useEffect(() => {
    offset.setValue(0);
    if (paused || count <= rows) return;
    const loop = Animated.loop(
      Animated.timing(offset, {
        toValue: -contentH,
        duration: count * SECONDS_PER_ROW * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [contentH, count, offset, paused, rows]);

  if (!count) return null;

  return (
    <View
      style={{ height: viewportH, overflow: 'hidden' }}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View style={{ transform: [{ translateY: offset }] }}>
        {children.map((child, i) => (
          <View key={`a${i}`} style={{ height: rowHeight, justifyContent: 'center' }}>
            {child}
          </View>
        ))}
        {/* The second pass is what makes the loop seamless: by the time the first copy has
            scrolled fully out of the window, the second is exactly in its place. */}
        {count > rows
          ? children.map((child, i) => (
              <View key={`b${i}`} style={{ height: rowHeight, justifyContent: 'center' }}>
                {child}
              </View>
            ))
          : null}
      </Animated.View>

      {width > 0 ? (
        <>
          <Svg
            pointerEvents="none"
            style={[styles.fade, { top: 0 }]}
            width={width}
            height={FADE_H}>
            <Defs>
              <LinearGradient id="scanTop" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={fadeColor} stopOpacity="1" />
                <Stop offset="1" stopColor={fadeColor} stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={width} height={FADE_H} fill="url(#scanTop)" />
          </Svg>
          <Svg
            pointerEvents="none"
            style={[styles.fade, { bottom: 0 }]}
            width={width}
            height={FADE_H}>
            <Defs>
              <LinearGradient id="scanBottom" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={fadeColor} stopOpacity="0" />
                <Stop offset="1" stopColor={fadeColor} stopOpacity="1" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={width} height={FADE_H} fill="url(#scanBottom)" />
          </Svg>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', left: 0, right: 0 },
});
