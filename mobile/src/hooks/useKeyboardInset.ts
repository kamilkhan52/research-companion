import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * The height the keyboard is currently covering, or 0.
 *
 * `KeyboardAvoidingView` is not enough here. Its `behavior` is set on iOS only, and on Android
 * with edge-to-edge the window does not resize, so the bottom of a long ScrollView stays under the
 * keyboard — which is how the Settings screen ended up hiding its own privacy-policy and terms
 * links, and its Save button, exactly while someone was typing a key into it.
 *
 * Add this to the scroll content's `paddingBottom` and the end of the list stays reachable on both
 * platforms. `Will`/`Did` differ deliberately: iOS reports the geometry before the animation so the
 * inset moves with the keyboard, while Android only has the `Did` events.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (event) => {
      setInset(event?.endCoordinates?.height ?? 0);
    });
    const hide = Keyboard.addListener(hideEvent, () => setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return inset;
}
