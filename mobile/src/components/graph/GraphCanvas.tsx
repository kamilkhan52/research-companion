// Pan/zoom canvas for the reference graph. Deliberately pure RN Views (circles for nodes,
// rotated thin Views for edges) rather than react-native-svg: gesture-handler + reanimated are
// already linked into the current build (expo-router's own Stack transitions depend on them),
// so this ships with zero new native dependency / no EAS rebuild required.

import { memo, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { GraphEdge, GraphNode } from '@/api/types';
import { nodeRadius, useGraphLayout } from '@/hooks/useGraphLayout';
import { Icon, Text } from '@/ui';
import { colors, radius as radiusTokens, space } from '@/theme/tokens';

const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
const INITIAL_SCALE = 0.65;

export function GraphCanvas({
  nodes,
  edges,
  selectedId,
  highlightIds,
  onSelectNode,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  highlightIds: Set<string> | null;
  onSelectNode: (node: GraphNode) => void;
}) {
  const { positions, width, height } = useGraphLayout(nodes, edges);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(INITIAL_SCALE);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(INITIAL_SCALE);

  const centerView = useCallback(
    (w: number, h: number, animated: boolean) => {
      // RN scales a transformed view around its OWN center, so the canvas's center point
      // doesn't move under `scale` alone — centering it on the viewport only depends on the
      // translate, not the scale factor. (Multiplying by scale here — an earlier version of
      // this code did — puts the translate destination in the wrong coordinate space and
      // visibly mis-centers the graph on load/reset.)
      const tx = w / 2 - width / 2;
      const ty = h / 2 - height / 2;
      translateX.value = animated ? withTiming(tx) : tx;
      translateY.value = animated ? withTiming(ty) : ty;
      scale.value = animated ? withTiming(INITIAL_SCALE) : INITIAL_SCALE;
    },
    [width, height, translateX, translateY, scale],
  );

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width: w, height: h } = e.nativeEvent.layout;
      setViewport({ w, h });
      centerView(w, h, false);
    },
    [centerView],
  );

  // Recenter when the LAYOUT's size changes, not just the viewport's: canvas height is
  // data-dependent (aspect-clamped), so filter/search/show-all can swap in a different
  // canvas without onLayout firing — stale translate values would leave the new graph
  // shifted or mostly off-screen. centerView is recreated on width/height changes, so it
  // carries that dependency.
  useEffect(() => {
    if (viewport.w > 0 && viewport.h > 0) centerView(viewport.w, viewport.h, false);
  }, [viewport.w, viewport.h, centerView]);

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = startX.value + e.translationX;
      translateY.value = startY.value + e.translationY;
    });

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale.value * e.scale));
    });

  const composed = Gesture.Simultaneous(pan, pinch);

  const canvasStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <View style={styles.viewport} onLayout={onLayout}>
      <GestureDetector gesture={composed}>
        <Animated.View style={[{ width, height, position: 'absolute' }, canvasStyle]}>
          {edges.map((edge, i) => {
            const a = positions[edge.source];
            const b = positions[edge.target];
            if (!a || !b) return null;
            const dimmed = !!highlightIds && (!highlightIds.has(edge.source) || !highlightIds.has(edge.target));
            return <EdgeLine key={`${edge.source}>${edge.target}:${i}`} a={a} b={b} significant={edge.significant} dimmed={dimmed} />;
          })}
          {nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const dimmed = !!highlightIds && !highlightIds.has(node.id);
            return (
              <NodeCircle
                key={node.id}
                node={node}
                x={pos.x}
                y={pos.y}
                selected={node.id === selectedId}
                dimmed={dimmed}
                onSelectNode={onSelectNode}
              />
            );
          })}
        </Animated.View>
      </GestureDetector>

      <Pressable
        onPress={() => centerView(viewport.w, viewport.h, true)}
        style={styles.resetBtn}
        accessibilityLabel="Reset graph view"
        hitSlop={8}>
        <Icon name="rotate-ccw" size={13} color={colors.text} />
        <Text variant="caption" color={colors.text}>Reset view</Text>
      </Pressable>
    </View>
  );
}

