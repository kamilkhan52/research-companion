// Pan/zoom canvas for the reference graph. Deliberately pure RN Views (circles for nodes,
// rotated thin Views for edges) rather than react-native-svg: gesture-handler + reanimated are
// already linked into the current build (expo-router's own Stack transitions depend on them),
// so this ships with zero new native dependency / no EAS rebuild required.

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  PixelRatio, Platform, Pressable, StyleSheet, View,
  type LayoutChangeEvent, type ViewProps,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { AnimatedProps } from 'react-native-reanimated';
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
import {
  BUCKETS_PER_DOUBLING, bucketScale, pickVisibleLabels, zoomBucket,
} from '@/graph/labelDeclutter';
import { nodeRadius, useGraphLayout } from '@/hooks/useGraphLayout';
import { Icon, Text } from '@/ui';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius as radiusTokens, space, type ThemePalette } from '@/theme/tokens';

// Low enough that "fit the whole graph" (computeFitScale below) is reachable by pinch too —
// the visible node set's own bounding box is often wider/taller than 0.3x would show.
const MIN_SCALE = 0.15;
const MAX_SCALE = 2.5;
// Fallback only, for the single frame before the viewport is measured — real sizing always
// comes from computeFitScale once onLayout fires.
const INITIAL_SCALE = 0.65;
// Margin so the outermost nodes/labels aren't flush against the viewport edge.
const FIT_PADDING = 0.92;
// Perf levers (docs/mobile-ui-polish-plan.md backlog → phase D). Arrowheads double the per-edge
// view count, so on dense graphs only significant edges keep theirs.
//
// Labels used to be shed wholesale below `LABEL_MIN_SCALE = 0.5`. That constant is gone: with
// constant-size labels the old premise ("below this zoom the text is unreadable") is false, and
// on a phone the default fit scale is ~0.25, so it hid every label at the view you actually land
// on. Overlap is handled by decluttering in screen space instead — see `pickVisibleLabels`. Cells
// are sized from the real label box: `max(r * 3.6, 74)` wide by two 12px lines tall, which is why
// they are so much wider than they are tall.
const LABEL_CELL_W = 96;
const LABEL_CELL_H = 30;
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
  layoutAlgo,
  overlay,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  highlightIds: Set<string> | null;
  onSelectNode: (node: GraphNode) => void;
  /** graph.layout.algo from the server — axis legends render only for 'semantic-v2'. */
  layoutAlgo?: string | null;
  /** Screen-owned controls rendered over the plot, alongside Reset view. */
  overlay?: ReactNode;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { positions, width, height, semantic } = useGraphLayout(nodes, edges);
  const showAxes = !!semantic && layoutAlgo === 'semantic-v2';
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(INITIAL_SCALE);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(INITIAL_SCALE);

  // The default (and "Reset view") scale always fits the current visible node set's whole
  // bounding box into the viewport, rather than a fixed constant — the box's aspect ratio (and
  // so the scale needed to show all of it) shifts as filters/pagination change which nodes are
  // visible.
  const computeFitScale = useCallback(
    (w: number, h: number) => {
      if (!width || !height || !w || !h) return INITIAL_SCALE;
      const fit = Math.min(w / width, h / height) * FIT_PADDING;
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit));
    },
    [width, height],
  );

  const centerView = useCallback(
    (w: number, h: number, animated: boolean) => {
      // RN scales a transformed view around its OWN center, so the canvas's center point
      // doesn't move under `scale` alone — centering it on the viewport only depends on the
      // translate, not the scale factor. (Multiplying by scale here — an earlier version of
      // this code did — puts the translate destination in the wrong coordinate space and
      // visibly mis-centers the graph on load/reset.)
      const tx = w / 2 - width / 2;
      const ty = h / 2 - height / 2;
      const fitScale = computeFitScale(w, h);
      translateX.value = animated ? withTiming(tx) : tx;
      translateY.value = animated ? withTiming(ty) : ty;
      scale.value = animated ? withTiming(fitScale) : fitScale;
    },
    [width, height, computeFitScale, translateX, translateY, scale],
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
  // Android's ACTION_POINTER_UP MotionEvent still includes the departing pointer in
  // pointerCount, even though ScaleGestureDetector has already recomputed its focus without
  // that pointer. Therefore the update produced by the same native event can report
  // numberOfPointers === 2 while focalX/Y has collapsed onto the one remaining finger. RNGH
  // sends onTouchesUp before processing/dispatching that update, so this flag identifies the
  // corrupted release frame more reliably than numberOfPointers alone. The next real MOVE
  // clears it, preserving legitimate 3 -> 2 pointer transitions.
  const pinchPointerUpPending = useSharedValue(false);
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
      pinchPointerUpPending.value = false;
    })
    .onTouchesMove(() => {
      pinchPointerUpPending.value = false;
    })
    .onTouchesUp(() => {
      pinchPointerUpPending.value = true;
    })
    .onUpdate((e) => {
      // Ignore both ordinary one-finger updates and Android's ACTION_POINTER_UP update, whose
      // pointer count is stale but whose focal point has already jumped to the remaining finger.
      if (pinchPointerUpPending.value || e.numberOfPointers < 2) return;
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

  // ONE animated style shared by every label, not one per label. Reanimated attaches a single
  // style object to many views (its ViewDescriptorsSet holds an array of view tags), so this is
  // 2 worklets per frame — the canvas transform and this — rather than one per visible node.
  // Giving each label its own useAnimatedStyle would be ~100 mappers per frame on a dense graph.
  //
  // The inverse scale cancels the canvas transform exactly, so a label's SCREEN size is constant
  // at every zoom. Zooming then spreads the nodes without growing the text, which is what buys
  // room for more labels. `transformOrigin` keeps the label pinned under its node as it shrinks.
  const [labelBucket, setLabelBucket] = useState(() => zoomBucket(INITIAL_SCALE));
  // Screen-space declutter. Priority is the node radius: a bigger circle is a more significant
  // paper, so when two labels want the same cell the more important one keeps it. The selected
  // node is pinned — the reader asked for that one, and it must never lose to a neighbour.
  const labelledIds = useMemo(() => pickVisibleLabels(
    nodes.map((n) => ({
      id: n.id,
      x: positions[n.id]?.x ?? 0,
      y: positions[n.id]?.y ?? 0,
      priority: nodeRadius(n),
      pinned: n.id === selectedId,
    })),
    { scale: bucketScale(labelBucket), cellWidth: LABEL_CELL_W, cellHeight: LABEL_CELL_H },
  ), [nodes, positions, selectedId, labelBucket]);

  const labelCounterScale = useAnimatedStyle(() => ({
    transform: [{ scale: 1 / scale.value }],
  }));

  // Which labels survive the declutter, recomputed only when a quantized zoom bucket changes —
  // the same "one JS state flip, never per frame" discipline the old LOD boolean used.
  useAnimatedReaction(
    () => {
      'worklet';
      // Written out rather than calling `zoomBucket`. This runs on the UI thread, and calling a
      // plain imported function from there is a hard crash — "[Worklets] Tried to synchronously
      // call a non-worklet function" — which is exactly how this shipped broken. Marking the
      // import as a worklet would also work, but nothing else in this codebase does that, so
      // there is no evidence the build transforms cross-module worklets; an inline one needs no
      // such assumption. `BUCKETS_PER_DOUBLING` is shared so the two cannot disagree.
      const value = scale.value;
      if (!(value > 0)) return 0;
      return Math.round(Math.log2(value) * BUCKETS_PER_DOUBLING);
    },
    (bucket, previous) => {
      if (bucket !== previous) runOnJS(setLabelBucket)(bucket);
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
                showLabel={labelledIds.has(node.id)}
                labelStyle={labelCounterScale}
                onSelectNode={onSelectNode}
              />
            );
          })}
        </Animated.View>

      {overlay}

      <Pressable
        onPress={() => centerView(viewport.w, viewport.h, true)}
        style={styles.resetBtn}
        accessibilityLabel="Reset graph view"
        hitSlop={8}>
        <Icon name="rotate-ccw" size={13} color={t.text} />
        <Text variant="caption" color={t.text}>Reset view</Text>
      </Pressable>

      {/* Axis legend — the layout's semantics (graph_layout.py rules: X = publication time,
          Y = citation impact) made visible, so positions read as information, not accident.
          Hidden for legacy graphs still on the client force-sim fallback (no semantic axes). */}
      {showAxes ? (
        <>
          <View pointerEvents="none" style={styles.axisX}>
            <Text variant="caption" color={t.muted}>older → newer</Text>
          </View>
          <View pointerEvents="none" style={styles.axisY}>
            <Text variant="caption" color={t.muted}>↑ more cited</Text>
          </View>
        </>
      ) : null}
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
  const t = useTheme();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const thickness = significant ? 2.6 : 1.4;
  const color = significant ? t.violet : t.line2;
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
  showLabel,
  labelStyle,
  onSelectNode,
}: {
  node: GraphNode;
  x: number;
  y: number;
  selected: boolean;
  dimmed: boolean;
  showLabel: boolean;
  /** The ONE shared counter-scale style; typed as the component prop accepts it. */
  labelStyle: AnimatedProps<ViewProps>['style'];
  onSelectNode: (node: GraphNode) => void;
}) {
  const t = useTheme();
  const r = nodeRadius(node);
  const isProject = node.kind === 'project';
  const isSignificant = node.significant_cited_by_count > 0;
  // Mint = in project, violet = external (DS node palette); read/unread no longer split hues.
  const accent = isProject ? t.mint : t.violet;
  const labelWidth = Math.max(r * 3.6, 74);
  // Label only the nodes worth reading at a glance — project papers, significant refs, or the
  // selection. Skipping the long tail of external leaf citations removes hundreds of Text
  // layouts, the single biggest per-node cost when the whole graph is shown.
  // `showLabel` now arrives already decluttered; selection still forces it on.
  const drawLabel = selected || showLabel;

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
          backgroundColor: isProject ? t.elevated : t.surface,
          borderWidth: selected ? 3 : isSignificant ? 2 : 1.3,
          borderColor: selected ? t.amber : isSignificant ? accent : t.line2,
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
      {drawLabel ? (
        // The counter-scale lives on a wrapper, not on the Text: transforms do not affect layout,
        // so the text wraps identically at every zoom and only its drawn size stays constant.
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: r * 2 + 3,
              width: labelWidth,
              left: -(labelWidth - r * 2) / 2,
              transformOrigin: 'top center',
            },
            labelStyle,
          ]}
          pointerEvents="none">
          <Text
            numberOfLines={2}
            variant="caption"
            style={{ textAlign: 'center', fontSize: 10, lineHeight: 12 }}>
            {node.title}
          </Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
});

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  axisX: {
    position: 'absolute',
    bottom: space.sm,
    alignSelf: 'center',
    opacity: 0.85,
  },
  axisY: {
    position: 'absolute',
    top: space.sm,
    left: space.md,
    opacity: 0.85,
  },
  resetBtn: {
    position: 'absolute',
    right: space.md,
    bottom: space.md,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radiusTokens.pill,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
