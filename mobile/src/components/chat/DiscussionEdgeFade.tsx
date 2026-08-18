import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/theme/ThemeProvider';

/**
 * A non-interactive scroll-edge scrim for the immersive discussion canvas.
 *
 * This is deliberately a real gradient rather than a translucent toolbar: the transcript
 * remains the full-screen base layer and visibly travels beneath the floating header/composer.
 * The fully opaque end protects system/chrome contrast while the transparent end avoids a hard
 * boundary across long-form text.
 */
export function DiscussionEdgeFade({
  edge,
  height = 112,
  transparentInset = 0,
  style,
}: {
  edge: 'top' | 'bottom';
  height?: number;
  /** Bottom-edge pixels that remain fully transparent before the fade begins. */
  transparentInset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const gradientId = `discussion-${edge}-edge-fade`;
  const transparentOffset = height > 0
    ? Math.max(0, Math.min(1, transparentInset / height))
    : 0;
  const bottomMidpoint = transparentOffset + (1 - transparentOffset) * 0.55;
  const gradientStops = edge === 'top'
    ? [
        <Stop key="opaque" offset="0%" stopColor={theme.bg} stopOpacity={1} />,
        <Stop key="soft" offset="46%" stopColor={theme.bg} stopOpacity={0.9} />,
        <Stop key="clear" offset="100%" stopColor={theme.bg} stopOpacity={0} />,
      ]
    : [
        <Stop key="clear-start" offset="0%" stopColor={theme.bg} stopOpacity={0} />,
        <Stop
          key="clear-end"
          offset={transparentOffset}
          stopColor={theme.bg}
          stopOpacity={0}
        />,
        <Stop
          key="soft"
          offset={bottomMidpoint}
          stopColor={theme.bg}
          stopOpacity={0.9}
        />,
        <Stop key="opaque" offset="100%" stopColor={theme.bg} stopOpacity={1} />,
      ];

  return (
    <Svg
      testID={`discussion-${edge}-edge-fade`}
      pointerEvents="none"
      width="100%"
      height={height}
      style={[styles.fade, edge === 'top' ? styles.top : styles.bottom, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          {gradientStops}
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
