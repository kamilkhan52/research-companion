// Shared bottom-sheet chrome. R9.1 replaces the hand-rolled Modal/handle gesture with
// @gorhom/bottom-sheet's modal: content and handle can both resize the sheet, short content
// opens at its measured height, the explicit maximum is a second snap point, and every sheet
// gets the same pan-down close, backdrop, safe-area and keyboard behavior.

import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  type StyleProp,
  StyleSheet,
  type ViewStyle,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';

export { BottomSheetScrollView };
export { BottomSheetTextInput } from '@gorhom/bottom-sheet';

export function BottomSheet({
  visible,
  onClose,
  maxHeightPct = 75,
  scrollable = false,
  style,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  /** Maximum percentage of the screen the expanded sheet may occupy. */
  maxHeightPct?: number;
  /** Use Gorhom's gesture-aware scroll container for long sheet content. */
  scrollable?: boolean;
  /** Content-container style (not the animated sheet shell). */
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const modalRef = useRef<BottomSheetModal>(null);
  const presentedRef = useRef(false);
  const ownerDismissPendingRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const boundedPct = Math.max(30, Math.min(95, maxHeightPct));
  const snapPoints = useMemo(() => [`${boundedPct}%`], [boundedPct]);
  const maxDynamicContentSize = Math.max(
    1,
    Math.round((height - insets.top) * boundedPct / 100),
  );

  useEffect(() => {
    if (visible && ownerDismissPendingRef.current) {
      // A close animation requested by the controlled owner is still running. onDismiss will
      // see the new desired state and present again; presenting mid-dismiss lets the stale
      // onDismiss callback close the newly opened sheet.
      return;
    }
    if (visible && !presentedRef.current) {
      presentedRef.current = true;
      modalRef.current?.present();
    } else if (!visible && presentedRef.current) {
      ownerDismissPendingRef.current = true;
      modalRef.current?.dismiss();
      // BottomSheetModal internally defers present() by one animation frame. If the owner
      // opens and closes in that same frame, the first dismiss can arrive before the modal has
      // mounted; repeat after its queued present so a stale sheet cannot appear.
      requestAnimationFrame(() => {
        if (!visibleRef.current && ownerDismissPendingRef.current) {
          modalRef.current?.dismiss();
        }
      });
    }
  }, [visible]);

  // A gesture/backdrop dismissal must update the controlled `visible` prop. A parent-driven
  // close already set it false before dismiss(), so avoid firing its callback twice.
  const handleDismiss = useCallback(() => {
    const ownerDismiss = ownerDismissPendingRef.current;
    ownerDismissPendingRef.current = false;
    presentedRef.current = false;
    if (ownerDismiss) {
      // The owner may have reopened while the closing animation was in flight. Honor that
      // latest state only after the stale presentation has fully unmounted.
      if (visibleRef.current) {
        presentedRef.current = true;
        modalRef.current?.present();
      }
      return;
    }
    if (visibleRef.current) onClose();
  }, [onClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={1}
        pressBehavior="close"
        style={[props.style, { backgroundColor: t.scrim }]}
      />
    ),
    [t.scrim],
  );

  const contentStyle = [
    styles.content,
    { paddingBottom: Math.max(space.lg, insets.bottom + space.sm) },
    style,
  ];

  return (
    <BottomSheetModal
      ref={modalRef}
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing
      maxDynamicContentSize={maxDynamicContentSize}
      enablePanDownToClose
      enableContentPanningGesture
      enableHandlePanningGesture
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      enableBlurKeyboardOnGesture
      android_keyboardInputMode="adjustResize"
      topInset={insets.top}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
      handleStyle={styles.handleArea}
      handleIndicatorStyle={styles.handle}
      onDismiss={handleDismiss}
      accessibilityLabel="Bottom sheet"
    >
      {scrollable ? (
        <BottomSheetScrollView
          contentContainerStyle={contentStyle}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={contentStyle}>{children}</BottomSheetView>
      )}
    </BottomSheetModal>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  background: {
    backgroundColor: t.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: t.line,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
  },
  handleArea: { paddingVertical: space.sm },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: t.line2,
  },
});
