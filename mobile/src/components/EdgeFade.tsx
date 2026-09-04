import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/theme/ThemeProvider';

export type EdgeFadeSide = 'top' | 'bottom' | 'left' | 'right';

// Preserve the existing discussion canvas's faintly translucent bottom chrome.
export const BOTTOM_EDGE_FADE_SOFT_OPACITY = 0.72;
export const BOTTOM_EDGE_FADE_OPACITY = 0.9;

/** A non-interactive scrim that dissolves content at any edge of a scrolling surface. */
export function EdgeFade({
  edge,
  size = 112,
  transparentInset = 0,
  fill,
  testID,
  style,
}: {
  edge: EdgeFadeSide;
  /** Height for top/bottom fades, width for left/right fades. */
  size?: number;
  /** Pixels that remain fully transparent before a bottom-edge fade begins. */
  transparentInset?: number;
  /** Color the gradient resolves into. Defaults to the current app background. */
  fill?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const color = fill ?? theme.bg;
  const horizontal = edge === 'left' || edge === 'right';
  const gradientId = `${testID ?? 'app'}-${edge}-edge-fade-gradient`;
  const transparentOffset = size > 0
    ? Math.max(0, Math.min(1, transparentInset / size))
    : 0;
  const bottomMidpoint = transparentOffset + (1 - transparentOffset) * 0.55;

  const gradientStops = edge === 'top'
    ? [
        <Stop key="edge" offset="0%" stopColor={color} stopOpacity={1} />,
        <Stop key="soft" offset="46%" stopColor={color} stopOpacity={0.9} />,
        <Stop key="clear" offset="100%" stopColor={color} stopOpacity={0} />,
      ]
    : edge === 'bottom'
      ? [
          <Stop key="clear-start" offset="0%" stopColor={color} stopOpacity={0} />,
          <Stop key="clear-end" offset={transparentOffset} stopColor={color} stopOpacity={0} />,
          <Stop
            key="soft"
            offset={bottomMidpoint}
            stopColor={color}
            stopOpacity={BOTTOM_EDGE_FADE_SOFT_OPACITY}
          />,
          <Stop
            key="edge"
            offset="100%"
            stopColor={color}
            stopOpacity={BOTTOM_EDGE_FADE_OPACITY}
          />,
        ]
      : edge === 'left'
        ? [
            <Stop key="edge" offset="0%" stopColor={color} stopOpacity={1} />,
            <Stop key="clear" offset="100%" stopColor={color} stopOpacity={0} />,
          ]
        : [
            <Stop key="clear" offset="0%" stopColor={color} stopOpacity={0} />,
            <Stop key="edge" offset="100%" stopColor={color} stopOpacity={1} />,
          ];

  return (
    <Svg
      testID={testID}
      pointerEvents="none"
      width={horizontal ? size : '100%'}
      height={horizontal ? '100%' : size}
      style={[styles.fade, styles[edge], style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <LinearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2={horizontal ? '1' : '0'}
          y2={horizontal ? '0' : '1'}
        >
          {gradientStops}
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  fade: { position: 'absolute' },
  top: { top: 0, left: 0, right: 0 },
  bottom: { bottom: 0, left: 0, right: 0 },
  left: { left: 0, top: 0, bottom: 0 },
  right: { right: 0, top: 0, bottom: 0 },
});
