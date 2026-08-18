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
  style,
}: {
  edge: 'top' | 'bottom';
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const gradientId = `discussion-${edge}-edge-fade`;

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
          <Stop offset="0%" stopColor={theme.bg} stopOpacity={edge === 'top' ? 1 : 0} />
          <Stop
            offset={edge === 'top' ? '46%' : '54%'}
            stopColor={theme.bg}
            stopOpacity={0.9}
          />
          <Stop offset="100%" stopColor={theme.bg} stopOpacity={edge === 'top' ? 0 : 1} />
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
