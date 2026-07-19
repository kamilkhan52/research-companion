import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

// @gorhom/bottom-sheet's production implementation requires its native/Reanimated portal
// context. Component tests care about controlled visibility and rendered actions, so this
// small behavioral mock keeps present()/dismiss() semantics without hiding regressions behind
// an always-rendered container.
export const BottomSheetModalProvider = ({ children }: React.PropsWithChildren) => children;

let deferDismiss = false;
let pendingDismisses: Array<() => void> = [];
let lastModalProps: Record<string, unknown> = {};
export function __setDeferDismiss(value: boolean) {
  deferDismiss = value;
}
export function __flushDismisses() {
  const callbacks = pendingDismisses;
  pendingDismisses = [];
  callbacks.forEach((callback) => callback());
}
export function __getLastModalProps() {
  return lastModalProps;
}

export const BottomSheetModal = forwardRef(function MockBottomSheetModal(
  {
    children,
    onDismiss,
    ...props
  }: React.PropsWithChildren<{ onDismiss?: () => void; [key: string]: unknown }>,
  ref: React.ForwardedRef<{ present: () => void; dismiss: () => void }>,
) {
  lastModalProps = props;
  const [open, setOpen] = useState(false);
  const dismissing = useRef(false);
  useImperativeHandle(ref, () => ({
    present: () => {
      dismissing.current = false;
      setOpen(true);
    },
    dismiss: () => {
      if (dismissing.current) return;
      dismissing.current = true;
      setOpen(false);
      if (onDismiss) {
        const finish = () => {
          dismissing.current = false;
          onDismiss();
        };
        if (deferDismiss) pendingDismisses.push(finish);
        else finish();
      }
    },
  }), [onDismiss]);
  return open ? (
    <View testID="bottom-sheet-modal">
      <Pressable
        accessibilityLabel="Dismiss test bottom sheet"
        onPress={() => {
          setOpen(false);
          onDismiss?.();
        }}
      />
      {children}
    </View>
  ) : null;
});

export const BottomSheetView = View;
export const BottomSheetScrollView = ScrollView;
export const BottomSheetTextInput = TextInput;
export const BottomSheetBackdrop = View;

export default View;
