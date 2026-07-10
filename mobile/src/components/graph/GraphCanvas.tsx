// Pan/zoom canvas for the reference graph. Deliberately pure RN Views (circles for nodes,
// rotated thin Views for edges) rather than react-native-svg: gesture-handler + reanimated are
// already linked into the current build (expo-router's own Stack transitions depend on them),
// so this ships with zero new native dependency / no EAS rebuild required.

import { memo, useCallback, useEffect, useState } from 'react';
import { PixelRatio, Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from 'react-native-reanimated';

import type { GraphEdge, GraphNode } from '@/api/types';
import { nodeRadius, useGraphLayout } from '@/hooks/useGraphLayout';
import { Icon, Text } from '@/ui';
import { colors, radius as radiusTokens, space } from '@/theme/tokens';

const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
const INITIAL_SCALE = 0.65;
// Perf levers (docs/mobile-ui-polish-plan.md backlog → phase D). Labels below this zoom are
// unreadable anyway, and each is a laid-out Text — shed them while zoomed out. Arrowheads
// double the per-edge view count, so on dense graphs only significant edges keep theirs.
const LABEL_MIN_SCALE = 0.5;
const ARROWS_ON_ALL_EDGES_MAX = 120;
// Momentum panning may not fling the canvas entirely off-screen: at least this many px of
// it stay reachable in each axis when a decay settles.
const FLING_KEEP_VISIBLE_PX = 80;
// Android allocates a hardware layer for the WHOLE view in device pixels (not the clipped
// viewport), so rasterizing an oversized canvas would trade jank for OOM/dropped-layer risk
// on exactly the dense graphs this targets. Budget the layer and only hold it during
// gestures — allocated on touch-down, released on lift.
const RASTER_LAYER_BUDGET_BYTES = 32 * 1024 * 1024;

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

  // Rasterize only while a finger is down (see RASTER_LAYER_BUDGET_BYTES): a counter over
  // both gestures' begin/finalize flips ONE piece of JS state on the 0<->1 transitions.
  const [gestureActive, setGestureActive] = useState(false);
  const activeTouches = useSharedValue(0);

  // One-finger drag only: two-finger movement belongs to the pinch, whose focal-follow term
  // pans for free — letting both write the translate every frame makes them fight (jitter).
  const pan = Gesture.Pan()
    .maxPointers(1)
    .onBegin(() => {
      // A touch-down grabs a canvas that's still gliding (decay) — stop it where it is.
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      activeTouches.value += 1;
      if (activeTouches.value === 1) runOnJS(setGestureActive)(true);
    })
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = startX.value + e.translationX;
      translateY.value = startY.value + e.translationY;
    })
    .onEnd((e, success) => {
      // Momentum (polish plan J.2): glide with the release velocity like a scroll view —
      // essential when panning zoomed-in — clamped so a fling can't strand the canvas
      // fully off-screen. Bounds derive from screen-space canvas extents: the view scales
      // about its own center C, so its edges sit at t + C ± s·(size/2).
      // Only on a REAL release: a second finger landing cancels this pan (maxPointers 1,
      // success=false) and a decay started there would race the pinch's translate writes.
      if (!success) return;
      const s = scale.value;
      const minX = FLING_KEEP_VISIBLE_PX - width / 2 - (s * width) / 2;
      const maxX = viewport.w - FLING_KEEP_VISIBLE_PX - width / 2 + (s * width) / 2;
      const minY = FLING_KEEP_VISIBLE_PX - height / 2 - (s * height) / 2;
      const maxY = viewport.h - FLING_KEEP_VISIBLE_PX - height / 2 + (s * height) / 2;
      translateX.value = withDecay({ velocity: e.velocityX, clamp: [minX, maxX] });
      translateY.value = withDecay({ velocity: e.velocityY, clamp: [minY, maxY] });
    })
    .onFinalize(() => {
      activeTouches.value -= 1;
      if (activeTouches.value === 0) runOnJS(setGestureActive)(false);
    });

  const startFocalX = useSharedValue(0);
  const startFocalY = useSharedValue(0);
  const pinch = Gesture.Pinch()
    .onBegin(() => {
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      activeTouches.value += 1;
      if (activeTouches.value === 1) runOnJS(setGestureActive)(true);
    })
    .onStart((e) => {
      startScale.value = scale.value;
      startX.value = translateX.value;
      startY.value = translateY.value;
      startFocalX.value = e.focalX;
      startFocalY.value = e.focalY;
    })
    .onUpdate((e) => {
      // Focal-anchored zoom (polish plan J.1). RN scales the canvas about its own center
      // C = (width/2, height/2), so a canvas point p renders at t + C + s·(p − C). Keeping
      // the point that started under the fingers glued to the CURRENT focal solves to
      //   t' = f_now − C − (s'/s0)·(f0 − t0 − C)
      // — the f_now term also gives two-finger panning. Focal coords are stable because
      // the detector hangs on the untransformed viewport, not the canvas itself.
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale.value * e.scale));
      const k = next / startScale.value;
      scale.value = next;
      translateX.value = e.focalX - width / 2 - k * (startFocalX.value - startX.value - width / 2);
      translateY.value = e.focalY - height / 2 - k * (startFocalY.value - startY.value - height / 2);
    })
    .onFinalize(() => {
      activeTouches.value -= 1;
      if (activeTouches.value === 0) runOnJS(setGestureActive)(false);
    });

  const composed = Gesture.Simultaneous(pan, pinch);

  // RGBA bytes for a full-canvas layer at this device's density; oversized canvases keep the
  // plain View path (the LOD + arrowhead cuts still apply there).
  const rasterizable =
    Platform.OS === 'android' &&
    width * height * PixelRatio.get() ** 2 * 4 <= RASTER_LAYER_BUDGET_BYTES;

  const canvasStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // Label level-of-detail: watch the UI-thread scale and flip ONE piece of JS state only
  // when the readability threshold is crossed — not per frame.
  const [labelsVisible, setLabelsVisible] = useState(INITIAL_SCALE >= LABEL_MIN_SCALE);
  useAnimatedReaction(
    () => scale.value >= LABEL_MIN_SCALE,
    (visible, previous) => {
      if (visible !== previous) runOnJS(setLabelsVisible)(visible);
    },
  );

  const arrowsOnAll = edges.length <= ARROWS_ON_ALL_EDGES_MAX;

  return (
    // The detector hangs on the untransformed viewport (not the canvas): pinch focal
    // coordinates stay in a stable space while the canvas moves under the fingers, and
    // pans register anywhere in the viewport even when the zoomed-out canvas is small.
    <GestureDetector gesture={composed}>
    <View style={styles.viewport} onLayout={onLayout} collapsable={false}>
        <Animated.View
          // Rasterizing the canvas turns pan/zoom into a texture transform instead of
          // re-drawing hundreds of Views per frame — but only while a gesture is live and
          // only within the layer budget above. Slight blur while pinch-zooming past the
          // captured resolution is the accepted trade.
          renderToHardwareTextureAndroid={rasterizable && gestureActive}
          style={[{ width, height, position: 'absolute' }, canvasStyle]}>
          {edges.map((edge, i) => {
            const a = positions[edge.source];
            const b = positions[edge.target];
            if (!a || !b) return null;
            const dimmed = !!highlightIds && (!highlightIds.has(edge.source) || !highlightIds.has(edge.target));
            return (
              <EdgeLine
                key={`${edge.source}>${edge.target}:${i}`}
                a={a}
                b={b}
                significant={edge.significant}
                showArrow={arrowsOnAll || edge.significant}
                dimmed={dimmed}
              />
            );
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
                labelsVisible={labelsVisible}
                onSelectNode={onSelectNode}
              />
            );
          })}
        </Animated.View>

      <Pressable
        onPress={() => centerView(viewport.w, viewport.h, true)}
        style={styles.resetBtn}
        accessibilityLabel="Reset graph view"
        hitSlop={8}>
        <Icon name="rotate-ccw" size={13} color={colors.text} />
        <Text variant="caption" color={colors.text}>Reset view</Text>
      </Pressable>
    </View>
    </GestureDetector>
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
  showArrow,
  dimmed,
}: {
  a: { x: number; y: number };
  b: { x: number; y: number };
  significant: boolean;
  showArrow: boolean;
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
      {showArrow ? (
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
      ) : null}
    </>
  );
});

const NodeCircle = memo(function NodeCircle({
  node,
  x,
  y,
  selected,
  dimmed,
  labelsVisible,
  onSelectNode,
}: {
  node: GraphNode;
  x: number;
  y: number;
  selected: boolean;
  dimmed: boolean;
  labelsVisible: boolean;
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
  const showLabel = selected || (labelsVisible && (isProject || isSignificant));

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