/** A straight edge between two points, drawn as a rotated View. The un-rotated box is
 * centered exactly on the segment's midpoint with width = segment length; rotating a View
 * pivots around its own center by default, so this lands its two ends precisely on a and b
 * without needing transformOrigin support. */
const EdgeLine = memo(function EdgeLine({
  a,
  b,
  significant,
  dimmed,
}: {
  a: { x: number; y: number };
  b: { x: number; y: number };
  significant: boolean;
  dimmed: boolean;
}) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const thickness = significant ? 2.6 : 1.4;
  const color = significant ? colors.violet : colors.line2;
  // Direction: source CITES target. An arrowhead ~78% of the way toward the target (short of
  // its circle) points at the cited paper, so citation direction is legible. A triangle View
  // (0-size box with colored bottom border) points "up" by default (−Y = angle −π/2), so we
  // rotate it by angle + π/2 to aim it along the edge toward the target.
  const s = significant ? 6 : 5;              // arrowhead half-width
  const arrowX = a.x + dx * 0.78;
  const arrowY = a.y + dy * 0.78;

  return (
    <>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: midX - length / 2,
          top: midY - thickness / 2,
          width: length,
          height: thickness,
          backgroundColor: color,
          opacity: dimmed ? 0.06 : significant ? 0.8 : 0.32,
          transform: [{ rotate: `${angle}rad` }],
        }}
      />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: arrowX - s,
          top: arrowY - s * 0.8,
          width: 0,
          height: 0,
          borderLeftWidth: s,
          borderRightWidth: s,
          borderBottomWidth: s * 1.6,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: color,
          opacity: dimmed ? 0.06 : significant ? 0.95 : 0.55,
          transform: [{ rotate: `${angle + Math.PI / 2}rad` }],
        }}
      />
    </>
  );
});

const NodeCircle = memo(function NodeCircle({
  node,
  x,
  y,
  selected,
  dimmed,
  onSelectNode,
}: {
  node: GraphNode;
  x: number;
  y: number;
  selected: boolean;
  dimmed: boolean;
  onSelectNode: (node: GraphNode) => void;
}) {
  const r = nodeRadius(node);
  const isProject = node.kind === 'project';
  const isSignificant = node.significant_cited_by_count > 0;
  // Mint = in project, violet = external (DS node palette); read/unread no longer split hues.
  const accent = isProject ? colors.mint : colors.violet;
  const labelWidth = Math.max(r * 3.6, 74);
  // Label only the nodes worth reading at a glance — project papers, significant refs, or the
  // selection. Skipping the long tail of external leaf citations removes hundreds of Text
  // layouts, the single biggest per-node cost when the whole graph is shown.
  const showLabel = isProject || isSignificant || selected;

  return (
    <Pressable
      onPress={() => onSelectNode(node)}
      hitSlop={6}
      accessibilityLabel={`${node.title}${isProject ? ' (in this project)' : ' (external reference)'}`}
      style={{ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, opacity: dimmed ? 0.16 : 1 }}>
      <View
        style={{
          width: r * 2,
          height: r * 2,
          borderRadius: r,
          backgroundColor: isProject ? colors.elevated : colors.surface,
          borderWidth: selected ? 3 : isSignificant ? 2 : 1.3,
          borderColor: selected ? colors.amber : isSignificant ? accent : colors.line2,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <View
          style={{
            width: r * 1.15,
            height: r * 1.15,
            borderRadius: r,
            backgroundColor: accent,
            opacity: isProject ? 1 : 0.85,
          }}
        />
      </View>
      {showLabel ? (
        <Text
          numberOfLines={2}
          variant="caption"
          style={{
            position: 'absolute',
            top: r * 2 + 3,
            width: labelWidth,
            left: -(labelWidth - r * 2) / 2,
            textAlign: 'center',
            fontSize: 10,
            lineHeight: 12,
          }}>
          {node.title}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  resetBtn: {
    position: 'absolute',
    right: space.md,
    bottom: space.md,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radiusTokens.pill,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
