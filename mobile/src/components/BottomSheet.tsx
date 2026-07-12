// Shared bottom-sheet chrome: Modal + dimmed backdrop + swipe-down-to-dismiss handle, used by
// every bottom-anchored sheet in the app (Related works, Recommended additions, graph node
// detail). Two touch-arbitration lessons are baked in here, confirmed on-device, so no other
// sheet has to relearn them:
//
// 1. The backdrop's tap-to-dismiss layer must sit BEHIND the sheet as a sibling (absolutely
//    positioned), never as an ancestor Pressable wrapping the sheet's content. An ancestor
//    Pressable claims the touch responder and silently blocks a descendant ScrollView's native
//    drag-to-scroll on Android, even though the ScrollView still receives onTouchMove events —
//    it just never turns into an actual scroll. Because the sheet renders after (on top of) the
//    dismiss layer, touches inside the sheet hit the sheet's own views first and never reach it.
// 2. The swipe-to-dismiss gesture is scoped to the handle bar only (a small fixed hit area), not
//    the whole sheet body — so it can never compete with the body's own ScrollView for the touch
//    responder. A Modal on Android portals into a separate native view hierarchy outside the
//    app's single root-level GestureHandlerRootView (app/_layout.tsx), so a GestureDetector here
//    needs its own nested one (RNGH's own documented requirement for gestures inside a Modal).

import { useCallback, useEffect } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { colors, radius, space } from '@/theme/tokens';

const DISMISS_DISTANCE = 120; // px dragged down before a release counts as "dismiss"
const DISMISS_VELOCITY = 800; // px/s downward fling that dismisses regardless of distance
const OFFSCREEN_Y = 700; // slide-out target before handing off to the Modal's own hide

export function BottomSheet({
  visible,
  onClose,
  maxHeightPct = 75,
  style,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  /** Percentage of screen height the sheet is capped at (see each sheet's own maxHeight). */
  maxHeightPct?: number;
  style?: object;
  children: React.ReactNode;
}) {
  const translateY = useSharedValue(0);

  // The component stays mounted across opens (only the Modal's `visible` toggles), so a prior
  // drag's offset must reset before the next open, not carry over.
  useEffect(() => {
    if (visible) translateY.value = 0;
  }, [visible, translateY]);

  // Deliberately does NOT reset translateY here: doing so snaps the sheet back to its normal
  // on-screen position for a frame before the Modal's own `visible`-driven hide animation plays,
  // producing a double slide-down. Leaving it at OFFSCREEN_Y makes that second animation a no-op
  // (already off-screen); the `visible` effect below resets it for the next open instead.
  const finishClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      const shouldDismiss = translateY.value > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY;
      if (shouldDismiss) {
        translateY.value = withTiming(OFFSCREEN_Y, { duration: 180 }, (finished) => {
          if (finished) runOnJS(finishClose)();
        });
      } else {
        translateY.value = withTiming(0);
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {/* box-none: this wrapper spans the full screen (flex:1) and sits on top of the dismiss
           Pressable above in z-order, so without box-none its own empty space would win Android's
           touch hit-test over any tap that isn't on the sheet itself, swallowing backdrop taps
           before they reach the dismiss layer. box-none lets those pass through to it while the
           sheet/handle underneath still receive touches normally. */}
        <GestureHandlerRootView pointerEvents="box-none" style={styles.gestureRoot}>
          <Animated.View style={[styles.sheet, { maxHeight: `${maxHeightPct}%` }, style, animatedStyle]}>
            <GestureDetector gesture={pan}>
              <View style={styles.handleHitArea}>
                <View style={styles.handle} />
              </View>
            </GestureDetector>
            {children}
          </Animated.View>
        </GestureHandlerRootView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  // GestureHandlerRootView is only well-tested as a full-screen flex:1 wrapper (every RNGH
  // example uses it that way); a flexShrink-to-content style here clipped the sheet's bottom
  // edge on-device. flex:1 + justifyContent:'flex-end' fills the backdrop and bottom-anchors
  // the sheet itself, matching what `backdrop` did for it directly before this wrapper existed.
  gestureRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
  },
  // Bigger tap/drag target than the visible pill, pulled up via negative margin so it doesn't
  // push the title down.
  handleHitArea: {
    paddingVertical: 10,
    marginTop: -10,
    marginBottom: -2,
    alignItems: 'center',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line2,
  },
});
