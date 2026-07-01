// Pan/zoom canvas for the reference graph. Deliberately pure RN Views (circles for nodes,
// rotated thin Views for edges) rather than react-native-svg: gesture-handler + reanimated are
// already linked into the current build (expo-router's own Stack transitions depend on them),
// so this ships with zero new native dependency / no EAS rebuild required.

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { GraphEdge, GraphNode } from '@/api/types';
import { nodeRadius, useGraphLayout } from '@/hooks/useGraphLayout';
import { Text } from '@/ui';
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
      const tx = w / 2 - (width / 2) * INITIAL_SCALE;
      const ty = h / 2 - (height / 2) * INITIAL_SCALE;
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
                onPress={() => onSelectNode(node)}
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
        <Text variant="caption">⟲ Reset view</Text>
      </Pressable>
    </View>
  );
}

/** A straight edge between two points, drawn as a rotated View. The un-rotated box is
 * centered exactly on the segment's midpoint with width = segment length; rotating a View
 * pivots around its own center by default, so this lands its two ends precisely on a and b
 * without needing transformOrigin support. */
function EdgeLine({
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
  // A small dot 60% of the way toward the target gives a lightweight directional cue
  // (this is a directed citation graph) without needing a precise arrowhead polygon.
  const dotX = a.x + dx * 0.6;
  const dotY = a.y + dy * 0.6;

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
          left: dotX - 2.5,
          top: dotY - 2.5,
          width: 5,
          height: 5,
          borderRadius: 2.5,
          backgroundColor: color,
          opacity: dimmed ? 0.06 : significant ? 0.85 : 0.4,
        }}
      />
    </>
  );
}

function NodeCircle({
  node,
  x,
  y,
  selected,
  dimmed,
  onPress,
}: {
  node: GraphNode;
  x: number;
  y: number;
  selected: boolean;
  dimmed: boolean;
  onPress: () => void;
}) {
  const r = nodeRadius(node);
  const isProject = node.kind === 'project';
  const isRead = node.list_status === 'read';
  const isSignificant = node.significant_cited_by_count > 0;
  const accent = isProject ? (isRead ? colors.green : colors.cyan) : colors.violet;
  const labelWidth = Math.max(r * 3.6, 74);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityLabel={`${node.title}${isProject ? ' (in this project)' : ' (external reference)'}`}
      style={{ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, opacity: dimmed ? 0.16 : 1 }}>
      <View
        style={{
          width: r * 2,
          height: r * 2,
          borderRadius: r,
          backgroundColor: isProject ? colors.panel2 : colors.bg2,
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  resetBtn: {
    position: 'absolute',
    right: space.md,
    bottom: space.md,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line2,
    borderRadius: radiusTokens.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
